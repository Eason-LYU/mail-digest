// 其余邮件的压缩清单：把"同一批发件人的一堆通知"压成一条。
//
// 教训（真实数据校准）：最初按邮件线程 id（ConversationID）归并，但真实邮箱里
// 111 封群发邮件的 ConversationID **全部唯一**——它们本来就是各自独立的线程。
// 所以对"机构群发"来说，**发件人才是有意义的归并维度**（例如 PolyU Library 一周发 6 封）。
//
// 归并策略（确定性、可测试）：
//   1. 同一发件人 ≥ minGroupSize 封  → 合成一条（中文概括交给 LLM）
//   2. 否则按"主题家族"（去掉 Re:/Fwd: 与日期、编号）≥2 封 → 合成一条
//   3. 否则单条
import { effectiveRank } from "./classify.mjs";

/** 去掉回复/转发前缀，便于同一主题归并到一组 */
export function normalizeSubject(s) {
  return String(s || "")
    .replace(/^\s*((re|fw|fwd|答复|回复|转发)\s*[:：]\s*)+/gi, "")
    .replace(/^\s*\[(external|外部)\]\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 主题家族：剥掉日期、编号这些"每封都不同"的部分，让同类通知能归到一起 */
export function subjectFamily(s) {
  return normalizeSubject(s)
    .replace(/\b\d{6,}\b/g, " ")                       // 20260916、长编号
    .replace(/\b\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?\b/g, " ")  // 18/9、9-18-2026
    .replace(/\b\d{1,2}\s*月\s*\d{1,2}\s*日/g, " ")     // 9月18日
    .replace(/\((?:[^()]{0,40})\)/g, " ")               // 括号补充说明
    .replace(/\[(?:[^\[\]]{0,30})\]/g, " ")             // 方括号标签
    .replace(/[：:]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const senderOf = (m) => (m.from?.emailAddress?.name || m.from?.emailAddress?.address || "(未知发件人)").trim();

/**
 * 生成"其余邮件"的压缩清单。
 * 返回 { items, totalItems, totalMails, groupItems, hidden }
 */
export function buildCompactItems(messages, { minGroupSize = 3, familyGroupSize = 2, limit = 40, maxSubjects = 6 } = {}) {
  const sorted = [...messages].sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));

  const bySender = new Map();
  for (const m of sorted) {
    const key = senderOf(m).toLowerCase();
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key).push(m);
  }

  const asGroup = (msgs, kindLabel) => ({
    id: `g:${kindLabel}:${senderOf(msgs[0]).toLowerCase()}`,
    kind: "group",
    count: msgs.length,
    sender: senderOf(msgs[0]),
    subjects: [...new Set(msgs.map((m) => normalizeSubject(m.subject)).filter(Boolean))].slice(0, maxSubjects),
    latest: msgs[0].receivedDateTime,
  });
  const asSingle = (m) => ({
    id: `s:${m.conversationId || subjectFamily(m.subject)}`,
    kind: "single",
    sender: senderOf(m),
    subject: normalizeSubject(m.subject),
    latest: m.receivedDateTime,
  });

  const items = [];
  const rest = [];

  // 1) 批发件人：同一发件人 ≥ minGroupSize 封 → 一条
  for (const msgs of bySender.values()) {
    if (msgs.length >= minGroupSize) items.push(asGroup(msgs, "sender"));
    else rest.push(...msgs);
  }

  // 2) 其余：按主题家族归并
  const byFamily = new Map();
  for (const m of rest) {
    const key = `${senderOf(m).toLowerCase()}|${subjectFamily(m.subject)}`;
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key).push(m);
  }
  for (const msgs of byFamily.values()) {
    if (msgs.length >= familyGroupSize) items.push(asGroup(msgs, "family"));
    else items.push(asSingle(msgs[0]));
  }

  items.sort((a, b) => new Date(b.latest) - new Date(a.latest));
  const groupItems = items.filter((i) => i.kind === "group").length;

  return {
    items: items.slice(0, limit),
    totalItems: items.length,
    totalMails: messages.length,
    groupItems,
    hidden: Math.max(0, items.length - limit),
  };
}

/**
 * 从全部邮件里挑出"要压缩展示"的那部分：其余档 + 第二档超出详细展示上限的。
 * 与 digest.mjs 的分档逻辑一致（同一套 classify 规则，结果确定）。
 */
export function restMessages(messages, watchLimit = 12) {
  const enriched = messages.map((m) => ({ m, c: effectiveRank(m) }));
  const action = enriched.filter((x) => x.c.bucket === "action");
  const watch = enriched.filter((x) => x.c.bucket === "watch").sort((a, b) => b.c.score - a.c.score);
  const info = enriched.filter((x) => x.c.bucket === "info");
  return {
    actionCount: action.length,
    watchTop: watch.slice(0, watchLimit).map((x) => x.m),
    rest: [...watch.slice(watchLimit).map((x) => x.m), ...info.map((x) => x.m)],
  };
}
