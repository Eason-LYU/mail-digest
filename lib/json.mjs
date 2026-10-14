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

/**
 * 把"邮件 dump / fixture"解析结果**永远**规整成数组。
 *
 * 为什么需要（2026-09-29 真实事故）：桥接层原本用 `$list | ConvertTo-Json` 写 dump，
 * 而 PowerShell 的管道写法在列表**只有 1 项**时会写成一个**裸 JSON 对象**而不是 `[ {...} ]`。
 * 这里以前写成 `Array.isArray(d) ? d : d.value || []` —— 裸对象既不是数组、也没有 `.value`，
 * 于是返回空数组：**窗口里恰好只有 1 封新邮件时，日报会报"无新邮件"**，那封邮件被静默丢掉。
 * 当天早上用户的「待办指令回信」就是这样被吞掉、拖到晚上 20:00 才执行。
 * 历史日志里 `count=1` 的导出出现过 8 次。
 *
 * 三种形态都兜住：
 *   1) 正常数组                        → 原样返回
 *   2) { value: [...] }（Graph 信封）  → 取里面的数组
 *   3) 裸对象（就是"只有 1 封"）        → 当成只含 1 封的列表
 */
export function asMailList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.value)) return parsed.value;
  if (parsed && typeof parsed === "object" && parsed.value === undefined) return [parsed];
  return [];
}
