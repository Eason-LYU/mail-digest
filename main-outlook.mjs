// Outlook COM 版主流程：读收件箱(Outlook) → 生成日报 → 存档 → 用 Outlook 发到 Gmail
//
// 与 main.mjs 的区别：数据源和发送都走经典版 Outlook 的 COM 接口，
// 不依赖 Microsoft Graph，因此不需要学校的应用授权。
//
// 用法:
//   node main-outlook.mjs                      # 正式运行（默认最近 24 小时，发到 DIGEST_TO）
//   node main-outlook.mjs --dry-run            # 真读邮件，只存本地不发信
//   node main-outlook.mjs --check              # 只检查 Outlook 配置与账号状态
//   node main-outlook.mjs --hours 48 --to a@b.com
//   node main-outlook.mjs --fixture fixtures/sample-messages.json --dry-run   # 离线验证渲染
// 退出码: 0 成功 | 2 Outlook 未配置好 | 3 其他失败
import fs from "node:fs";
import path from "node:path";
import { DIGEST_TO, LOG_DIR, MAIN_MAILBOX, OUT_DIR, STATE_DIR, TRANSLATE_PROVIDER, TRANSLATE_TARGET, COMMAND_FROM, COMMAND_MARKERS } from "./lib/config.mjs";
import { runBridge } from "./lib/bridge.mjs";
import { buildDigest, shouldSend } from "./lib/digest.mjs";
import { addTranslations, extractTodos, labelCompact } from "./lib/enrich.mjs";
import { loadLedger, saveLedger, mergeItems, openItems } from "./lib/todos.mjs";
import { restMessages, buildCompactItems } from "./lib/threads.mjs";
import { notifyFailure, clearFailureNotice } from "./lib/notify.mjs";
import { rankMessages } from "./lib/rank.mjs";
import { computeSince, nextWindowStart, shouldRetryEmptyRead } from "./lib/window.mjs";
import { isCommandMail, processCommandMails, loadProcessed, saveProcessed } from "./lib/commands.mjs";
import { readJsonState, writeJsonState } from "./lib/statefile.mjs";
import { loadReported, saveReported, filterUnreported, markReported } from "./lib/reported.mjs";
import { classify, effectiveRank } from "./lib/classify.mjs";
import { loadPendingState, savePending, addPending, prunePending, listPending, toRenderable } from "./lib/pending.mjs";

const DUMP_FILE = path.join(STATE_DIR, "inbox-dump.json");
const INBOX_META = path.join(STATE_DIR, "inbox-meta.json");
const PROBLEM_FILE = path.join(LOG_DIR, "OUTLOOK_PROBLEM.txt");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const FIXTURE = val("--fixture", null);
const DUMP_SOURCE = val("--dump-source", null);
const CHECK_ONLY = has("--check");
const DRY_RUN = has("--dry-run") || has("--no-send") || !!FIXTURE;
// 干跑**绝不写状态**（台账/已处理记录/上次运行时间），否则离线试跑会污染真实数据。
// 测试需要落盘时显式加 --allow-write。
const WRITE_STATE = !DRY_RUN || has("--allow-write");
// --hours 显式给出时优先使用它（便于补跑/演示）；否则用"上次运行到现在"，
// 这也是每天 20:00 的行为：只报上次之后的新邮件。
const HOURS_EXPLICIT = argv.includes("--hours");
const MAX = Number(val("--max", "300"));
const TO = val("--to", DIGEST_TO);
const HOURS = Number(val("--hours", "24"));
const MAX_DAYS = 7;
// 失败提醒弹窗显示秒数（默认 60 秒后自动消失；可用环境变量 MAIL_NOTIFY_SECONDS 调整）
const NOTIFY_SECONDS = Number(process.env.MAIL_NOTIFY_SECONDS || 60);
// 没有截止日的待办保留多少天（默认 15 天，过期自动归档）
const UNDATED_DAYS = Number(val("--undated-days", process.env.MAIL_UNDATED_DAYS || "15"));
// 「待你处理」清单的兜底清理：收到超过这么多天还没被回复销掉的，自动移出
const PENDING_DAYS = Number(val("--pending-days", process.env.MAIL_PENDING_DAYS || "30"));
// 哪些分档的邮件要进「待你处理」清单（默认只保留"需要你行动"的；想连"值得一看"也保留就设 action,watch）
const PENDING_BUCKETS = (val("--pending-buckets", process.env.MAIL_PENDING_BUCKETS || "action") || "action").split(",").map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, "run.log");
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + "\n", "utf8"); } catch { /* 忽略 */ }
}

const stateFile = path.join(STATE_DIR, "last-run.json");
// 这个文件记着"上次读到哪封邮件"（窗口起点）。它要是被写坏，程序会当成第一次运行、
// 把窗口拉宽重读一遍——所以同样用"备份 + 原子写"，别让它有半截状态。
const readState = () => readJsonState(stateFile, {}).value || {};
const writeState = (o) => writeJsonState(stateFile, o, { keep: 5 });
const hkDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
}).format(d);

function clearProblem() { try { fs.unlinkSync(PROBLEM_FILE); } catch { /* 没有就算了 */ } }
function markProblem(reason) {
  fs.writeFileSync(PROBLEM_FILE,
    `Outlook 通道出问题。\n时间: ${new Date().toISOString()}\n原因: ${reason}\n` +
    `处理: 打开经典版 Outlook 确认能正常收发邮件，然后运行  node main-outlook.mjs --check\n`, "utf8");
}

/** 调 PowerShell 桥接（见 lib/bridge.mjs）。用 stdio:inherit + 文件交换数据，避免沙箱禁止的管道捕获。 */

async function main() {
  const now = new Date();
  let messages = [];
  let since;
  let source;
  let newestSeenMailAt = null;      // 本次真正读到的最新邮件时间（窗口推进依据）
  let windowLabel = null;           // 日报里显示的窗口起点（标准化后的 20:00，见 lib/window.mjs）

  if (CHECK_ONLY) {
    log("仅检查 Outlook 通道…");
    // 把配置的主邮箱一并带上：这样 -Check 打出的 TARGET 行就是"真正会用的读/发账户"，
    // 而不是永远显示 (default)（MAIN_MAILBOX 为空时等于没传，行为与以前一致）。
    if (MAIN_MAILBOX) log(`配置的主邮箱: ${MAIN_MAILBOX}（MAIL_MAIN）`);
    const st = runBridge(["-Check"], { account: MAIN_MAILBOX, from: MAIN_MAILBOX });
    if (st === 0) { log("Outlook 通道检查通过。"); clearProblem(); return; }
    markProblem(`--check 退出码 ${st}`);
    log(`Outlook 通道检查失败（退出码 ${st}），已写 ${PROBLEM_FILE}`);
    process.exit(2);
  }

  if (FIXTURE) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(FIXTURE), "utf8"));
    messages = Array.isArray(raw) ? raw : raw.value || [];
    since = new Date(now.getTime() - HOURS * 3600 * 1000);
    source = "fixture";
    log(`[fixture 模式] 载入样例邮件 ${messages.length} 封，不访问 Outlook、不发信。`);
  } else if (DUMP_SOURCE) {
    // 离线模式：用之前缓存下来的邮件 dump 重新生成日报，不碰 Outlook（便于调规则/看效果）
    const raw = JSON.parse(fs.readFileSync(path.resolve(DUMP_SOURCE), "utf8"));
    messages = Array.isArray(raw) ? raw : raw.value || [];
    const st = readState();
    const w = computeSince({
      windowStart: st.windowStart, lastSeenMailAt: st.lastSeenMailAt, lastRunAt: st.lastRunAt,
      hours: HOURS, floorDays: MAX_DAYS, explicitHours: HOURS_EXPLICIT, now,
    });
    since = w.since;
    windowLabel = w.labelStart;
    source = "dump";
    log(`[离线模式] 从缓存 dump 读取 ${messages.length} 封邮件：${path.resolve(DUMP_SOURCE)}`);
    log(`统计窗口起点 ${since.toISOString()} —— ${w.why}` + (w.standard && since.getTime() !== w.standard.getTime() ? `（标准窗口起点是 ${w.standard.toISOString()}）` : ""));
  } else {
    const st = readState();
    const w = computeSince({
      windowStart: st.windowStart, lastSeenMailAt: st.lastSeenMailAt, lastRunAt: st.lastRunAt,
      hours: HOURS, floorDays: MAX_DAYS, explicitHours: HOURS_EXPLICIT, now,
    });
    since = w.since;
    windowLabel = w.labelStart;
    log(`统计窗口起点 ${since.toISOString()} —— ${w.why}` + (w.standard && since.getTime() !== w.standard.getTime() ? `（标准窗口起点是 ${w.standard.toISOString()}）` : ""));
    const hours = Math.min(MAX_DAYS * 24, Math.max(1, (now - since) / 3600000));
    source = "outlook";
    log(`通过 Outlook COM 读取收件箱：最近 ${hours.toFixed(1)} 小时（起点 ${since.toISOString()}）`);
    // 主邮箱（MAIL_MAIN）非空才传 -Account：读的是那个账户自己的存储；
    // 为空则不传，桥接照旧读 Outlook 默认存储的收件箱。
    if (MAIN_MAILBOX) log(`读取邮箱: ${MAIN_MAILBOX}`);

    const st2 = runBridge(["-Dump", DUMP_FILE, "-Hours", String(hours), "-Max", String(MAX)],
      { account: MAIN_MAILBOX });
    if (st2 !== 0) {
      const msg = `Outlook 读取失败（桥接退出码 ${st2}）`;
      markProblem(msg);
      log(`${msg}，已写 ${PROBLEM_FILE}`);
      if (!DRY_RUN) {
        notifyFailure({
          reason: msg,
          hint: "打开经典版 Outlook，确认能正常收发邮件；然后双击 检查Outlook通道.cmd 看具体报错",
          context: { "详细日志": "logs\\task.log" },
          seconds: NOTIFY_SECONDS,
          log,
        });
      }
      process.exit(2);
    }
    const readDump = () => {
      const d = JSON.parse(fs.readFileSync(DUMP_FILE, "utf8"));
      return Array.isArray(d) ? d : d.value || [];
    };
    messages = readDump();
    log(`取到 ${messages.length} 封邮件`);

    // 收件箱看起来"陈旧"（见到的最新邮件没超过已覆盖点，或落后现在太久）：
    // 说明 Outlook 本地缓存还没同步完 —— 2026-09-23 13:25 就是这样：缓存停在
    // 前一天 20:53，当天一整天的邮件都还没进来，日报却报"0 封新邮件"。
    // 不再干等 60 秒碰运气：**主动触发一次发送/接收并等它同步完**，然后重扫。
    const meta0 = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, "inbox-meta.json"), "utf8")); } catch { return {}; } })();
    let staleNotice = null;
    const staleArgs = (m) => ({
      count: messages.length, newestSeenMailAt: m?.newestSeen, since,
      coveragePoint: readState().windowStart, now: new Date().toISOString(),
      maxLagHours: Number(process.env.MAIL_STALE_HOURS || 6),
    });
    if (shouldRetryEmptyRead(staleArgs(meta0))) {
      log(`⚠️ 收件箱看起来没同步完（最新邮件：${meta0?.newestSeen || "无"}）—— 强制收信后再读一次`);
      // MAIL_SYNC=0：不用强制收信（怕它顺手把 Outbox 里排队的信发出去），退回"干等 60 秒再读"
      // --dry-run（空跑）绝不碰发件箱，也不白等 60 秒，直接重读一次缓存。
      if (DRY_RUN) {
        log("（空跑模式：不触发发送/接收，直接重读一次缓存）");
      } else if (String(process.env.MAIL_SYNC ?? "1") !== "0") {
        runBridge(["-Sync"]);
      } else {
        log("（MAIL_SYNC=0：只等待 60 秒后重读，不触发发送/接收）");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
      }
      runBridge(["-Dump", DUMP_FILE, "-Hours", String(hours), "-Max", String(MAX)]);
      messages = readDump();
      const meta1 = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, "inbox-meta.json"), "utf8")); } catch { return {}; } })();
      log(`重读完成：这次取到 ${messages.length} 封邮件（最新：${meta1?.newestSeen || "无"}）`);
      // 同步后还是陈旧 → 日报里必须写明，不能假装"今天没有新邮件"
      if (shouldRetryEmptyRead(staleArgs(meta1))) {
        const lag = meta1?.newestSeen ? Math.round((Date.now() - Date.parse(meta1.newestSeen)) / 3600000) : null;
        staleNotice = lag === null
          ? "Outlook 没给出收件箱最新邮件的时间，这份日报可能不完整。"
          : `Outlook 本地缓存可能还没同步完：收件箱里最新邮件是 ${String(meta1.newestSeen).slice(0, 16).replace("T", " ")} UTC（约 ${lag} 小时前）。这份日报可能不完整 —— 确认 Outlook 联网后可以重跑一次。`;
        log(`⚠️ ${staleNotice}`);
      }
    }

    // 读桥接层写的元数据：newestSeen 是"本次真正读到的最新邮件时间"，
    // 决定下一次的窗口起点——读到才算推进，读不到就保持不变（避免缓存没同步完而漏邮件）。
    try {
      const meta = JSON.parse(fs.readFileSync(INBOX_META, "utf8"));
      newestSeenMailAt = meta?.newestSeen || null;
      log(`收件箱扫描：本次看了 ${meta?.scanned} 封 / 共 ${meta?.total} 封；见到的最新邮件：${newestSeenMailAt || "(无)"}`);
      if (!newestSeenMailAt) {
        log("注意：本次没读到任何窗口内的邮件。窗口起点将保持不变，下次会重新覆盖这段区间（不会漏邮件）。");
      }
    } catch (e) {
      log(`读取收件箱元数据失败（不影响日报）：${e.message}`);
    }
    // 兜底：元数据缺失但确实读到了邮件 → 用读到的最新那封作为推进依据，
    // 避免"窗口永不推进 → 每次重复报同一批邮件"。
    if (!newestSeenMailAt && messages.length) {
      newestSeenMailAt = messages.reduce(
        (acc, m) => (!acc || new Date(m.receivedDateTime) > new Date(acc) ? m.receivedDateTime : acc), null);
      log(`元数据缺失，改用本次读到的最新邮件时间：${newestSeenMailAt}`);
    }

    // 「待你处理的重要邮件」不靠"已读"判断（用户根本不用标已读），
    // 而是靠一份跨天清单：判为 action 的邮件进清单，只有**回信说"收到/已读/搞定了"**才销掉。
  // 注意：这份"邮件清单"和下面的"待办台账"是两份东西——回执只销邮件，不动任务。
    // （这一段的实际逻辑在下面分档之后执行；这里不再取未读 dump。）
  }

  // 分出"待办指令邮件"：这类邮件是**给你的指令**，不参与正常分档/翻译/日报正文，
  // 只用来更新台账（白名单发件人 + 主题含标记词，两道闸）。
  let commandMails = [];  if (messages.length) {
    commandMails = messages.filter((m) => isCommandMail(m, { from: COMMAND_FROM, markers: COMMAND_MARKERS }));
    if (commandMails.length) {
      const ids = new Set(commandMails.map((m) => m.id));
      messages = messages.filter((m) => !ids.has(m.id));
      log(`识别到 ${commandMails.length} 封待办指令邮件（不进入日报正文，只用于更新台账）`);
    }
  }

  log(`日报收件人: ${TO}${DRY_RUN ? "（dry-run，不会真的发送）" : ""}`);

  // 标准化窗口带来的重叠（今天手动跑过 / 上次跑得晚）→ 靠"已报告名单"过滤，不重复刷屏。
  // 显式 --hours（例如"发送测试日报.cmd"）是手动想看某一段，不做去重；--no-dedupe 可强制关闭。
  const reported = loadReported(now);
  // 去重只在"准点那次"生效（用户 2026-09-21 要求：手动跑要看到当天全部邮件，黄标灰标都在）。
  // 判定：本次运行时刻与配置的每日运行时刻相差 ≤15 分钟 → 认为是准点那次。
  const DAILY_HOUR = Number(process.env.MAIL_DAILY_HOUR || 20);
  const hkParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", hour12: false }).format(now).split(":");
  const hkMinutes = Number(hkParts[0]) * 60 + Number(hkParts[1]);
  const gap = Math.min(Math.abs(hkMinutes - DAILY_HOUR * 60), 1440 - Math.abs(hkMinutes - DAILY_HOUR * 60));
  const NEAR_SCHEDULED = gap <= 15;
  const DEDUPE = NEAR_SCHEDULED && !HOURS_EXPLICIT && !has("--no-dedupe") && !FIXTURE;
  if (!NEAR_SCHEDULED) log("手动运行（不在准点时间）：不去重，会把当天的邮件完整列出来");
  // ⚠️ 这里**先别过滤**：分档必须看"窗口里的全部邮件"。
  // 因为用户可能回信说"把那封黄标改成红标"，而那封往往是上一次已经报过的——
  // 先从窗口里剔掉的话，模型就对不上号了（2026-09-21 真实踩到）。
  // 报告用的"已报过就跳过"挪到分档之后（见下）。
  const windowMails = messages.slice();

  // 台账 + 「待你处理」清单都要读出来：**哪怕今天没有新邮件**，也要把未完成/未处理的带出来
  let todoSection = null;
  const previousRun = readState().lastRunAt || null;
  const ledger = loadLedger();
  // 台账读不出来（文件被删/被写坏/被杀在半路）必须**大声报**，绝不能当成"新用户从零开始"——
  // 那样下一次保存就把空台账覆盖上去了，真数据就此消失（2026-09-21 真实踩过一次）。
  if (ledger._loadError) {
    log(`⚠️ 待办台账读取异常：${ledger._loadError}`);
    log("⚠️ 本次不会覆盖台账文件；原文已留在 .state\\backups\\，可用「恢复台账.cmd」还原。");
  }
  // 「待你处理」清单也要检查读取错误：读坏了就报警并**跳过保存**，
  // 免得拿一份空清单覆盖掉真实数据（台账那边踩过这个坑）。
  const pendingState = loadPendingState();
  let pendingList = pendingState.items;
  let dismissedList = pendingState.dismissed || {};      // 已忽略的邮件（销过的红标不再回来）
  const PENDING_LOAD_ERROR = pendingState.error;
  if (PENDING_LOAD_ERROR) log(`⚠️ 「待你处理」清单读取异常：${PENDING_LOAD_ERROR}`);
  let ledAdded = 0;
  let ledUpdated = 0;

  // 翻译（默认 auto：有 DeepSeek key 就用它；--no-translate 可关掉）
  const PROVIDER = val("--translate", TRANSLATE_PROVIDER);
  const TRANSLATE = !has("--no-translate") && PROVIDER !== "none";
  // 分档方式：llm（默认，把重要性判断交给模型）| rules（只用本地规则）
  const RANKING = (val("--ranking", "llm") || "llm").toLowerCase();

  // 待办指令邮件的处理被挪到**分档 + 带出「待你处理」清单之后**（见下面），原因有两个：
  //   1) 用户可能回信说"把这封黄标改成红标"，那需要先知道今天哪些邮件是黄标；
  //   2) 顺序反过来的话，用户当天回"收到"销掉清单后，本次运行又会把今天的红标邮件重新加回去。
  if (TRANSLATE && messages.length) {
    // 1) 先分档（把"哪封重要"交给 LLM；失败/未命中会自动退回本地规则）
    if (RANKING === "llm") {
      try {
        await rankMessages(messages, { provider: PROVIDER, target: TRANSLATE_TARGET, log });
      } catch (e) {
        log(`分档环节出错，全部退回本地规则：${e.message}`);
      }
    } else {
      log("分档：按你的设置使用本地规则（--ranking rules）。");
    }
  }

  // 分档之后再过滤"已经报过的"：报告不重复，但"今天值得一看"的清单仍然是完整的
  if (DEDUPE && messages.length) {
    const { kept, skipped } = filterUnreported(messages, reported);
    if (skipped) log(`已报告过的邮件跳过 ${skipped} 封（标准窗口与上次重叠，不重复报）`);
    messages = kept;
  }

  // 把今天判为「需要你行动」的邮件记入「待你处理」清单；再把清单里的邮件带出来。
  // 注意：这段**不能**放在 `messages.length` 里面 —— 今天没有新邮件的日子，
  // 「待你处理」的邮件恰恰最需要出现（这正是"重要邮件一直保留"的核心）。
  if (!has("--no-carry-over")) {
      const actionMails = messages.filter((m) => !m.carryOver && PENDING_BUCKETS.includes(effectiveRank(m).bucket) && !dismissedList[m.id]);
      if (WRITE_STATE) {
        const added = addPending(pendingList, actionMails, now);
        pendingList = prunePending(pendingList, now, PENDING_DAYS);
        if (PENDING_LOAD_ERROR) log("「待你处理」清单读取异常，本次跳过保存（避免覆盖真数据）。");
        else savePending(pendingList, dismissedList);
        if (added) log(`「待你处理」清单：新增 ${added} 封，现在共 ${pendingList.length} 封`);
      }
      const inWindow = new Set(messages.map((m) => m.id));
      const carried = listPending(pendingList, now)
        .filter((i) => !inWindow.has(i.id))
        .map((i) => toRenderable(i));
      if (carried.length) {
        messages = [...messages, ...carried];
        log(`带出 ${carried.length} 封「待你处理」的邮件（回信写「收到/已读/搞定了」就会销掉；台账里的任务不受影响）`);
      } else {
        log("「待你处理」清单是空的。");
      }
    }

  // 处理待办指令邮件（幂等：已处理过的 id 跳过，重跑不会重复执行）
  let commandSection = null;
  if (commandMails.length && !has("--no-command-mails")) {
    const processed = loadProcessed();
    const fresh = commandMails.filter((m) => m.id && !processed.includes(m.id));
    if (!fresh.length) {
      log(`待办指令：${commandMails.length} 封此前已处理过，跳过（幂等保护）`);
    } else {
      // 今天日报里"值得一看"那一档：用户可以回信把其中某封升级成红标
      // 用 windowMails（窗口里的全部邮件）而不是 messages（已过滤）：
      // 用户想升级的那封很可能就是上一次报过的
      const todaysWatch = windowMails.filter((m) => !m.carryOver && effectiveRank(m).bucket === "watch");
      // 与日报里完全一致的编号（按截止日升序、无期限的排后面）——用户会按这个号下指令
      // 编号就是**当天的位次**（1..n）。用户回复的是最近那封日报，
      // 所以真正要对上的是"他回复的那封里的编号" —— 靠解析回信里引用的原文来对齐（见 parseQuotedNumbers）。
      const numbered = openItems(ledger, now, { limit: 200 }).shown.map((t, i) => ({ 序号: i + 1, id: t.key, title: t.title, due: t.due || null }));
      try {
        const res = await processCommandMails(fresh, { ledger, pending: pendingList, watch: todaysWatch, numbered }, {
          provider: PROVIDER, target: TRANSLATE_TARGET, log, now,
        });
        pendingList = res.pending ?? pendingList;
        dismissedList = res.dismissed ?? dismissedList;
        if (WRITE_STATE) { saveProcessed([...processed, ...fresh.map((m) => m.id)]); if (!PENDING_LOAD_ERROR) savePending(pendingList, dismissedList); }
        else log("dry-run：不记录「已处理的指令邮件」，也不写台账/清单。");
        commandSection = { mails: fresh.length, applied: res.applied, failed: res.failed };
        if (todaysWatch.length) log(`待办指令：今天有 ${todaysWatch.length} 封「值得一看」可被升级为红标（回信说"这封改成红标"即可）`);
      } catch (e) {
        log(`待办指令处理出错（不影响日报）：${e.message}`);
      }
    }
  }

  if (TRANSLATE && messages.length) {
    // 2) 翻译（按分档结果挑 action / watch 两档）
    try {
      await addTranslations(messages, { provider: PROVIDER, target: TRANSLATE_TARGET, log });
    } catch (e) {
      log(`翻译环节出错，已跳过（不影响日报）：${e.message}`);
    }
    // 3) 待办提取：一次调用同时产出「👉 要做什么」和台账事项（需要 DeepSeek 这类 LLM）
    if (!has("--no-action-summary")) {
      try {
        const res = await extractTodos(messages.filter((m) => !m.carryOver), {
          provider: PROVIDER,
          target: TRANSLATE_TARGET,
          log,
          buckets: (val("--todo-buckets", "action") || "action").split(",").map((s) => s.trim()).filter(Boolean),
          now,
        });
        const m = mergeItems(ledger, res.items, now);
        ledAdded = m.added;
        ledUpdated = m.updated;
      } catch (e) {
        log(`待办提取环节出错，已跳过（不影响日报）：${e.message}`);
      }
    }
  } else if (!TRANSLATE) {
    log("翻译：已关闭。");
  } else {
    log("今天没有新邮件：跳过翻译与待办提取，但仍会带出未完成的待办。");
  }

  // 不管今天有没有新邮件，都算一次要展示的待办列表
  {
    const { shown, total, hidden } = openItems(ledger, now, { undatedMaxAgeDays: UNDATED_DAYS });
    if (WRITE_STATE && !ledger._loadError) saveLedger(ledger);
    else if (ledger._loadError) log("台账文件读取异常，本次跳过保存（避免用一份不完整的台账覆盖真数据）。");
    else log("dry-run：不写入台账（上面的台账变化只是预览，真实台账未被改动）。");
    todoSection = { shown, total, hidden, added: ledAdded, updated: ledUpdated };
    log(`待办台账：新增 ${ledAdded}，更新 ${ledUpdated}，未完成合计 ${total} 条（本次列出 ${shown.length}${hidden ? `，另有 ${hidden} 条` : ""}）`);
  }

  // 其余邮件：线程归并（纯确定性）+ 一次批量生成中文标签（需要 LLM）
  let compactSection = null;
  if (messages.length) {
    try {
      const parts = restMessages(messages, 12);
      if (parts.rest.length) {
        compactSection = buildCompactItems(parts.rest, { limit: 40 });
        if (TRANSLATE && !has("--no-compact-labels")) {
          await labelCompact(compactSection, { provider: PROVIDER, target: TRANSLATE_TARGET, log });
        }
        log(`其余邮件：${parts.rest.length} 封 → 归并成 ${compactSection.totalItems} 条（其中成组 ${compactSection.groupItems} 组）`);
      }
    } catch (e) {
      log(`清单归并环节出错，已跳过（不影响日报）：${e.message}`);
    }
  }

  const digest = buildDigest(messages, {
    since: (windowLabel || since).toISOString(), until: now.toISOString(), archiveName: `${hkDate()}-digest.md`,
    todos: todoSection,
    compact: compactSection,
    previousRun,
    commands: commandSection,
    staleNotice,
  });
  const mdPath = path.join(OUT_DIR, `${hkDate()}-digest.md`);
  const htmlPath = path.join(OUT_DIR, `${hkDate()}-digest.html`);
  fs.writeFileSync(mdPath, digest.markdown, "utf8");
  fs.writeFileSync(htmlPath, digest.html, "utf8");
  log(`本地存档: ${mdPath}`);
  log(`本地存档: ${htmlPath}`);
  log(`主题: ${digest.subject}`);
  log(`统计: ${JSON.stringify(digest.stats)}`);

  // 默认**每天都发**：哪怕没有新邮件、台账也空了，也发一封极短的说明。
  // 为什么改成默认发：2026-09-21 两次运行因为"台账空 + 无新邮件"静默跳过，
  // 用户什么都没收到、完全不知道出了事。宁可多一封说明，也不要静默。
  // 想恢复"安静"行为：--no-send-empty
  const SEND_EMPTY = !has("--no-send-empty");
  const pendingTodos = todoSection?.total || 0;
  if (DRY_RUN) {
    log(FIXTURE ? "dry-run：跳过发送。" : "dry-run：已跳过发送，仅本地存档。");
  } else if (!shouldSend({ totalMails: digest.stats.total, pendingTodos, force: SEND_EMPTY })) {
    // 只有"没有新邮件 且 台账也没有未完成事项"才不发——否则纯粹是噪音
    log("没有新邮件、台账里也没有未完成事项，跳过发送（默认会发，这里是被 --no-send-empty 关掉了）。");
  } else {
    if (digest.stats.total === 0 && pendingTodos) {
      log(`今天没有新邮件，但台账里还有 ${pendingTodos} 项未完成 —— 照常发送待办提醒。`);
    }
    if (DEDUPE) { markReported(reported, messages, now); saveReported(reported, now); }
    // 主邮箱非空才传 -From：用那个账户发；为空则不传，交给 Outlook 默认发件账户。
    if (MAIN_MAILBOX) log(`发件账户: ${MAIN_MAILBOX}`);
    const st = runBridge(["-Send", "-To", TO, "-Subject", digest.subject, "-HtmlFile", htmlPath],
      { from: MAIN_MAILBOX });
    if (st !== 0) {
      log(`发送失败（桥接退出码 ${st}）`);
      markProblem(`发送失败，桥接退出码 ${st}`);
      notifyFailure({
        reason: `通过 Outlook 发送日报失败（桥接退出码 ${st}）`,
        hint: "日报已生成在 digests 目录，可手动转发；同时确认经典版 Outlook 能正常发信",
        context: { "本地存档": htmlPath, "详细日志": "logs\\task.log" },
        seconds: NOTIFY_SECONDS,
        log,
      });
      process.exit(3);
    }
    log(`已通过 Outlook 发送日报到 ${TO} | 主题: ${digest.subject}`);
  }

  if (DRY_RUN) {
    log("dry-run：不更新运行状态（避免正式运行时漏掉这段邮件）。");
  } else {
    const prev = readState();
    const nextStart = nextWindowStart({ since, newestSeenMailAt });
    log(`下次窗口起点 ${nextStart} —— ${newestSeenMailAt ? "按本次读到的最新邮件推进" : "本次未读到邮件，保持原起点（避免漏邮件）"}`);
    writeState({
      lastRunAt: now.toISOString(),
      windowStart: nextStart,
      lastSeenMailAt: newestSeenMailAt || prev.lastSeenMailAt || null,
      lastStats: digest.stats,
      source,
      archived: [path.basename(mdPath), path.basename(htmlPath)],
    });
    clearProblem();
    clearFailureNotice({ log });          // 成功了就清掉桌面上的旧失败提醒
  }
  log("完成。");
}

main().catch((err) => {
  const msg = String(err?.message || err);
  log(`失败: ${msg}`);
  markProblem(msg);
  if (!DRY_RUN) {
    notifyFailure({
      reason: msg,
      hint: "把 logs\\task.log 或 logs\\run.log 发给助手排查",
      context: { "详细日志": "logs\\task.log" },
      seconds: NOTIFY_SECONDS,
      log,
    });
  }
  process.exit(3);
});
