// 从模型输出里稳健地抠出 JSON（容忍 ```json 包裹、前后废话、以及裸数组/对象）
// 单独放一个文件，避免 enrich 与 rank 互相 import 造成循环依赖。

export function parseJsonLoose(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { /* 继续尝试 */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* 放弃 */ } }
  return null;
}

export function parseJsonArrayLoose(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const v = JSON.parse(cleaned);
    if (Array.isArray(v)) return v;
    if (Array.isArray(v?.items)) return v.items;
    if (Array.isArray(v?.results)) return v.results;
  } catch { /* 继续 */ }
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) { try { const v = JSON.parse(m[0]); if (Array.isArray(v)) return v; } catch { /* 放弃 */ } }
  return null;
}
