// 邮件分类规则：判断哪些邮件"需要我行动"
//
// 设计要点（基于 2026-09-18 对真实 PolyU 邮箱 111 封邮件的校准）：
//   1. 先识别"硬性通知类"（如 Assignment graded = 已评分），直接压到低分——
//      这类邮件最容易被"作业/成绩"这类词误判成待办。
//   2. 识别"强个人信号"（要你回复/确认/提交、你自己的选课缴费、需你参加的测试、
//      图书到期等）——这些才是真正要找出来的。
//   3. 识别"机构群发"（Notice/SAO/Library/讲座/招募…）：如果只有群发特征而没有
//      个人信号，则**封顶在"值得一看"**，绝不进"需要你行动"。
// 这样行动区能保持很短（目标 5 分钟内看完），群发通知仍可在第二档看到。

// ---------- 1) 硬性通知类：命中就压到低分（不是待办）----------
// scope=subject 表示只匹配主题（如验证码：正文里顺带提到不算）
const NOTICE_ONLY = [
  { re: /(assignment|quiz|exercise|homework)?\s*[:：]?\s*graded|已评分|成绩已发布|grade\s*(released|posted|is\s*ready|available)/i, tag: "已出分（通知）", scope: "any" },
  { re: /(verification\s*code|one[- ]time\s*code|\botp\b|验证码)/i, tag: "验证码（通知）", scope: "subject" },
];

// ---------- 2) 强个人信号：命中即视为"真跟你有关" ----------
const PERSONAL = [
  { re: /(action\s+(required|needed)|please\s+(reply|respond|confirm|complete|submit|check|sign)|需要你|请回复|请确认|请完成|请检查|请尽快|请于.{0,12}前)/i, tag: "明确要求行动", score: 40 },
  { re: /(subject\s+registration|subject\s+selection|选课|学费|缴费|tuition|fee\s*due)/i, tag: "选课/缴费", score: 38 },
  { re: /(invitation\s+to\s+(take|complete|attend)|diagnostic\s+(english|test)|you\s+are\s+(required|invited)\s+to\s+take)/i, tag: "需你参加", score: 40 },
  { re: /(borrowed|overdue|renew\s+your|due\s+in\s+\d+\s+days|图书\s*到期|还书|超期)/i, tag: "图书到期", score: 35 },
  { re: /(interview\s+(invitation|invite|schedule|arrangement|slot)|invite[sd]?\s+you\s+to\s+(an\s+)?interview|面试\s*(通知|邀请)|online\s+assessment)/i, tag: "面试/笔试", score: 38 },
  { re: /(assign(ment)?\s*\d*\s*(is\s*)?now\s*(available|open)|new\s+assignment|assign(ment)?\s*\d*\s*(has\s+been\s+)?(released|posted|published))/i, tag: "新作业已发布", score: 38, scope: "subject" },
];

// ---------- 3) 一般动作关键词：用于排序，不足以单独进"行动区" ----------
const ACTION = [
  { re: /(assignment|homework|\bhw\b|coursework|term\s*paper|project\s*report|作业|习题|大作业|论文)/i, tag: "作业", score: 35 },
  { re: /(deadline|due\s*(date|by|on)?|submit|submission|截止|提交|上交)/i, tag: "截止/提交", score: 35 },
  { re: /(exam|quiz|midterm|final\s*exam|test\s*schedule|考试|测验|期中|期末|补考)/i, tag: "考试", score: 30 },
  { re: /(meeting\s*(invite|invitation|request)|invitation:|会议邀请|日程邀请|teams\s*meeting)/i, tag: "会议邀请", score: 30 },
  { re: /(reminder|提醒|即将到期|last\s*chance|final\s*(call|notice)|最后通知|最後)/i, tag: "催办提醒", score: 22 },
  { re: /(urgent|immediate|asap|紧急|尽快|务必)/i, tag: "时效性高", score: 25 },
  { re: /(offer|application\s*(status|received)|申请|录取|admission)/i, tag: "申请", score: 25 },
  { re: /(payment|invoice|bank|statement|账单|账单|缴费通知)/i, tag: "账单", score: 20 },
  { re: /(成绩|grade|transcript|result\s*release)/i, tag: "成绩", score: 18 },
  { re: /(scholarship|visa|签证|保险|insurance|体检|medical)/i, tag: "事务办理", score: 25 },
];

// ---------- 4) 机构群发特征 ----------
const BULK_SENDER = /(notice|notices|\bsao\b|library|career|election|senate|council|seminar|lecture|academy|research activities|student development|student organisation|counselling|\belc\b|\bcpeo\b|\blst\b|\bgeo\b|\bfeng\b|\baae\b|\bama\b|\bise\b|\brisud\b|\bu3dp\b|\bhso\b|\bcus\b|\bfhss\b|\bengl\b|\bapss\b|registry|uhnotice|canvas|events?|institutional|department|智齡匯)/i;
const BULK_MARKER = /(\[(re)?minder\]|\(re?minder\)|reminder\s*[:：]|\[register\s*now\]|\[enrol\s*now|\[open\s*for\s*application|\[invitation\]|invitation|series|highlights|weekly|newsletter|recruitment|招募|招生|现正招生|現正招生|seminar|lecture|workshop|campaign|call\s+for\s+applications|final\s*call|exhibition|orientation)/i;
const NOISE_SENDER = /(no[-_.]?reply|donotreply|do-not-reply|newsletter|notifications?@|marketing|mailer|updates?@|noreply)/i;
const UNSUBSCRIBE = /(unsubscribe|退订|newsletter|weekly\s*digest|促销|优惠|订阅)/i;

// ---------- 5) 「不用管」类：活动邀请 / 自愿参与 ----------
// 用户明确表示：讲座、工作坊、展览、迎新、招募、问卷这类不用提醒他做事。
// 注意它们不会消失，只是被压进末尾的"其余邮件"清单（那份清单已经按来源归并+中文标注）。
const EVENT_INVITE = /(invitation|you'?re invited|register\s*now|enrol\s*now|call\s+for\s+applications|orientation|cultural\s+night|workshop|exhibition|seminar|lecture|\btalk\b|concert|competition|info\s*day|open\s*day|活動|活动|讲座|講座|展览|展覽|工作坊|研討會|研讨会|報名|报名)/i;
const VOLUNTARY = /(recruit(ment|ing)?\s+(of\s+)?(participants|subjects|volunteers)|participants?\s+(wanted|recruitment|needed)|研究參與|參與研究|招募|問卷|问卷|\bsurvey\b|voluntary|自願參與|自愿参与)/i;
// 但"学校层面比较明显的活动"仍然值得看一眼（校庆、开学礼、毕业礼、升旗、全校性通知…）
const NOTABLE_EVENT = /(校慶|校庆|開學禮|开学礼|畢業禮|毕业礼|升旗|全校|典禮|典礼|commencement|anniversary|ceremony|重要通知|important\s+(event|notice))/i;

/**
 * 取"最终生效的分档结果"。
 * 如果这封邮件已经被 LLM 判过（m.rank 存在），就用 LLM 的结论；
 * 否则退回本地规则（API 不可用、调用失败、或显式选择 rules 模式）。
 * 下游（日报渲染、其余清单归并、待办分桶）都走这一个入口，避免两套判断打架。
 */
export function effectiveRank(m) {
  return m.rank || classify(m);
}

export function classify(msg) {
  const subject = msg.subject || "";
  const preview = (msg.bodyPreview || "").slice(0, 600);
  const sender = msg.from?.emailAddress?.address || "";
  const senderName = msg.from?.emailAddress?.name || "";
  const hay = `${subject}\n${preview}`;
  const senderHay = `${senderName} ${sender}`;

  let score = 0;
  let reasons = [];
  let personal = false;

  // 硬性通知类：命中即封顶到低分
  const notice = NOTICE_ONLY.find((r) => (r.scope === "subject" ? r.re.test(subject) : r.re.test(hay)));
  if (notice) {
    reasons.push(notice.tag);
    return { score: Math.min(15, msg.isRead ? 5 : 15), reasons: [...new Set(reasons)], bucket: "info", senderName, sender, ignored: true };
  }

  // 强个人信号（scope=subject 的规则只看主题，避免被正文字尾的样板文字命中）
  for (const r of PERSONAL) {
    const target = r.scope === "subject" ? subject : hay;
    if (r.re.test(target)) { score += r.score; reasons.push(r.tag); personal = true; }
  }

  // 一般动作关键词（累加，用于排序）
  for (const r of ACTION) {
    if (r.re.test(subject)) { score += r.score; reasons.push(r.tag); }
    else if (r.re.test(hay)) { score += Math.round(r.score * 0.6); reasons.push(r.tag); }
  }

  // 状态加权
  if (!msg.isRead) score += 12;
  if (msg.flag?.flagStatus === "flagged") { score += 20; reasons.push("你已标旗"); personal = true; }
  if (msg.importance === "high") { score += 15; reasons.push("高重要性"); }
  if (msg.hasAttachments) score += 5;
  const to = (msg.toRecipients || []).map((t) => t.emailAddress?.address || "");
  if (to.length === 1) score += 6;

  // 噪音惩罚
  const isNoise = NOISE_SENDER.test(sender);
  if (isNoise) score -= 25;
  if (UNSUBSCRIBE.test(hay)) score -= 30;

  const isBulk = BULK_SENDER.test(senderHay) || BULK_MARKER.test(subject);
  if (isBulk && !personal) { score = Math.round(score * 0.6); reasons.push("机构群发"); }
  if (isNoise && !personal) score = Math.min(score, 12);

  // 「不用管」类：活动邀请 / 自愿参与（招募、问卷、研究参与者…）
  // 只有确实跟你有关（personal）或是校级明显活动时才放过，否则一律压进"其余"
  const isInvite = EVENT_INVITE.test(subject) || EVENT_INVITE.test(hay);
  const isVoluntary = VOLUNTARY.test(hay);
  const isNotable = NOTABLE_EVENT.test(subject);
  let ignored = false;
  if ((isInvite || isVoluntary) && !personal && !isNotable) {
    score = Math.min(score, 16);
    ignored = true;
    reasons.push(isVoluntary ? "自愿参与（不用管）" : "活动邀请（不用管）");
  } else if (isNotable && !personal) {
    score = Math.max(score, 22);          // 校级活动保底进"值得一看"
    reasons.push("校级活动");
  }

  score = Math.max(0, Math.min(100, score));

  let bucket;
  if (personal) bucket = score >= 45 ? "action" : score >= 18 ? "watch" : "info";
  else if (isBulk) bucket = score >= 18 ? "watch" : "info";        // 群发封顶在 watch
  else bucket = score >= 45 ? "action" : score >= 18 ? "watch" : "info";

  return { score, reasons: [...new Set(reasons)], bucket, senderName, sender, bulk: isBulk, personal, ignored };
}

/** 一行摘要：先剥掉群发邮件的样板废话和追踪链接，再压平空白并截断 */
const BOILERPLATE = [
  /if\s+you\s+(could|can)\s*not\s+view\s+this\s+e-?mail[^<]*<[^>]*>/gi,
  /if\s+this\s+e-?mail\s+(is\s+)?not\s+displayed\s+correctly[^<]*<[^>]*>/gi,
  /please\s+click\s+here[^.]*if\s+you\s+are\s+unable\s+to\s+read[^.]*\./gi,
  /please\s+click\s+here[^.]*\./gi,
  /if\s+you\s+(are\s+)?(unable|cannot)\s+to?\s*(read|view)[^.]*\./gi,
  /caution:\s*this\s+e-?mail\s+is\s+not\s+originated\s+from\s+polyu\.?/gi,
  /do\s+not\s+click\s+links?\s+or\s+open\s+attachments?\s+unless[^.]*\.?/gi,
  /\S*\/track\/(viewMessage|click)\S*/gi,          // PolyU 群发邮件的追踪链接
  /https?:\/\/\S+/gi,
  /\b[\w.-]+\.(?:com|hk|org|net|edu|gov)(?:\/\S*)?/gi,   // 无协议的裸链接
  /[*_=~-]{4,}/g,
];

const meaningfulChars = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length;

export function oneLine(msg, max = 120) {
  let t = msg.bodyPreview || "";
  for (const re of BOILERPLATE) t = t.replace(re, " ");
  t = t.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^[\p{P}\p{S}\s]+/u, "").trim();   // 去掉开头的标点/符号残留

  // 剥完几乎没内容 = 这封邮件的预览本来就是链接/样板，别把 URL 当摘要糊上去
  if (meaningfulChars(t) < 12) {
    return msg.hasAttachments
      ? "（正文为邮件模板/链接，含附件，请看原文）"
      : "（正文为邮件模板/链接，无有效摘要）";
  }
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
