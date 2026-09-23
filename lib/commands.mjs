// 待办指令邮件：你从个人邮箱给学生邮箱发信说"哪些做完了 / 要加什么任务 / DDL 改到什么时候"，
// 晚间运行时读出来交给 LLM 解析成操作，自动更新台账。
//
// 安全设计（重要）：
//   · 只接受**白名单发件人** + **主题含标记词**的邮件。否则任何给你发信的人都能改你的台账。
//   · 操作在代码里二次校验：id 必须真实存在、日期必须合法；解析不出来就**什么都不做**并报告。
//   · 已处理过的邮件 id 记下来，重跑不会重复执行（防止补偿重试导致重复新增）。
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";
import { isValidDue, normalizeDue } from "./todos.mjs";
import { removeHandled, addPending, dismiss } from "./pending.mjs";
import { makeTranslator } from "./translate.mjs";
import { parseJsonArrayLoose } from "./json.mjs";
import { readJsonState, writeJsonState } from "./statefile.mjs";

const PROCESSED_FILE = process.env.MAIL_PROCESSED_FILE || path.join(STATE_DIR, "processed-commands.json");

export function loadProcessed() {
  // 这个文件记录"哪些指令邮件已经执行过"。丢了会导致**重复执行用户的历史指令**
  // （比如把已经完成的待办重新打开），所以同样要走备份 + 原子写。
  const { value } = readJsonState(PROCESSED_FILE, { ids: [] });
  return Array.isArray(value?.ids) ? value.ids : [];
}

export function saveProcessed(ids) {
  try {
    // 只留最近 500 条，避免文件无限增长
    writeJsonState(PROCESSED_FILE, { ids: ids.slice(-500) });
  } catch { /* 忽略 */ }
}

const normAddr = (s) => String(s || "").trim().toLowerCase();

/** 这封邮件是不是"待办指令邮件"（白名单发件人 + 主题含标记词） */
export function isCommandMail(m, { from = [], markers = [] } = {}) {
  const addr = normAddr(m?.from?.emailAddress?.address);
  if (!addr || !from.map(normAddr).includes(addr)) return false;
  if (!markers.length) return true;
  const subj = String(m?.subject || "").toLowerCase();
  return markers.some((k) => subj.includes(String(k).toLowerCase()));
}

/** 把模型返回的操作应用到台账（全部经过二次校验） */
export function applyOps(ledger, ops, now = new Date(), { pending = [], watch = [], dismissed = {} } = {}) {
  const applied = [];
  const failed = [];
  let pendingList = pending;

  const findByRef = (ref) => {
    if (!ref) return null;
    const r = String(ref).trim();
    const open = ledger.items.filter((i) => i.status === "open");
    // ⚠️ 只允许**精确**匹配（id / key 前缀 / 标题全等）。
    // 以前还有一条 `title.includes(r)` 的模糊匹配，后果非常严重：
    // 一句"这些都做完了"里的短词就能把一大批待办一次性关掉
    //（2026-09-21 真实事故：5 条待办被一遍指令邮件全标完成，之后两天日报静默跳过发送）。
    // 宁可让模型报"未识别"，也绝不允许程序替用户判断"这事办完了"。
    return open.find((i) => i.key === r)
      || open.find((i) => i.key.startsWith(r))
      || open.find((i) => i.title === r)
      || null;
  };

  const pickDue = (op) => {
    if (isValidDue(op?.due, now)) return op.due;
    return normalizeDue(op?.dueText || op?.due, now);
  };

  // 注意：这里**没有**"顺手把同线程台账事项标完成"的逻辑，而且是故意的。
  // 「待你处理的重要邮件」（邮件清单）和「待办台账」（任务清单）是两回事：
  //   - 回一句"收到/已读"只能销掉**重要提醒**那一半；
  //   - 台账里的任务必须我明确说"做完了"才会销（done 操作）。
  // 之前会把同线程的台账任务一起标完成，等于替用户下了"这事办完了"的判断——已按用户要求去掉。

  for (const op of Array.isArray(ops) ? ops : []) {
    const kind = String(op?.op || "").toLowerCase();
    switch (kind) {
      case "done": {
        const item = findByRef(op.id);
        if (!item) { failed.push({ op: kind, ref: op.id, reason: "找不到对应待办" }); break; }
        item.status = "done";
        item.doneAt = now.toISOString();
        applied.push({ op: "done", title: item.title });
        break;
      }
      case "add": {
        const title = String(op.title || "").trim();
        if (!title) { failed.push({ op: kind, reason: "没有事项名" }); break; }
        const due = pickDue(op);
        if (op.due && !due) failed.push({ op: kind, title, reason: `日期不合法，已忽略日期：${op.due}` });
        ledger.items.push({
          key: `cmd:${now.getTime()}:${Math.random().toString(36).slice(2, 7)}`,
          status: "open",
          num: 1 + ledger.items.reduce((m, i) => Math.max(m, Number.isInteger(i.num) ? i.num : 0), 0),
          firstSeen: now.toISOString(), lastSeen: now.toISOString(),
          title: title.slice(0, 60),
          action: String(op.action || "").slice(0, 120),
          due: due || null,
          dueText: String(op.dueText || due || "").slice(0, 40),
          subject: "(来自待办指令邮件)", source: "邮件指令",
        });
        applied.push({ op: "add", title, due });
        break;
      }
      case "set_due":
      case "update": {
        const item = findByRef(op.id);
        if (!item) { failed.push({ op: kind, ref: op.id, reason: "找不到对应待办" }); break; }
        const due = pickDue(op);
        if (!due) { failed.push({ op: kind, ref: op.id, reason: "日期不合法或缺失，未改动" }); break; }
        const before = item.due || null;
        item.due = due;
        item.dueText = String(op.dueText || due).slice(0, 40);
        item.lastSeen = now.toISOString();
        if (op.title) item.title = String(op.title).slice(0, 60);
        applied.push({ op: "set_due", title: item.title, from: before, to: due });
        break;
      }
      case "delete": {
        const item = findByRef(op.id);
        if (!item) { failed.push({ op: kind, ref: op.id, reason: "找不到对应待办" }); break; }
        item.status = "deleted";
        item.deletedAt = now.toISOString();
        applied.push({ op: "delete", title: item.title });
        break;
      }
      case "handled": {
        // 用户回复"已读 / 收到 / 搞定了 / 不用管了"：把这封**重要邮件**从「待你处理」清单移除。
        // **只动这份邮件清单，绝不碰待办台账**——台账里的任务只有明确说"做完了"（done）才销。
        //
        // all=true：整封回执（正文只有"收到"这种）→ 重要提醒这一半全部销掉。
        const ref = String(op.id || op.ref || op.title || "").trim();
        const all = op.all === true || ref === "*";
        if (all) {
          if (!pendingList.length) { failed.push({ op: kind, reason: "「待你处理」清单本来就是空的" }); break; }
          const removed = [...pendingList];
          pendingList = [];
          dismiss(dismissed, removed, now);              // 记进"已忽略"，避免下次又被加回来
          for (const it of removed) {
            applied.push({ op: "handled", title: String(it.subject || "").slice(0, 60), all: true });
          }
          break;
        }
        if (!ref) { failed.push({ op: kind, reason: "没说清是哪一封" }); break; }
        const { kept, removed } = removeHandled(pendingList, [ref]);
        if (!removed.length) { failed.push({ op: kind, ref, reason: "待处理清单里找不到对应的邮件" }); break; }
        pendingList = kept;
        dismiss(dismissed, removed, now);               // 同上
        for (const it of removed) {
          applied.push({ op: "handled", title: String(it.subject || "").slice(0, 60) });
        }
        break;
      }
      case "promote": {
        // 用户回信说"把这封黄标改成红标 / 这封很重要，以后每天提醒我"：
        // 把今天「值得一看」里的这封**升级**进「待你处理」清单，从此每天带出来，
        // 直到他回信说已读。黄标/灰标本身只活一天，这是唯一的例外入口。
        const ref = String(op.id || op.ref || op.subject || op.title || "").trim();
        if (!ref) { failed.push({ op: kind, reason: "没说清是哪一封" }); break; }
        const list = Array.isArray(watch) ? watch : [];
        const hit = list.find((w) => w.id === ref)
          || list.find((w) => String(w.subject || "") === ref)
          || (ref.length >= 4 ? list.find((w) => String(w.subject || "").toLowerCase().includes(ref.toLowerCase())) : null);
        if (!hit) {
          failed.push({ op: kind, ref, reason: "今天的「值得一看」里找不到这封（只能升级今天日报里出现过的黄标邮件）" });
          break;
        }
        const added = addPending(pendingList, [hit], now);
        applied.push({ op: "promote", title: String(hit.subject || "").slice(0, 60), already: added === 0 });
        break;
      }
      default:
        failed.push({ op: kind || "(空)", reason: "不认识的指令" });
    }
  }
  return { applied, failed, pending: pendingList, dismissed };
}

/**
 * 用户会说「待办3，5，9删除」——这里的 3/5/9 是**日报里显示的序号**。
 * 这件事必须由**代码**确定性地解析，不能交给模型"猜位置"：
 * 2026-09-22 就是因为模型自己猜，把第 3 条删成了另一条。
 *
 * numbered: [{序号,id,title,due}, ...]（由 main-outlook 用 openItems 的顺序生成，
 * 与日报里的编号完全一致）。返回新的 ops 数组，把 seq 换成 id。
 */
export function resolveSeqRefs(ops, numbered = []) {
  return (Array.isArray(ops) ? ops : []).map((op) => {
    const seq = Number(op?.seq ?? op?.序号);
    if (!Number.isInteger(seq) || seq < 1) return op;
    const hit = (numbered || []).find((n) => Number(n.序号) === seq);
    if (!hit) return { ...op, _seqUnknown: seq };          // 序号越界：交给 applyOps 报"未识别"
    const { seq: _drop, 序号: _drop2, ...rest } = op;
    return { ...rest, id: hit.id };
  });
}

/**
 * 外部门户自动加在正文最前面的安全横幅。真实样本（Gmail → PolyU）：
 *   "CAUTION: This email is not originated from PolyU. Do not click links or
 *    open attachments unless you recognize the sender and know the content is safe. 已读"
 * 注意最后：横幅和你写的话**会在同一行**（预览里换行被压成空格），
 * 所以必须只削掉横幅那一段，不能整行丢弃。
 */
const BANNER_PREFIX = [
  /^caution:[\s\S]*?content is safe\.?\s*/i,
  /^caution:[\s\S]*?safe\.?\s*/i,
  /^注意[:：][\s\S]{0,100}?(?:安全|钓鱼|欺诈)[\s\S]{0,30}?\s*/,
];

/** 各家客户端的"引用从这里开始"标记 */
const QUOTE_MARKS = [
  /-{2,}\s*(回复的)?\s*(原始邮件|原邮件|原始郵件)\s*-{2,}/,   // Outlook 网页中文："---- 回复的原邮件 ----"
  /-{2,}\s*Forwarded message\s*-{2,}/i,
  /-{2,}\s*Original Message\s*-{2,}/i,
  /_{10,}/,                                                // 常见分隔线
  /(^|\s)>\s/,                                             // "> 引用"
  /(^|\s)(在|On)\s[\s\S]{0,90}?写道[:：]?\s/,                // 中文回复头
  /(^|\s)On\s[\s\S]{0,90}?\bwrote:\s/i,
  /(^|\s)(发件人|寄件者)\s*[:：]?\s*\S/,                      // 有的客户端连冒号都没有
  /(^|\s)From:\s/,
  /(^|\s)(发送时间|发送日期|Sent)\s*[:：]/,
];

/**
 * 只留下你写的那几句话：削掉门户横幅、从**最早的**引用标记处截断。
 *
 * 为什么不能按行处理：桥接层给的 bodyPreview 里换行已被压成空格，整封是**一行**。
 * （这一点真实踩过：回复「已读」被判成"不是纯回执"，白白多调一次模型。）
 */
export function stripQuoted(text) {
  let s = String(text || "");
  for (const re of BANNER_PREFIX) s = s.replace(re, "");

  let cut = -1;
  for (const re of QUOTE_MARKS) {
    const m = re.exec(s);
    if (m && (cut < 0 || m.index < cut)) cut = m.index;
  }
  if (cut >= 0) s = s.slice(0, cut);

  return s.replace(/(^|\s)>\s?/g, " ").replace(/\s+/g, " ").trim();
}

/** 拼给模型的输入：邮件原文（已去引用） + 当前未完成待办 + 待你处理的重要邮件 */
export function buildCommandPrompt(mail, ledger, pending = [], watch = [], numbered = null) {
  // 必须带上**用户看到的那个序号**（日报里就是按截止日排的），否则用户说"待办3"
  // 模型只能猜位置 —— 2026-09-22 真实删错了一条待办。
  const open = Array.isArray(numbered) && numbered.length
    ? numbered
    : ledger.items.filter((i) => i.status === "open").map((i, idx) => ({ 序号: idx + 1, id: i.key, title: i.title, due: i.due || null }));
  return JSON.stringify({
    邮件主题: String(mail?.subject || "").slice(0, 200),
    邮件正文: stripQuoted(mail?.bodyPreview).replace(/\s+/g, " ").slice(0, 1500),
    当前未完成待办: open.map((i, idx) => ({ 序号: i.序号 ?? idx + 1, id: i.id || i.key, title: i.title, due: i.due || null })),
    待你处理的重要邮件: (pending || []).map((i) => ({ id: i.id, subject: String(i.subject || "").slice(0, 80), 收到: i.receivedDateTime })),
    // 今天日报里"值得一看"那一档（黄标）。用户可以把其中某封升级成重要邮件。
    今日值得一看的邮件: (watch || []).map((i) => ({ id: i.id, subject: String(i.subject || "").slice(0, 80), 发件人: i.from?.emailAddress?.name || i.from?.emailAddress?.address || "" })),
  });
}

/**
 * 这封回信是不是一句**纯回执**（"收到 / 已读 / 搞定了 / OK"）？
 *
 * 为什么用代码判、不交给模型：
 *   1) "收到"这类一句话回执语义极简，模型反而可能过度解读（去把别的待办改了）；
 *   2) 它是最常用的一条路径，不该每次都花一次 API 调用、也不该受网络/缓存影响。
 *
 * 判据故意收得很紧：**整句**都必须是回执词（拆成小块后每一块都在表里），且有长度上限。
 * 所以"收到，但作业1还没做"、"读了，第 3 章看不懂" 都不会被误判成回执。
 */
const ACK_WORDS = new Set([
  "收到", "收到了", "已收到", "收悉", "好的", "好", "行", "可以", "嗯",
  "已读", "读了", "看过了", "看过", "看完", "已阅", "阅", "了解了", "了解",
  "知道", "知道了", "明白", "明白了", "清楚", "清楚了", "没问题",
  "搞定", "搞定了", "完成", "完成了", "处理好", "处理好了", "已处理",
  "谢谢", "多谢", "感谢", "辛苦了", "辛苦", "有劳",
  "ok", "okay", "k", "done", "got", "gotit", "noted", "thanks", "thx", "fine", "yes",
  "👍", "👌", "✅", "🆗", "🙏", "❤",
]);

export function isAckReply(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 40) return false;
  // 按标点/空白/换行切成小块，每块都得是回执词
  const parts = raw
    .replace(/[，,。.!！?？~～、;；:：'"“”‘’()（）\[\]【】\-—_*]/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 4) return false;
  // 允许"都/全/全部/已经/已/我"这类前缀：「都搞定了」「全部收到」「我已经读了」同样是纯回执
  const STRIP = /^(都|全|全部|已经|已|我|这|那|这些|以上)+/;
  return parts.every((p) => {
    const w = p.toLowerCase();
    return ACK_WORDS.has(w) || ACK_WORDS.has(w.replace(STRIP, ""));
  });
}

/**
 * 处理一批指令邮件：纯回执走代码直通，其余交给 LLM 解析 → 代码二次校验后应用。
 * 解析失败**什么都不改**，只报告（宁可不动，也不能乱改你的台账）。
 */
export async function processCommandMails(mails, { ledger, pending = [], watch = [], numbered = [], dismissed = {} }, {
  provider = "auto", target = "zh-CN", log = () => {}, now = new Date(),
} = {}) {
  if (!mails?.length) return { applied: [], failed: [], mails: 0, pending };
  const tr = makeTranslator({ provider, target, log, kind: "command" });
  const applied = [];
  const failed = [];
  let pendingList = pending;

  for (const m of mails) {
    const written = stripQuoted(m?.bodyPreview);
    // 纯回执（"收到 / 已读 / 搞定了"）：不走模型，直接把清单里的重要邮件全部销掉
    if (isAckReply(written)) {
      if (!pendingList.length) {
        log(`待办指令：识别为回执「${written.slice(0, 20)}」，但「待你处理」清单本来就是空的，无事可做`);
        continue;
      }
      const res = applyOps(ledger, [{ op: "handled", all: true }], now, { pending: pendingList, watch, dismissed });
      pendingList = res.pending ?? pendingList;
      applied.push(...res.applied);
      failed.push(...res.failed);
      log(`待办指令：识别为回执「${written.slice(0, 20)}」→ 销掉「待你处理」清单里的 ${res.applied.length} 封（未动用模型）`);
      continue;
    }
    const raw = await tr.ask(buildCommandPrompt(m, ledger, pendingList, watch, numbered));
    const parsed = parseJsonArrayLoose(raw);
    const ops = parsed ? resolveSeqRefs(parsed, numbered) : null;   // 序号 → id（代码认，模型不认）
    if (!ops) {
      const subj = String(m.subject || "").slice(0, 40);
      failed.push({ op: "(解析)", ref: subj, reason: "模型返回无法解析，未做任何改动" });
      log(`待办指令：无法解析「${subj}」，这封不做任何改动`);
      continue;
    }
    const res = applyOps(ledger, ops, now, { pending: pendingList, watch, dismissed });
    pendingList = res.pending ?? pendingList;
    applied.push(...res.applied);
    failed.push(...res.failed);

    // 用户 2026-09-21 明确的语义："**我回复了这封日报 = 我看到了**"，
    // 所以里面列出的红标（待你处理）就该销掉、恢复成普通。
    // 例外：正文里明确说"还没做 / 先留着 / 别销 / 保留"时不动它。
    const subj = String(m?.subject || "");
    const isReplyToDigest = /^\s*(re|回复|答复|fw|fwd|转发)\s*[:：]/i.test(subj) || /邮件日报|待办提醒|📬/.test(subj);
    const keepThem = /还没做|还没弄|没做完|先留|先别销|别销|保留|不要销/i.test(written);
    if (isReplyToDigest && !keepThem && pendingList.length) {
      const auto = applyOps(ledger, [{ op: "handled", all: true }], now, { pending: pendingList, watch });
      pendingList = auto.pending ?? pendingList;
      applied.push(...auto.applied);
      log(`回信视为「我已看到」：销掉 ${auto.applied.length} 条红标（想留着就写"这封还没做"）`);
    }
  }

  tr.flush();
  const st = tr.stats();
  log(`待办指令(${st.provider})：处理 ${mails.length} 封指令邮件，执行 ${applied.length} 项操作，未识别 ${failed.length} 项`);
  return { applied, failed, mails: mails.length, pending: pendingList, dismissed, stats: st };
}
