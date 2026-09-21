// 分档（重要性判断）交给 LLM
//
// 设计取舍：
//   · LLM 负责"哪封重要"这个判断题——它比关键词规则更懂语义（例如"这封到底要不要我做事"）。
//   · 但结果**缓存**、并且**失败时自动退回本地规则**（lib/classify.mjs），
//     否则一次网络抖动就会让整封日报的分档失效。
//   · 返回的分数只用于排序；日期校验、台账归并、去重等确定性逻辑仍由代码负责。
import { classify } from "./classify.mjs";
import { makeTranslator } from "./translate.mjs";
import { parseJsonArrayLoose } from "./json.mjs";

const BUCKETS = new Set(["action", "watch", "info"]);

/** 取"最终生效的分档结果"（LLM 优先，其次规则） */
export { effectiveRank } from "./classify.mjs";

const clampScore = (n, fallback) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
};

/** 压成模型输入：只给判断需要的字段，控制 token */
export function slimForRank(m, previewLen = 160) {
  return {
    id: m.id || m.conversationId || (m.subject || "").slice(0, 40),
    from: (m.from?.emailAddress?.name || m.from?.emailAddress?.address || "").slice(0, 40),
    subject: (m.subject || "").slice(0, 120),
    preview: (m.bodyPreview || "").replace(/\s+/g, " ").slice(0, previewLen),
    unread: !m.isRead,
    attach: Boolean(m.hasAttachments),
    flagged: m.flag?.flagStatus === "flagged",
  };
}

/**
 * 用 LLM 给一批邮件分档，结果写到 m.rank（含 bucket/score/why/source）。
 * 返回 { ranked, failed, provider }；任何失败都不抛，由调用方决定是否退回规则。
 */
export async function rankMessages(messages, {
  provider = "auto",
  target = "zh-CN",
  log = () => {},
  batchSize = 25,
  previewLen = 160,
} = {}) {
  if (!messages.length) return { ranked: 0, failed: 0, provider: null };

  const tr = makeTranslator({ provider, target, log, kind: "rank" });
  let ranked = 0;
  let bad = 0;
  let batches = 0;

  for (let i = 0; i < messages.length; i += batchSize) {
    const slice = messages.slice(i, i + batchSize);
    batches++;
    const payload = JSON.stringify(slice.map((m) => slimForRank(m, previewLen)));
    const raw = await tr.ask(payload);
    if (!raw) { bad += slice.length; log(`分档第 ${batches} 批：模型没有返回内容，这批将使用本地规则`); continue; }

    const arr = parseJsonArrayLoose(raw);
    if (!arr) { bad += slice.length; log(`分档第 ${batches} 批：返回无法解析，这批将使用本地规则`); continue; }

    const byId = new Map(arr.map((o) => [String(o?.id ?? ""), o]));
    let matched = 0;
    for (const m of slice) {
      const id = slimForRank(m, previewLen).id;
      const hit = byId.get(String(id));
      if (!hit || !BUCKETS.has(String(hit.bucket))) continue;
      const rule = classify(m);                       // 规则结果作为兜底/参照
      const why = String(hit.why || "").slice(0, 30);
      m.rank = {
        bucket: String(hit.bucket),
        score: clampScore(hit.score, rule.score),
        why,
        source: "llm",
        // 保持与规则结果相同的字段形状，否则日报里会漏掉发件人、理由标签为空
        reasons: why ? [why] : (rule.reasons || []).slice(0, 2),
        senderName: rule.senderName,
        sender: rule.sender,
      };
      matched++;
      ranked++;
    }
    if (matched < slice.length) bad += slice.length - matched;
    log(`分档第 ${batches} 批：发送 ${slice.length} 封，模型返回 ${arr.length} 条，命中 ${matched} 封`);
  }

  tr.flush();
  const st = tr.stats();
  log(`分档(LLM ${st.provider})：${ranked}/${messages.length} 封由模型判定，${bad} 封退回本地规则（缓存命中 ${st.hits} / 新调用 ${st.miss} / 失败 ${st.fail}）`);
  return { ranked, failed: bad, provider: st.provider };
}
