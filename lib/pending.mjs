// 「待你处理的重要邮件」清单
//
// 为什么不用"已读/未读"：用户根本不靠标已读管理邮件（收件箱几百封未读），
// 所以"未读"这个信号没有意义。改成**显式**的：判为 action 的邮件进入这份清单，
// 每天继续出现在日报里，直到用户**用邮件回复说"已读/搞定了"**（或超过 30 天兜底清理）。
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";
import { readJsonState, writeJsonState } from "./statefile.mjs";

const FILE = process.env.MAIL_PENDING_FILE || path.join(STATE_DIR, "pending-mails.json");
const DAY = 24 * 3600 * 1000;

/**
 * 读「待你处理」清单。返回 { items, error }——**调用方必须看 error**：
 * 文件被写坏/清空时，绝不能当成"清单是空的"就直接覆盖回去（台账那边踩过这个坑）。
 */
export function loadPendingState() {
  const { value, error, missing } = readJsonState(FILE, { items: [] });
  const items = Array.isArray(value?.items) ? value.items : [];
  // 「已忽略名单」：用户销掉过的邮件 id（含时间），保留 30 天。
  // 为什么需要：清单的生成逻辑是"每次运行把窗口内判为红标的邮件加回来"，
  // 而窗口有 24 小时 —— 没有这份名单的话，用户刚销掉的红标下一次运行就会回来。
  const raw = value && typeof value.dismissed === "object" && value.dismissed ? value.dismissed : {};
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const dismissed = {};
  for (const [id, iso] of Object.entries(raw)) {
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t >= cutoff) dismissed[id] = iso;
  }
  // 空文件（missing+error，上次写入被打断）同样要报 error：
  // 当成"清单是空的"放过去，下一次保存就会拿空清单覆盖真数据。
  return { items, dismissed, error: error || null };
}

/** 把"用户销掉的邮件"记进已忽略名单（幂等） */
export function dismiss(dismissed, mails, now = new Date()) {
  const iso = now.toISOString();
  let n = 0;
  for (const m of mails || []) {
    if (m?.id && !dismissed[m.id]) { dismissed[m.id] = iso; n++; }
  }
  return n;
}

export function loadPending() { return loadPendingState().items; }

export function savePending(items, dismissed = {}) {
  try { writeJsonState(FILE, { items, dismissed }); } catch { /* 忽略 */ }
}

/** 把「需要你行动」的邮件记入清单（幂等：同一封不会重复记） */
export function addPending(items, mails, now = new Date()) {
  const seen = new Set(items.map((i) => i.id));
  let added = 0;
  for (const m of mails) {
    if (!m?.id || seen.has(m.id)) continue;
    items.push({
      id: m.id,
      conversationId: m.conversationId || null,
      subject: String(m.subject || "").slice(0, 200),
      fromName: m.from?.emailAddress?.name || "",
      fromAddr: m.from?.emailAddress?.address || "",
      receivedDateTime: m.receivedDateTime,
      preview: String(m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 300),
      why: (m.rank?.why || (Array.isArray(m.rank?.reasons) ? m.rank.reasons[0] : "") || "").slice(0, 40),
      firstSeen: now.toISOString(),
    });
    seen.add(m.id);
    added++;
  }
  return added;
}

/** 用户回复"已读/搞定了"时，把对应邮件从清单移除（支持 id、线程 id、标题片段） */
export function removeHandled(items, refs) {
  const wanted = (refs || []).map((r) => String(r).trim()).filter(Boolean);
  const kept = [];
  const removed = [];
  for (const it of items) {
    const matched = wanted.some((w) =>
      w === it.id
      || (it.conversationId && w === it.conversationId)
      || (it.subject && (it.subject.includes(w) || w.includes(it.subject)))
      // 按发件人名批量销账：要求名字够长（>=4 字），否则 "SAO"/"ELC" 这种短词
      // 出现在回信里就会把该发件人的所有提醒一起销掉——太危险。
      || (it.fromName && it.fromName.trim().length >= 4 && w.includes(it.fromName)));
    if (matched) removed.push(it); else kept.push(it);
  }
  return { kept, removed };
}

/** 兜底清理：收到超过 maxDays 天还没被处理的，移出清单（默认 30 天） */
export function prunePending(items, now = new Date(), maxDays = 30) {
  const cutoff = now.getTime() - maxDays * DAY;
  return items.filter((i) => {
    const t = Date.parse(i.receivedDateTime || i.firstSeen || "");
    return Number.isNaN(t) || t >= cutoff;
  });
}

/** 按收到时间倒序，并算出挂了几天 */
export function listPending(items, now = new Date()) {
  return [...items]
    .sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0))
    .map((i) => {
      const t = Date.parse(i.receivedDateTime || i.firstSeen || "");
      return { ...i, daysAgo: Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now.getTime() - t) / DAY)) };
    });
}

/** 转成能直接进入日报渲染的邮件对象（分档固定为 action，理由沿用当初的判定） */
export function toRenderable(item) {
  const why = item.why || "仍需你处理";
  return {
    id: item.id,
    conversationId: item.conversationId,
    subject: item.subject,
    from: { emailAddress: { name: item.fromName, address: item.fromAddr } },
    receivedDateTime: item.receivedDateTime,
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: item.preview || "",
    carryOver: true,
    rank: { bucket: "action", score: 70, why, reasons: [why], source: "pending", senderName: item.fromName, sender: item.fromAddr },
  };
}

// ---------- 提醒邮件的「截止日」与自动过期（2026-11-02 用户要求）----------
// 症状：图书馆借书 10/26 就到期了，之后每天还在「待你处理」里挂着。
// 规则（用户原话「到期了也挂着」）：**邮件自己的截止日过了，就别再天天提醒**。
// 只认紧挨 deadline / due / by / 截止 / 到期 这类词的日期，避免把正文里的活动日期当截止日。
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DUE_CTX = /(deadline|due|by|before|expires?|截止|到期|提交|须于|之前)/i;
const DUE_CTX_WINDOW = 40;

const pad2 = (n) => String(n).padStart(2, "0");
const hkToday = (now) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
}).format(now);

/** 没写年份时，取离"收到这封邮件"最近的那一年（12 月写 1 月 5 日 → 次年，而不是一年前） */
function yearNear(month, day, anchor) {
  const y = anchor.getFullYear();
  const cands = [y - 1, y, y + 1]
    .map((yy) => ({ yy, t: Date.UTC(yy, month - 1, day) }))
    .filter((c) => !Number.isNaN(c.t));
  let best = cands[0];
  for (const c of cands) if (Math.abs(c.t - anchor.getTime()) < Math.abs(best.t - anchor.getTime())) best = c;
  return `${best.yy}-${pad2(month)}-${pad2(day)}`;
}

/**
 * 从提醒邮件（主题 + 预览前 300 字）里找它的截止日；找不到返回 null。
 * @returns {string|null} 'YYYY-MM-DD'
 */
export function mailDeadline(item, now = new Date()) {
  const subject = String(item?.subject || "");
  const preview = String(item?.preview || "");
  const text = `${subject} ${preview}`.replace(/\s+/g, " ");
  const anchorSrc = item?.receivedDateTime || item?.firstSeen;
  const anchor = anchorSrc && !Number.isNaN(Date.parse(anchorSrc)) ? new Date(anchorSrc) : now;

  const found = [];
  let m;
  // 26 Oct 2026 / 28 October
  const re1 = new RegExp(`(\\d{1,2})\\s+${MON}\\s*(\\d{4})?`, "ig");
  while ((m = re1.exec(text)) !== null) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) found.push({ index: m.index, day: Number(m[1]), month, year: m[3] ? Number(m[3]) : null });
  }
  // Oct 26, 2026
  const re2 = new RegExp(`${MON}\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?`, "ig");
  while ((m = re2.exec(text)) !== null) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) found.push({ index: m.index, day: Number(m[2]), month, year: m[3] ? Number(m[3]) : null });
  }
  for (const f of found) {
    const before = text.slice(Math.max(0, f.index - DUE_CTX_WINDOW), f.index);
    if (!DUE_CTX.test(before)) continue;                 // 前面没有"截止"类词 → 不是 DDL
    if (f.day < 1 || f.day > 31) continue;
    if (f.year) return `${f.year}-${pad2(f.month)}-${pad2(f.day)}`;
    return yearNear(f.month, f.day, anchor);
  }
  return null;
}

/**
 * 把「截止日已经过去」的提醒邮件从清单里撤下来（记进已忽略名单，数据不丢）。
 * 当天的截止日**不算过期**（今天还能办）。
 * @returns {{items: object[], gone: object[]}}
 */
export function expireOverdue(items, dismissed, now = new Date()) {
  const today = hkToday(now);
  const keep = [];
  const gone = [];
  for (const it of items || []) {
    const d = mailDeadline(it, now);
    if (d && d < today) gone.push(it);
    else keep.push(it);
  }
  if (gone.length) dismiss(dismissed, gone, now);
  return { items: keep, gone };
}
