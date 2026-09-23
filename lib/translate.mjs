// 邮件翻译：把英文主题/摘要译成中文，方便快速扫读
//
// 提供者（provider）：
//   google  —— Google 翻译的免费接口（无需 key，实测本机可用）。注意：属于非官方接口，
//              Google 改协议就可能失效；且会把待译文本发到 Google 服务器。
//   deepseek—— 需要 API key（放在 .state/secrets.json 里），质量更高，可选。
//   none    —— 关闭翻译。
//
// 翻译结果按内容哈希缓存在 .state/translation-cache.json，同一句话不会重复请求。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR } from "./config.mjs";
import { writeJsonState } from "./statefile.mjs";

const CACHE_FILE = path.join(STATE_DIR, "translation-cache.json");
const SECRETS_FILE = path.join(STATE_DIR, "secrets.json");

/** 读 JSON，容忍记事本/PowerShell 保存时加上的 UTF-8 BOM（否则 JSON.parse 会直接失败） */
export function loadJson(file, fallback) {
  try {
    let s = fs.readFileSync(file, "utf8");
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return JSON.parse(s);
  } catch { return fallback; }
}
function saveJson(file, obj) {
  // 缓存文件只做原子写、不留备份：它丢了只是多花几次 API 调用，不值得占备份空间。
  // （但要避免写一半被杀留下半截 JSON —— 那会让整个缓存作废。）
  try { writeJsonState(file, obj, { backup: false }); } catch { /* 忽略 */ }
}

export function loadSecrets() { return loadJson(SECRETS_FILE, {}); }
export { SECRETS_FILE };

/** 判断是否值得翻译：已经基本是中文的就不译 */
export function looksTranslatable(s) {
  if (!s) return false;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk >= 6) return false;                 // 已有明显中文
  return latin >= 8;                          // 有足够英文
}

/**
 * 该不该跳过这条任务。
 * 注意："已是中文就不用译"这个启发式**只能用于 kind=translate**——
 * 行动摘要的输入是提示词（本身含中文标签），套用它会导致全部被误跳过。
 */
export function isSkippable(text, kind = "translate") {
  if (!text) return true;
  if (kind === "translate" && !looksTranslatable(text)) return true;
  return false;
}

async function googleTranslate(text, target) {
  const q = new URLSearchParams({ client: "gtx", sl: "auto", tl: target, dt: "t", q: text });
  const r = await fetch(`https://translate.googleapis.com/translate_a/single?${q}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const segs = Array.isArray(data?.[0]) ? data[0] : [];
  const out = segs.map((s) => (s && s[0]) || "").join("").trim();
  if (!out) throw new Error("翻译结果为空");
  return out;
}

// 两种用途，提示词不同：
//   translate —— 逐句翻译（主题/摘要）
//   action    —— 让模型读完整封邮件的要点，用一句中文说清"我需要做什么"
const SYSTEM_PROMPTS = {
  translate: (target) => {
    const zh = target.toLowerCase().startsWith("zh");
    return `You are a translator for a university student's daily mail digest. Translate the user's text into ${zh ? "Simplified Chinese" : target}. Rules: output ONLY the translation (no quotes, no explanation, no pinyin); keep course codes, IDs, dates, URLs and proper nouns accurate; keep it concise and natural, not word-for-word.`;
  },
  action: () => `你是一个学生的邮件助理。读下面这封邮件，用一句中文说清「我需要做什么」。
要求：
- 具体到动作、时间/截止日期、需要点或准备的东西（例如「9月30日前完成 DELTA 英语测试，点邮件里的链接」）。
- 如果这封邮件只是通知、不需要任何行动，就只回「无需行动」。
- 不超过 45 个字，不要客套话，不要复述主题，不要用引号。`,
  todo: () => `你是学生的邮件助理。读下面这封邮件，只输出一个 JSON 对象（不要 markdown 代码块，不要任何解释文字）：
{"isAction": true 或 false, "title": "不超过 20 字的事项名", "action": "不超过 45 字、具体可执行的动作", "due": "YYYY-MM-DD 或 null", "dueText": "邮件里出现的时间说法，没有就填空串"}

规则：
- due 只能来自邮件正文里**明确写出**的日期（如「9月25日前」「before 30 September」「by Friday」「Deadline: 21 Sep 2026」）。可以用今年来补全年份，但**绝对不许编造或猜测**；没有明确日期就填 null。
- 请在正文里**仔细找一遍**截止日期/提交时间/活动日期，找到就一定要填进 due——这个日期决定了之后每天的倒计时提醒。
- 如果邮件只是通知、不需要你做任何事，isAction 填 false。
- **不要**把"一次性、当天就结束、又没有明确日期"的小事当成待办（例如「今天上课带一支笔」这种）——
  这类只需当天知道，进了台账会一直赖着。只有当它有明确日期、或需要持续跟进时才登记。
- title 是事项名（如「选课确认与缴费」），action 是具体怎么做（如「登录 eStudent 核对并缴费」）。
- 一律用中文。`,
  // 分档：判断哪些邮件"需要你行动"（把重要性判断交给模型）
  rank: () => `你是负责筛选邮件的学生助理。下面是一个 JSON 数组，每项是一封邮件（id / from / subject / preview / unread / attach / flagged）。
请判断每封邮件对"一名香港的本科生"的重要程度，只输出一个 JSON 数组，每项：
{"id": 原样照抄输入的 id, "bucket": "action" 或 "watch" 或 "info", "score": 0-100, "why": "不超过 14 字的理由"}

分档标准：
- action（需要你行动）：邮件里**明确要求你做事**——有待办/截止日期、需要回复或确认、必须参加或完成的测试、你自己的选课/注册/缴费、作业发布或提交、面试邀请、图书到期等。**要少而准**：宁可漏一点，也不要把群发通知塞进来。
- watch（值得一看）：学校层面的重要通知（防诈骗、校历、校级活动或典礼、成绩发布、与你课程直接相关的通知），但不是要你立刻做什么。
- info（可以不管）：讲座/工作坊/展览/招募/问卷/报名邀请、营销、自动通知、已评分通知、验证码、订阅邮件等。

注意：
- 不要因为"来自学校官方"就判成 action。
- 活动或讲座邀请一律 info，除非邮件明确说"你必须参加/必须完成"。
- 判成 action 时，必须能在邮件里看到具体要做什么；否则降为 watch 或 info。
- score 只是排序用的相对重要性，别都填 100。
- 只输出 JSON 数组，顺序与输入一致，不要任何解释文字。`,
  // 待办指令邮件：把"我做完了X / 新增Y / Z改到某天"解析成结构化操作
  command: () => `你是学生的待办管理助理。输入是一个 JSON：{邮件主题, 邮件正文, 当前未完成待办, 待你处理的重要邮件}。
请把邮件里表达的意图转成一个 JSON 数组，每项是一个操作，**只输出这个数组**：
{"op":"done","id":"待办清单里的 id"}                                              // 某事已做完
{"op":"add","title":"事项名","action":"具体怎么做","due":"YYYY-MM-DD 或 null","dueText":"原文里的时间说法"}   // 新增任务
{"op":"set_due","id":"待办清单里的 id","due":"YYYY-MM-DD","dueText":"原文里的时间说法"}   // 改截止日（改期/推迟）
{"op":"delete","id":"待办清单里的 id"}                                             // 明确说某事取消/不做了
{"op":"handled","id":"待你处理的重要邮件里的 id"}                                  // 这封重要邮件我读了/不用管了/收到了
{"op":"handled","all":true}                                                      // 正文是一句纯回执（只有"收到/已读"这种词）→ 清单里全部销掉
{"op":"promote","id":"今日值得一看的邮件里的 id"}                                   // 把这封"值得一看"升级成重要邮件：以后每天提醒我，直到我说已读

规则：
- id 只能使用输入里出现过的 id；对不上就别输出这一条，**不要猜**。
- due 只能来自邮件里**明确写出**的日期（如「10月5日」「by 5 Oct」「下周五」）；没有就填 null，**绝不编造**。
- 邮件里没提到的待办/邮件，不要动。
- 「做完了/完成了/交了」→ done。
- **判 add 还是 set_due，只看我的原话，不看日期**：
  - 我说「加一个/加一下/新增/添加/补充/再加/记一下/加进台账」→ 一律 add（新任务）。
  - 只有我明确说「改期/推迟/延后/延期/改到/改成/换成/提前到/挪到」才允许 set_due。
  - 邮件里的日期和台账里某条任务的日期不一样，**绝不能**因此判成改期。
- **新事项和台账里已有条目名字再像，也是两码事**：台账里已有「AMA as1」，而我说的是「AMA2111 期中考试 11/1」→ 这是两条独立的事，输出 add；**绝不要**用 set_due 去改掉已有那条的日期（旧日期一旦被覆盖就找不回来了）。
- add 的 title 要能一眼区分：写清这是什么事（比如「AMA2111 期中考试」），不要照抄台账里已有条目的名字。
- 一句话里同时有 done 和 add 就输出两条操作；说不清的宁可不输出（我会看到"未识别"）。
- 「已读/看过了/不用管了/知道了/收到/已阅/搞定了」→ handled（针对"待你处理的重要邮件"里那一封）。
- 「这封很重要/改成红标/以后每天提醒我/别漏了」→ promote（id 必须来自「今日值得一看的邮件」，不能来自别处）。
- handled 只对「待你处理的重要邮件」有效；promote 只对「今日值得一看的邮件」有效，别搞混。
- handled 只销「待你处理的重要邮件」那一份清单，**绝不要**因此顺手输出 done：「待办台账」里的任务只有我明确说"做完了/交了"才能标完成。
- 正文是一句**纯回执**（只有"收到""已读"这类词、没有别的意思）时，输出 [{"op":"handled","all":true}]，表示清单里的重要邮件全部销掉。
- 只输出 JSON 数组，不要任何解释文字。`,
  // 批量：一次调用处理"其余邮件"压缩清单里的所有条目（几十条 → 1 次请求）
  batch: () => `你是学生的邮件助理。下面是一个 JSON 数组，每项代表一封邮件或一批同来源通知。
- kind="group"：subjects 是同一批发件人的多个邮件主题，用不超过 20 字的中文概括这批是什么（例如「作业评分通知」「图书馆开放时间与工作坊」）。
- kind="single"：把 subject 翻译成不超过 20 字的中文。
只输出一个 JSON 数组，每项形如 {"id": "原样照抄输入的 id", "zh": "中文"}，顺序与输入一致。
不要 markdown 代码块，不要任何解释文字。`,
};

async function deepseekTranslate(text, target, apiKey, model, kind = "translate") {
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || "deepseek-chat",
      temperature: 0,
      stream: false,
      messages: [
        { role: "system", content: (SYSTEM_PROMPTS[kind] || SYSTEM_PROMPTS.translate)(target) },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${detail.slice(0, 120)}`);
  }
  const data = await r.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("返回结果为空");
  return out.replace(/^["'「『]|["'」』]$/g, "").trim();
}

/**
 * 建立翻译器。
 * 返回 { translate(text), flush(), stats() }
 */
export function makeTranslator({ provider = "auto", target = "zh-CN", log = () => {}, concurrency = 3, useCache = true, kind = "translate" } = {}) {
  const cache = loadJson(CACHE_FILE, {});
  const secrets = loadSecrets();
  const stats = { hits: 0, miss: 0, fail: 0, skipped: 0 };
  let dirty = false;

  // 密钥文件存在却读不出内容，多半是 JSON 写坏了——明确报出来，别静默忽略
  if (fs.existsSync(SECRETS_FILE) && Object.keys(secrets).length === 0) {
    log(`翻译：${SECRETS_FILE} 存在但解析失败（JSON 格式有误？），已忽略`);
  }

  // auto：有 DeepSeek key 就用 DeepSeek（质量更好，且不经过 Google），否则退回 Google 免费接口
  if (provider === "auto") {
    provider = secrets.deepseekApiKey ? "deepseek" : "google";
  }
  if (provider === "none") {
    return { translate: async () => null, flush: () => {}, stats: () => ({ ...stats, provider: "none" }) };
  }
  // 行动摘要需要真正的 LLM，免费翻译接口做不到
  if (kind === "action" && provider !== "deepseek") {
    log(`行动摘要：需要 LLM（DeepSeek），当前 provider=${provider}，已跳过`);
    return { translate: async () => null, flush: () => {}, stats: () => ({ ...stats, provider, skippedAll: true }) };
  }
  if (provider === "deepseek" && !secrets.deepseekApiKey) {
    log("翻译：选了 deepseek 但 .state/secrets.json 里没有 deepseekApiKey，已退回 google");
    provider = "google";
  }
  const model = secrets.deepseekModel || "deepseek-chat";

  async function once(text) {
    if (provider === "deepseek") return deepseekTranslate(text, target, secrets.deepseekApiKey, model, kind);
    return googleTranslate(text, target);
  }

  async function translate(text) {
    if (isSkippable(text, kind)) { stats.skipped++; return null; }
    const key = crypto.createHash("sha1").update(`${provider}|${kind}|${target}|${text}`).digest("hex");
    if (useCache && cache[key]) { stats.hits++; return cache[key]; }
    try {
      const out = await once(text);
      if (useCache) { cache[key] = out; dirty = true; }
      stats.miss++;
      return out;
    } catch (e) {
      stats.fail++;
      log(`翻译失败（保留原文）：${e.message}`);
      return null;
    }
  }

  return {
    translate,
    ask: translate,        // 语义化别名：底层就是"给模型一段文本，拿回一段文本"
    flush: () => { if (dirty) saveJson(CACHE_FILE, cache); },
    stats: () => ({ ...stats, provider }),
  };
}

/** 限并发地跑一批翻译任务 */
export async function translateAll(items, translate, { concurrency = 3, gapMs = 120 } = {}) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      await job(translate);
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  });
  await Promise.all(workers);
}
