// 给"需要重点阅读"的邮件补上中文翻译（主题 + 一行摘要）
//
// 为什么要挑着翻：真实邮箱一天几十封，全翻会产生上百次请求；
// 而真正要读的是"需要你行动"和"值得一看"这两档，翻这两档就够看了。
// 摘要只翻正文预览的一行（已剥掉样板废话），请求体积小、速度快。
import { classify, effectiveRank, oneLine } from "./classify.mjs";
import { makeTranslator, translateAll } from "./translate.mjs";
import { isValidDue, normalizeDue, makeKey } from "./todos.mjs";
import { parseJsonArrayLoose, parseJsonLoose } from "./json.mjs";

export { parseJsonArrayLoose, parseJsonLoose };

/**
 * 给"其余邮件"压缩清单生成中文标签：**一次请求处理全部条目**（几十条 → 1 次调用）。
 * 分组条目得到一句概括（如「作业评分通知」），单封条目得到主题翻译。
 */
export async function labelCompact(compact, { provider = "auto", target = "zh-CN", log = () => {}, chunkSize = 25 } = {}) {
  if (!compact?.items?.length) return compact;
  const tr = makeTranslator({ provider, target, log, kind: "batch" });

  // 切块调用：一次塞几十条时模型容易返回无法解析的内容，按 25 条一批更稳
  for (let i = 0; i < compact.items.length; i += chunkSize) {
    const slice = compact.items.slice(i, i + chunkSize);
    const payload = JSON.stringify(slice.map((it) => (it.kind === "group"
      ? { id: it.id, kind: "group", sender: it.sender, count: it.count, subjects: it.subjects }
      : { id: it.id, kind: "single", sender: it.sender, subject: it.subject })));

    const raw = await tr.ask(payload);
    if (!raw) { log(`清单标签第 ${Math.floor(i / chunkSize) + 1} 批：模型没有返回内容`); continue; }
    const arr = parseJsonArrayLoose(raw);
    if (!arr) {
      log(`清单标签第 ${Math.floor(i / chunkSize) + 1} 批：返回无法解析（原始长度 ${String(raw).length}），该批保留英文原主题`);
      continue;
    }
    const map = new Map(arr.map((o) => [String(o?.id ?? ""), String(o?.zh ?? "")]));
    let matched = 0;
    for (const it of slice) {
      const zh = map.get(it.id);
      if (zh) { it.zh = zh; matched++; } else if (!it.zh) { it.zh = ""; }
    }
    log(`清单标签第 ${Math.floor(i / chunkSize) + 1} 批：发送 ${slice.length} 条，返回 ${arr.length} 条，id 匹配上 ${matched} 条`);
  }

  tr.flush();
  const st = tr.stats();
  const labeled = compact.items.filter((i) => i.zh).length;
  const hiddenNote = compact.hidden ? `，另省略 ${compact.hidden} 条` : "";
  log(`清单归并(${st.provider})：${compact.totalMails} 封 → ${compact.totalItems} 条（本次展示 ${compact.items.length} 条${hiddenNote}，其中成组 ${compact.groupItems} 组），中文标签 ${labeled}/${compact.items.length}（缓存命中 ${st.hits} / 新生成 ${st.miss} / 失败 ${st.fail}）`);
  return compact;
}

/** 从模型输出里稳健地抠出 JSON（实现在 lib/json.mjs，这里只是转出以兼容旧引用） */

export async function addTranslations(messages, {
  provider = "google",
  target = "zh-CN",
  log = () => {},
  buckets = ["action", "watch"],
  concurrency = 3,
} = {}) {
  const tr = makeTranslator({ provider, target, log });
  const picked = messages.filter((m) => buckets.includes(effectiveRank(m).bucket));

  const jobs = [];
  for (const m of picked) {
    const line = oneLine(m);
    if (line) jobs.push(async (t) => { m.lineZh = await t(line); });
    if (m.subject) jobs.push(async (t) => { m.subjectZh = await t(m.subject); });
  }

  await translateAll(jobs, tr.translate, { concurrency });
  tr.flush();

  const stats = tr.stats();
  log(`翻译(${stats.provider})：待译邮件 ${picked.length} 封，命中缓存 ${stats.hits}，新译 ${stats.miss}，失败 ${stats.fail}，跳过(已中文/太短) ${stats.skipped}`);
  return { picked: picked.length, stats };
}

/**
 * 待办提取：让 LLM 读邮件，产出结构化事项（供台账累积）+ 一句「👉 要做什么」（供日报显示）。
 * 一次调用同时满足两个需求，不重复请求。
 *
 * 注意：日期一律经过 isValidDue/normalizeDue 校验，模型编造的日期会被丢掉。
 */
export async function extractTodos(messages, {
  provider = "auto",
  target = "zh-CN",
  log = () => {},
  buckets = ["action"],
  concurrency = 3,
  now = new Date(),
} = {}) {
  const tr = makeTranslator({ provider, target, log, kind: "todo" });
  const picked = messages.filter((m) => buckets.includes(effectiveRank(m).bucket));
  const items = [];

  const jobs = picked.map((m) => async (t) => {
    const subject = m.subject || "";
    const preview = (m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 1200);
    const sender = m.from?.emailAddress?.name || m.from?.emailAddress?.address || "";
    const prompt = `主题：${subject}\n发件人：${sender}\n正文摘要：${preview}`;

    const raw = await t(prompt);
    const obj = parseJsonLoose(raw);
    if (!obj) {
      log(`待办提取：返回内容无法解析，已跳过 → ${subject.slice(0, 40)}`);
      return;
    }
    if (obj.action) m.actionZh = String(obj.action).trim();
    if (obj.isAction === false) return;

    let due = null;
    if (isValidDue(obj.due, now)) due = obj.due;
    else due = normalizeDue(obj.dueText, now);
    if (obj.due && !due) {
      log(`待办提取：丢弃可疑日期 "${obj.due}"（${subject.slice(0, 30)}）`);
    }

    items.push({
      key: makeKey(m.conversationId, subject),
      title: String(obj.title || subject).slice(0, 60),
      action: String(obj.action || "").slice(0, 120),
      due,
      dueText: String(obj.dueText || "").slice(0, 40),
      subject,
      source: sender,
    });
  });

  await translateAll(jobs, tr.translate, { concurrency });
  tr.flush();

  const stats = tr.stats();
  if (stats.skippedAll) log("待办提取：未执行（需要 DeepSeek 这类 LLM）");
  else log(`待办提取(deepseek)：检查 ${picked.length} 封，得到事项 ${items.length} 条（命中缓存 ${stats.hits} / 新生成 ${stats.miss} / 失败 ${stats.fail}）`);
  return { picked: picked.length, items, stats };
}
