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
  return { items, error: missing ? null : (error || null) };
}

export function loadPending() { return loadPendingState().items; }

export function savePending(items) {
  try { writeJsonState(FILE, { items }); } catch { /* 忽略 */ }
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
