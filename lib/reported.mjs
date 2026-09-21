// 「这封邮件已经报过了」记忆
//
// 为什么需要：
//   窗口标准化成「前一天 20:00 → 现在」之后，会出现**重叠**——比如今天白天你手动跑了两次，
//   晚上 20:00 那次的标准窗口仍会覆盖今天一整天，同一批邮件就会被再报一遍。
//   把已报告过的邮件 id 记下来，报告时跳过，就既保持了标准窗口，又不会重复刷屏。
//
// 安全性：这只是一份"别重复"的名单，丢了大不了重报一次；而且只保留 7 天（比窗口上限还长）。
import path from "node:path";
import { STATE_DIR } from "./config.mjs";
import { readJsonState, writeJsonState } from "./statefile.mjs";

// 路径**延迟解析**：这样测试可以用 MAIL_REPORTED_FILE 指到临时文件，不会污染真实名单
const file = () => process.env.MAIL_REPORTED_FILE || path.join(STATE_DIR, "reported-mails.json");
const KEEP_DAYS = 7;
const DAY = 24 * 3600 * 1000;

/** 读出"已报告"名单（自动丢掉太旧的） */
export function loadReported(now = new Date()) {
  const { value } = readJsonState(file(), { items: {} });
  const items = value && typeof value.items === "object" && value.items ? value.items : {};
  const cutoff = now.getTime() - KEEP_DAYS * DAY;
  const out = new Map();
  for (const [id, iso] of Object.entries(items)) {
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t >= cutoff) out.set(id, iso);
  }
  return out;
}

export function saveReported(reported, now = new Date()) {
  try {
    writeJsonState(file(), { updatedAt: now.toISOString(), items: Object.fromEntries(reported) });
  } catch { /* 记不住就算了，下次最多重报一次 */ }
}

/** 过滤掉已经报过的邮件（没有 id 的保留，宁可重复也不丢） */
export function filterUnreported(mails, reported) {
  const kept = [];
  let skipped = 0;
  for (const m of mails || []) {
    if (m?.id && reported?.has(m.id)) { skipped++; continue; }
    kept.push(m);
  }
  return { kept, skipped };
}

/** 本次报告过的邮件登记进去 */
export function markReported(reported, mails, now = new Date()) {
  const iso = now.toISOString();
  let added = 0;
  for (const m of mails || []) {
    if (!m?.id || reported.has(m.id)) continue;
    reported.set(m.id, iso);
    added++;
  }
  return added;
}
