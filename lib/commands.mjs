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

// ---------- 邮件来自哪个文件夹：日报只列收件箱，指令识别要看全部 ----------
//
// 背景（真实事故）：用户从手机回信下指令，PolyU(Exchange) 的规则会把这类**外部来信**
// 分到「重要」文件夹里，不在收件箱 —— 只读收件箱的桥接层于是"扫到 0 封"，
// 指令邮件永远执行不了。修法：桥接层把「重要/垃圾邮件」里窗口内的邮件也追加进同一个
// dump，并给每封邮件带上 folder 字段（收件箱的写「收件箱」），由 Node 侧分开使用：
//   · 识别指令邮件 → 用**全部**邮件（否则又会漏掉「重要」里的指令）
//   · 日报正文/分档/统计 → 只用收件箱（否则垃圾邮件会刷屏）
export const INBOX_FOLDER = "收件箱";

/**
 * 这封邮件是不是收件箱里的（日报正文只列收件箱的邮件）。
 * 没有 folder 字段 = 旧版桥接层导出的 dump（那时只导收件箱）→ 按收件箱处理，向后兼容。
 * 空串/只有空格同样当成"没写"：宁可多列一封收件箱的邮件，也绝不因为一个空字段把邮件弄丢。
 */
export function isInboxMail(m) {
  const f = String(m?.folder ?? "").trim();
  return !f || f === INBOX_FOLDER;
}

/** 把一批邮件拆成「收件箱」和「附加文件夹」两部分（附加的那部分只用于识别指令邮件） */
export function splitByFolder(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return { inbox: list.filter(isInboxMail), extra: list.filter((m) => !isInboxMail(m)) };
}

/**
 * 挑出这批邮件里的指令邮件。
 * ⚠️ 传进来的必须是**全部**邮件（收件箱 + 附加文件夹）：规则可能把指令邮件分到「重要」里，
 * 只看收件箱就会像事故那样一封都认不出来（见上面 isInboxMail 的注释）。
 * 安全闸一点没放宽：仍然是 isCommandMail 的两道闸（白名单发件人 + 主题含标记词）。
 */
export function pickCommandMails(messages, opts) {
  return (Array.isArray(messages) ? messages : []).filter((m) => isCommandMail(m, opts));
}

/** 把模型返回的操作应用到台账（全部经过二次校验） */
export function applyOps(ledger, ops, now = new Date(), { pending = [], watch = [], dismissed = {}, text = "", subject = "" } = {}) {
  const applied = [];
  const failed = [];
  let pendingList = pending;

  // 「加一个」和「改期」是两件事，必须按**我的说法**分，不能按日期分。
  // 2026-09-23 真实事故：邮件里是 AMA 期中考试通知（11/1），我在回信里说"加一个"，
  // 模型输出 set_due，代码照做 —— 结果新任务没进来，已有任务 "AMA as1" 的
  // 10/23 被直接改成 11/1（旧日期就此丢失）。
  // 规则：只要我说的是"加/新增"，且一个字都没提"改期/推迟"，就绝不允许覆盖已有任务的日期。
  const ADD_CUE = /加一[个条下]|加个|新增|添加|补充|再加|记一[个下]|加进|并入|顺手加/;
  const DUE_CUE = /改期|推迟|延后|延期|改到|改成|换到|换成|提前|挪到|拖到|顺延|截止(日期|时间)?改/;
  const srcText = `${subject || ""} ${text || ""}`;
  const addIntent = ADD_CUE.test(srcText) && !DUE_CUE.test(srcText);

  const addItem = (title, due, op) => {
    const t = String(title || "").trim().slice(0, 60);
    if (!t) return null;
    const item = {
      key: `cmd:${now.getTime()}:${Math.random().toString(36).slice(2, 7)}`,
      status: "open",
      num: 1 + ledger.items.reduce((m, i) => Math.max(m, Number.isInteger(i.num) ? i.num : 0), 0),
      firstSeen: now.toISOString(), lastSeen: now.toISOString(),
      title: t,
      action: String(op?.action || "").slice(0, 120),
      due: due || null,
      dueText: String(op?.dueText || due || "").slice(0, 40),
      subject: "(来自待办指令邮件)", source: "邮件指令",
    };
    ledger.items.push(item);
    return item;
  };

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
    // 序号对不上（引文里没有这个编号，或它已经不在未完成清单里）：**什么都不动**，只报出来。
    if (op?._seqUnknown) {
      failed.push({ op: kind || "(空)", ref: `序号 ${op._seqUnknown}`, reason: op._seqWhy || "序号对不上任何未完成待办，未做改动" });
      continue;
    }
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
        addItem(title, due, op);
        applied.push({ op: "add", title, due });
        break;
      }
      case "set_due":
      case "update": {
        const item = findByRef(op.id);
        // 我说的是"加一个"，模型却给了 set_due：**新增一条**，绝不覆盖已有任务的日期。
        if (addIntent) {
          const fallback = String(subject || "").replace(/^\s*(re|回复|答复|fw|fwd|转发)\s*[:：]\s*/i, "").trim();
          const due = pickDue(op);
          const created = addItem(String(op.title || "").trim() || fallback, due, op);
          if (!created) { failed.push({ op: kind, ref: op.id, reason: "说的是新增，但没给出新事项名，未改动" }); break; }
          applied.push({ op: "add", title: created.title, due: due || null, becauseAddIntent: true, untouched: item?.title || null });
          break;
        }
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
/**
 * 引文从哪里开始（找不到返回 -1）。各家客户端的引用标记见 QUOTE_MARKS。
 * **只在引文里**找编号：用户自己写的正文里也可能出现 "[1]" 这种写法，
 * 不能拿它当"那封日报的编号"。
 */
export function quoteStart(text) {
  const s = String(text || "");
  let cut = -1;
  for (const re of QUOTE_MARKS) {
    const m = re.exec(s);
    if (m && (cut < 0 || m.index < cut)) cut = m.index;
  }
  return cut;
}

/**
 * 从回信引用的原文里，把"那封日报"的编号→标题抽出来。
 * 用户回复的一定是最近那封日报，而**序号是那封日报里的位次**：
 *   **[3]** **10/1（还有 9 天）** · 陪朋友出去玩
 * 所以照着引文对齐，才不会因为"中间又新增/完成了别的待办"而指错。
 *
 * ⚠️ 绝不按行解析：桥接层给的 bodyPreview 里换行已被压成空格，**整封就是一行**
 *（README 排障备忘里专门记过这个坑："按行判断等于没生效"）。
 * 2026-10-08 就是因此出的事：按行写时整段引文只匹配出 1 号一条、且标题把后面全吞了，
 * 于是"删去待办1、2、3"删错了三条。改成在整段引文里全局扫 [n]，取到下一个 [n] 为止。
 */
export function parseQuotedNumbers(text) {
  const s = String(text || "");
  const cut = quoteStart(s);
  if (cut < 0) return {};                       // 不是回信 → 没有"引文编号"这回事
  const out = {};
  const re = /\[(\d+)\]\s*([\s\S]*?)(?=\[\d+\]|$)/g;
  let m;
  while ((m = re.exec(s.slice(cut)))) {
    const n = Number(m[1]);
    const frag = m[2].replace(/\s+/g, " ").trim();
    if (frag && !(n in out)) out[n] = frag;
  }
  return out;
}

/** 把引文片段对到某条未完成待办上（只做**前缀**匹配，理由见注释） */
function matchQuotedItem(frag, numbered = []) {
  // 片段长这样："10/8（今天到期）・登录官网 登录官网 邮件指令•首次提醒 10/07 20:04"
  // 前半截是日期标签（用 ・ / · 分隔），标题后面还跟着来源、行动、"· 首次提醒"，无处可切。
  // 所以反过来判：**待办标题必须是这个片段的开头**，而不是"片段里包含标题"。
  // 为什么不能用 includes：2026-09-21 的事故里，一句"这些都做完了"里的短词就靠 includes
  // 关掉了 5 条待办。宁可报未识别，也绝不做模糊匹配。
  // 比较时把空白全去掉：日报里是「AP 期中考试」，邮件纯文本里可能变成「AP期中考试」。
  const norm = (v) => String(v || "").replace(/\s+/g, "");
  const raw = String(frag || "");
  const stripped = raw.replace(/^[^・·]{0,24}?[・·]\s*/, "");   // 砍掉"日期标签 ・"
  const cands = [];
  for (const n of numbered || []) {
    const title = String(n?.title || "").trim();
    if (!title) continue;
    const t = norm(title);
    if (t && (norm(stripped).startsWith(t) || norm(raw).startsWith(t))) cands.push({ id: n.id, title });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.title.length - a.title.length);        // 多个候选时取最具体的那个
  return cands[0];
}

export function resolveSeqRefs(ops, numbered = [], quotedNumbers = null) {
  // 先分清"回信"还是"新邮件"，两者规则不同：
  //   · 有引文（回信）→ **只认引文里的编号**；引文里对不上，就什么都不做（报未识别）。
  //   · 没引文（新邮件）→ 退回"当前清单的位次"（用户看的就是当天那份）。
  // 2026-10-08 真实事故：引文解析坏了以后仍然退回了"当前位次"，于是"删去待办1、2、3"
  // 把当时恰好排前三位的**另外三条**删掉了。宁可不动，也绝不能删错人。
  const quoted = quotedNumbers && typeof quotedNumbers === "object" ? quotedNumbers : null;
  return (Array.isArray(ops) ? ops : []).map((op) => {
    const seq = Number(op?.seq ?? op?.序号);
    if (!Number.isInteger(seq) || seq < 1) return op;
    const { seq: _drop, 序号: _drop2, ...rest } = op;
    if (quoted) {
      const hit = matchQuotedItem(quoted[seq], numbered);
      if (hit) return { ...rest, id: hit.id };
      // 引文里没有这个编号（长引文常被邮件客户端**截断**：2026-10-09 那封「删去待办10」的引文
      // 只到 [8] 就断了）→ 什么都不动，但把"当前第 N 条是什么"告诉用户，他照抄一句就能重试。
      const cur = (numbered || []).find((n) => Number(n.序号) === seq);
      return {
        ...op, _seqUnknown: seq, _seqCurrent: cur ? cur.title : null,
        _seqWhy: cur
          ? `这是回信，但引文里没有第 ${seq} 条（长引文常被邮件客户端截断）；按当前清单第 ${seq} 条是「${cur.title}」——写清标题再试`
          : "这是回信，但引文里的这个编号没能对上任何未完成待办",
      };
    }
    const hit = (numbered || []).find((n) => Number(n.序号) === seq);
    if (!hit) return { ...op, _seqUnknown: seq };          // 序号越界：交给 applyOps 报"未识别"
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
  provider = "auto", target = "zh-CN", log = () => {}, now = new Date(), translator = null,
} = {}) {
  if (!mails?.length) return { applied: [], failed: [], mails: 0, pending };
  const tr = translator || makeTranslator({ provider, target, log, kind: "command" });
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
    // 回信里引用的那封日报，就是"用户看到的编号"的来源。
    // 必须是**回信**才算：没有引文的新邮件，编号只能按"当前清单的位次"解释（传 null）。
    const quotedNumbers = quoteStart(m?.bodyPreview) >= 0 ? parseQuotedNumbers(m?.bodyPreview) : null;
    const ops = parsed ? resolveSeqRefs(parsed, numbered, quotedNumbers) : null;   // 序号 → id（代码认，模型不认）
    if (!ops) {
      const subj = String(m.subject || "").slice(0, 40);
      failed.push({ op: "(解析)", ref: subj, reason: "模型返回无法解析，未做任何改动" });
      log(`待办指令：无法解析「${subj}」，这封不做任何改动`);
      continue;
    }
    // 模型一个操作都没给：**必须说一声**。什么都不报的话，用户会以为指令没生效、
    // 甚至以为功能坏了 —— 2026-10-08 真实发生：回信"添加待办 + 三条清单" → 0 项操作 →
    // 日报里连"已按你的邮件更新台账"这一段都不出现（那段只在有 applied/failed 时才渲染）。
    // 只在你**确实写了字**的时候提醒：空回信（只有引文）本来就无事可做，不必打扰。
    if (!ops.length && written) {
      failed.push({ op: "(空)", ref: String(m.subject || "").slice(0, 40), reason: "没解析出可执行的操作，未做任何改动" });
      log(`待办指令：这封「${written.slice(0, 30)}」没解析出任何操作，未做任何改动`);
    }
    const res = applyOps(ledger, ops, now, { pending: pendingList, watch, dismissed, text: written, subject: m?.subject });
    pendingList = res.pending ?? pendingList;
    applied.push(...res.applied);
    failed.push(...res.failed);
    for (const a of res.applied) {
      if (a.becauseAddIntent) {
        log(`待办指令：你说的是「新增」→ 新增了一条「${a.title}」，没有改动${a.untouched ? `「${a.untouched}」` : "任何已有待办"}的日期`);
      }
    }

    // 用户 2026-09-21 明确的语义："**我回复了这封日报 = 我看到了**"，
    // 所以里面列出的红标（待你处理）就该销掉、恢复成普通。
    // 例外：正文里明确说"还没做 / 先留着 / 别销 / 保留"时不动它。
    const subj = String(m?.subject || "");
    const isReplyToDigest = /^\s*(re|回复|答复|fw|fwd|转发)\s*[:：]/i.test(subj) || /邮件日报|待办提醒|📬/.test(subj);
    const keepThem = /还没做|还没弄|没做完|先留|先别销|别销|保留|不要销/i.test(written);
    if (isReplyToDigest && !keepThem && pendingList.length) {
      // ⚠️ dismissed 必须传进去：不传的话 dismiss() 写进的是一个临时对象、结果随返回值被丢弃，
      // 自动销掉的红标不在「已忽略名单」里 —— 下次运行窗口还盖着它，又会被重新加回清单（复活）。
      const auto = applyOps(ledger, [{ op: "handled", all: true }], now, { pending: pendingList, watch, dismissed });
      pendingList = auto.pending ?? pendingList;
      applied.push(...auto.applied);
      log(`回信视为「我已看到」：销掉 ${auto.applied.length} 条红标（想留着就写"这封还没做"）`);
    }
  }

  tr.flush?.();
  const st = tr.stats ? tr.stats() : { provider: "stub" };
  log(`待办指令(${st.provider})：处理 ${mails.length} 封指令邮件，执行 ${applied.length} 项操作，未识别 ${failed.length} 项`);
  return { applied, failed, mails: mails.length, pending: pendingList, dismissed, stats: st };
}
