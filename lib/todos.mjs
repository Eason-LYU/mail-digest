// 待办台账：把每天从邮件里提取出的待办累积保存，并在之后每天的日报里带出来。
//
// 为什么需要：邮件只是"某天来的通知"，而学生的待办是跨天的。
// 9/15 收到的「9/25 前完成选课确认」，在 9/18 的日报里必须还能看到，否则等于没提醒。
//
// 设计原则（重要）：
//   - 归并、排序、过期判断全部是确定性代码，可测试；模型只负责"从邮件里读出事项"。
//   - 只接受格式合法的日期；模型编造的日期会被 isValidDue 扔掉。
//   - 同一线程（conversationId）只保留一条，重复提醒不会刷屏。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR } from "./config.mjs";
import { readJsonState, writeJsonState, listBackups } from "./statefile.mjs";

// 台账文件路径：允许环境变量覆盖，便于测试时不污染真实台账
export const LEDGER_FILE = process.env.MAIL_LEDGER_FILE || path.join(STATE_DIR, "todos.json");
const DAY = 24 * 3600 * 1000;

export function loadLedger() {
  // 读失败/内容坏了都不再"静默当空台账"——那正是会**把好数据覆盖掉**的写法。
  // readJsonState 会把读不出来的原文另存到 .state\backups\ 并在 _loadError 里报上来。
  const { value, error, missing } = readJsonState(LEDGER_FILE, { version: 1, items: [] });
  const obj = value && typeof value === "object" && !Array.isArray(value) ? value : { version: 1, items: [] };
  if (!Array.isArray(obj.items)) obj.items = [];
  if (error && !missing) obj._loadError = error;
  return obj;
}

export function saveLedger(ledger) {
  writeJsonState(LEDGER_FILE, ledger);
}

/** 台账主键：优先用邮件线程 id，没有就用主题哈希（同一封提醒重复到达不会重复入账） */
export function makeKey(conversationId, subject) {
  if (conversationId) return `c:${conversationId}`;
  return `s:${crypto.createHash("sha1").update(String(subject || "")).digest("hex").slice(0, 16)}`;
}

/** 严格校验模型给的日期，挡掉编造/格式错误的值 */
export function isValidDue(due, now = new Date()) {
  if (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
  const t = Date.parse(`${due}T12:00:00+08:00`);
  if (Number.isNaN(t)) return false;
  const diff = t - now.getTime();
  return diff > -400 * DAY && diff < 800 * DAY;   // 过去一年多 / 未来两年多之外的，一律不信
}

/** 把「m/d」「9月25日」这类文字规范化成 YYYY-MM-DD（仅在模型没给 ISO 时兜底） */
export function normalizeDue(text, now = new Date()) {
  if (!text) return null;
  const m = String(text).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const iso = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    return isValidDue(iso, now) ? iso : null;
  }
  const m2 = String(text).match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m2) {
    const iso = `${now.getFullYear()}-${String(m2[1]).padStart(2, "0")}-${String(m2[2]).padStart(2, "0")}`;
    return isValidDue(iso, now) ? iso : null;
  }
  return null;
}

/**
 * 把本轮提取到的事项并进台账。
 * incoming: [{ key, title, action, due, dueText, subject, source }]
 */
export function mergeItems(ledger, incoming, now = new Date()) {
  const nowIso = now.toISOString();
  const byKey = new Map(ledger.items.map((i) => [i.key, i]));
  let added = 0; let updated = 0;

  for (const inc of incoming) {
    if (!inc || !inc.key) continue;
    const cur = byKey.get(inc.key);
    if (cur) {
      // 已完成（done）/已删除（deleted）的条目**一律不动**：
      // 它们可能是用户自己在「待办管理.cmd」里改过标题/截止日的，
      // 也可能是他明确说"做完了"销掉的；同线程再来一封提醒不该把它改回去。
      if (cur.status !== "open") continue;
      cur.lastSeen = nowIso;
      if (inc.title) cur.title = inc.title;
      if (inc.action) cur.action = inc.action;
      if (inc.due && inc.due !== cur.due) { cur.due = inc.due; cur.dueText = inc.dueText || cur.dueText; }
      if (inc.dueText) cur.dueText = inc.dueText;
      if (inc.subject) cur.subject = inc.subject;
      if (inc.source) cur.source = inc.source;
      // 已被标记完成的，不因为收到同线程的重复提醒而重新打开
      updated++;
    } else {
      const item = {
        key: inc.key, status: "open",
        firstSeen: nowIso, lastSeen: nowIso,
        title: inc.title || inc.subject || "(未命名事项)",
        action: inc.action || "",
        due: inc.due || null, dueText: inc.dueText || "",
        subject: inc.subject || "", source: inc.source || "",
      };
      ledger.items.push(item);
      byKey.set(item.key, item);
      added++;
    }
  }
  return { added, updated };
}

/**
 * 还差几天到期。
 * 必须按**香港日历日期**相减，不能用"距当地 23:59:59 还有多少小时"——
 * 否则 9/18 中午看 9/19 的截止日会算成 2 天（差了 36 小时，向上取整就多一天）。
 */
export function daysUntil(due, now = new Date()) {
  const hkDay = (d) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(d));
  const dueNoon = Date.parse(`${hkDay(`${due}T00:00:00+08:00`)}T12:00:00+08:00`);
  const nowNoon = Date.parse(`${hkDay(now)}T12:00:00+08:00`);
  return Math.round((dueNoon - nowNoon) / DAY);
}

/**
 * 取出仍要显示的待办：按截止日期升序（没日期的排后面），并算出还剩几天。
 * maxAgeDays 默认 0：**一过期就不再出现在日报里**（按用户要求"过了就删掉"），
 * 只是状态改为 expired 留在台账文件里，不会真的丢数据。
 * undatedMaxAgeDays：没有截止日的事项，超过这么多天没再被提醒就归档——
 * 否则「上课带笔」这种一次性小事会永远赖在台账里。
 */
export function openItems(ledger, now = new Date(), { maxAgeDays = 0, undatedMaxAgeDays = 15, limit = 12 } = {}) {
  const out = [];
  for (const it of ledger.items) {
    if (it.status !== "open") continue;
    if (it.due) {
      const daysLeft = daysUntil(it.due, now);
      if (daysLeft < -maxAgeDays) { it.status = "expired"; continue; }
      out.push({ ...it, daysLeft });
    } else {
      const seen = it.lastSeen ? Date.parse(it.lastSeen) : NaN;
      const ageDays = Number.isNaN(seen) ? 0 : (now.getTime() - seen) / DAY;
      if (ageDays > undatedMaxAgeDays) { it.status = "expired"; continue; }
      // 没有截止日也要能感到积压：算出"已挂几天"
      const firstSeen = it.firstSeen ? Date.parse(it.firstSeen) : NaN;
      const heldDays = Number.isNaN(firstSeen) ? 0 : Math.max(0, Math.floor((now.getTime() - firstSeen) / DAY));
      out.push({ ...it, daysLeft: null, heldDays });
    }
  }
  out.sort((a, b) => {
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due) return -1;
    if (b.due) return 1;
    return String(b.lastSeen).localeCompare(String(a.lastSeen));
  });
  const shown = out.slice(0, limit);
  return { shown, total: out.length, hidden: Math.max(0, out.length - limit) };
}

/** 按序号或 key 前缀把事项标记为完成 */
export function markDone(ledger, ref, now = new Date()) {
  const open = ledger.items.filter((i) => i.status === "open");
  const sorted = openItems({ version: 1, items: open.map((i) => ({ ...i })) }, now, { limit: 999 }).shown;
  let target = null;
  if (/^\d+$/.test(String(ref))) target = sorted[Number(ref) - 1];
  if (!target) target = ledger.items.find((i) => i.key === ref) || ledger.items.find((i) => i.key.startsWith(String(ref)));
  if (!target) return null;
  const real = ledger.items.find((i) => i.key === target.key);
  if (!real) return null;
  real.status = "done";
  real.doneAt = now.toISOString();
  return real;
}

/** 把天数差变成人话 */
export function dueLabel(item) {
  if (!item.due) {
    // 没有截止日：显示"已挂几天"，让人能感到它在积压；15 天后自动归档
    if (item.heldDays !== undefined && item.heldDays !== null) {
      return item.heldDays <= 0 ? "今天新增" : `已挂 ${item.heldDays} 天`;
    }
    return "无期限";
  }
  if (item.daysLeft === null || item.daysLeft === undefined) return item.due;
  const d = new Date(`${item.due}T12:00:00+08:00`);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (item.daysLeft < 0) return `${md}（已过期 ${-item.daysLeft} 天）`;
  if (item.daysLeft === 0) return `${md}（今天到期）`;
  if (item.daysLeft === 1) return `${md}（明天到期）`;
  return `${md}（还有 ${item.daysLeft} 天）`;
}
