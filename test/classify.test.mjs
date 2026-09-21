// 分类规则回归测试
// 运行: runtime\node.exe --test test\
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, oneLine } from "../lib/classify.mjs";

const mk = (o) => ({
  subject: "", bodyPreview: "", isRead: true, importance: "normal",
  hasAttachments: false,
  from: { emailAddress: { name: "Someone", address: "someone@polyu.edu.hk" } },
  toRecipients: [{ emailAddress: { address: "you@your-university.edu" } }],
  flag: { flagStatus: "notFlagged" },
  ...o,
});

const bucketOf = (o) => classify(mk(o)).bucket;

test("作业 + 截止日期 + 未读 + 高重要性 → action", () => {
  const o = mk({
    subject: "COMP1010 Assignment 3 submission deadline this Friday",
    bodyPreview: "please remember Assignment 3 must be submitted before 23:59 Friday",
    isRead: false, importance: "high", hasAttachments: true,
  });
  assert.equal(classify(o).bucket, "action");
  assert.equal(classify(o).score, 100);
  assert.ok(classify(o).reasons.includes("作业"));
});

test("中文教务通知（选课 + 缴费 + 尽快）→ action", () => {
  assert.equal(bucketOf({
    subject: "【教务处】2026/27 第一学期选课确认及学费缴纳提醒",
    bodyPreview: "请于 9 月 25 日前完成选课确认，并缴纳第一期学费，请尽快处理。",
    isRead: false,
    from: { emailAddress: { name: "教务处", address: "ar.notice@polyu.edu.hk" } },
  }), "action");
});

test("面试邀请 + 要求确认 → action", () => {
  assert.equal(bucketOf({
    subject: "Interview invitation: Summer Internship 2027 - Online Assessment",
    bodyPreview: "Please confirm your availability by replying to this email before 22 September.",
    isRead: false,
    flag: { flagStatus: "flagged" },
  }), "action");
});

test("图书到期提醒 → action（due 命中截止词）", () => {
  assert.equal(bucketOf({
    subject: "Library notice: your borrowed book is due in 3 days",
    bodyPreview: "Please return or renew it to avoid overdue fines.",
  }), "action");
});

test("会议邀请 + 要求确认时间 → action", () => {
  assert.equal(bucketOf({
    subject: "Meeting invitation: Final Year Project supervision meeting",
    bodyPreview: "Please confirm whether this time works for you, and bring your draft.",
    from: { emailAddress: { name: "Prof. Lee", address: "kayan.lee@polyu.edu.hk" } },
  }), "action");
});

test("营销/订阅邮件（含退订 + newsletter 发件人）→ info", () => {
  assert.equal(bucketOf({
    subject: "Weekly campus newsletter: 20% off at the canteen + events this week",
    bodyPreview: "Check out this week's events! Unsubscribe from this newsletter at any time. 优惠促销。",
    importance: "low",
    from: { emailAddress: { name: "Campus Life", address: "newsletter@polyu.edu.hk" } },
  }), "info");
});

test("银行对账单（donotreply 自动邮件）→ info", () => {
  assert.equal(bucketOf({
    subject: "Your monthly statement is ready",
    bodyPreview: "Your eStatement is now available. This is an automated message, do not reply.",
    hasAttachments: true,
    from: { emailAddress: { name: "Bank", address: "donotreply@example-bank.com" } },
  }), "info");
});

test("验证码邮件不该进「需要你行动」（过几分钟就失效，日报里没用）", () => {
  assert.notEqual(bucketOf({
    subject: "Your verification code",
    bodyPreview: "Your one-time verification code is 482913.",
    from: { emailAddress: { name: "Microsoft account team", address: "no-reply@microsoft.com" } },
  }), "action");
});

test("你手动标旗的邮件至少进「值得一看」", () => {
  const c = classify(mk({
    subject: "Some plain note from a classmate",
    bodyPreview: "let me know what you think",
    flag: { flagStatus: "flagged" },
  }));
  assert.equal(c.bucket, "watch");
  assert.ok(c.reasons.includes("你已标旗"));
});

test("已读 + 无关键词 + 群发列表 → info 低分", () => {
  const c = classify(mk({
    subject: "Re: group project slides",
    bodyPreview: "ok sounds good",
    toRecipients: [
      { emailAddress: { address: "you@your-university.edu" } },
      { emailAddress: { address: "b@connect.polyu.hk" } },
      { emailAddress: { address: "c@connect.polyu.hk" } },
    ],
  }));
  assert.equal(c.bucket, "info");
  assert.ok(c.score < 18);
});

test("分数永远落在 0..100", () => {
  const heavy = mk({
    subject: "URGENT action required: exam deadline submission payment 学费 紧急 请确认",
    bodyPreview: "urgent asap final notice 最后通知 验证码 作业 面试 选课",
    isRead: false, importance: "high", hasAttachments: true,
    flag: { flagStatus: "flagged" },
    from: { emailAddress: { name: "Prof", address: "prof@polyu.edu.hk" } },
  });
  const c = classify(heavy);
  assert.equal(c.score, 100);
  assert.ok(c.score <= 100 && c.score >= 0);
});

test("oneLine 压平空白并截断", () => {
  const m = mk({ bodyPreview: "line one\n\n   line two\t\twith   spaces " });
  assert.equal(oneLine(m), "line one line two with spaces");
  const long = mk({ bodyPreview: "x".repeat(300) });
  assert.equal(oneLine(long, 50).length, 50);
  assert.ok(oneLine(long, 50).endsWith("…"));
});

// ---------- 以下用例来自 2026-09-18 对真实 PolyU 邮箱 111 封邮件的校准 ----------

test("『Assignment graded』已评分通知不是待办（真实误判第一名）", () => {
  const c = classify(mk({
    subject: "Assignment graded: Post-class quiz 20260916 (Prof. Leung)",
    bodyPreview: "Your submission has been graded. Please check the feedback.",
    isRead: false,
    from: { emailAddress: { name: "PHYSICS II", address: "lms@polyu.edu.hk" } },
  }));
  assert.equal(c.bucket, "info");
  assert.ok(c.reasons.includes("已出分（通知）"));
  assert.ok(c.score <= 15);
});

test("真实数据：图书馆的讲座/资源通知不该进行动区（提到 library 不等于跟你有关）", () => {
  for (const subject of [
    "AI Computers at the Library: Your All-in-One AI Developer Hub",
    "[Library Workshops] AI Essentials for Students: From Basics to Practice",
    "Unlock Your Creativity at the Digital Makerspace+!",
  ]) {
    const c = classify(mk({
      subject, isRead: false,
      from: { emailAddress: { name: "Library Notice", address: "lib-notice@polyu.edu.hk" } },
    }));
    assert.notEqual(c.bucket, "action", subject);
  }
});

test("真实数据：职业展群发里提到 interviews 不该进行动区", () => {
  const c = classify(mk({
    subject: "Weekly Highlights on Government Career Fair 2026, Recruitment Talks and Interviews",
    bodyPreview: "Join our recruitment talks and on-site interviews. Register now.",
    isRead: false,
    from: { emailAddress: { name: "AAE Notice [AAE]", address: "aae.notice@polyu.edu.hk" } },
  }));
  assert.notEqual(c.bucket, "action");
});

test("真实数据：机构群发的活动邀请一律压进其余（不再占第二档）", () => {
  const c = classify(mk({
    subject: "(Reminder) [Schedule & Invitation for Nominations] Election of Student Members",
    bodyPreview: "Nomination deadline is approaching. Please refer to the schedule.",
    isRead: false,
    from: { emailAddress: { name: "Senate Election", address: "election@polyu.edu.hk" } },
  }));
  assert.equal(c.bucket, "info");
  assert.equal(c.ignored, true);
});

test("真实数据：选课注册提醒 + 必须参加的测试 + 新作业发布 → 进行动区", () => {
  assert.equal(classify(mk({
    subject: "(Reminder) Please check your latest subject registration record",
    isRead: false,
    from: { emailAddress: { name: "Subject Registration", address: "ar.notice@polyu.edu.hk" } },
  })).bucket, "action");

  assert.equal(classify(mk({
    subject: "Last reminder: Invitation to take the Diagnostic English Language Test",
    isRead: false,
    from: { emailAddress: { name: "ELC, Assessment Team", address: "elc@polyu.edu.hk" } },
  })).bucket, "action");

  assert.equal(classify(mk({
    subject: "Assignment 1 now available: INTRODUCTION TO AVIATION",
    isRead: false,
    from: { emailAddress: { name: "INTRODUCTION TO AVIATION", address: "lms@polyu.edu.hk" } },
  })).bucket, "action");
});

test("验证码只在主题里才算通知；正文顺带提到不影响其它判断", () => {
  assert.equal(bucketOf({ subject: "Your verification code" }), "info");
  // 主题是正经待办、正文里出现「验证码」二字 → 不应被压成通知
  const c = classify(mk({
    subject: "URGENT action required: exam deadline submission payment 学费 紧急 请确认",
    bodyPreview: "urgent asap final notice 最后通知 验证码 作业",
    isRead: false, importance: "high",
  }));
  assert.equal(c.bucket, "action");
  assert.ok(c.score > 15);
});

// ---------- 用户明确要求："邀请/测试这类不用管，校级明显活动处理一下" ----------

test("活动邀请（报名/讲座/工作坊）：不进行动区，并标记为已过滤", () => {
  for (const subject of [
    "[Register NOW] Unlock Your Future at the Government Career Fair",
    "[Enrol now!] “Vessels of Other Worlds”: A Talk by Wallace Chan",
    "[Library Workshops] AI Essentials for Students: From Basics to Practice",
    "Invitation: English Drama Club Orientation",
  ]) {
    const c = classify(mk({
      subject, bodyPreview: "Please click HERE to register.", isRead: false,
      from: { emailAddress: { name: "Notice [SAO]", address: "notice@polyu.edu.hk" } },
    }));
    assert.notEqual(c.bucket, "action", subject);
    assert.equal(c.ignored, true, subject);
  }
});

test("研究招募 / 问卷：不进行动区", () => {
  const c = classify(mk({
    subject: "招募普通话母语者参与故事理解与记忆实验",
    bodyPreview: "欢迎有意者报名参与本研究。", isRead: false,
  }));
  assert.notEqual(c.bucket, "action");
  assert.equal(c.ignored, true);
});

test("但『邀请你参加必须完成的测试』仍进行动区（personal 优先于过滤）", () => {
  assert.equal(classify(mk({
    subject: "Last reminder: Invitation to take the Diagnostic English Language Tracking Assessment (DELTA)",
    isRead: false,
    from: { emailAddress: { name: "ELC, Assessment Team", address: "elc@polyu.edu.hk" } },
  })).bucket, "action");
});

test("校级明显活动（校庆/典礼/升旗/全校通知）：不被过滤，保留在第二档", () => {
  const c = classify(mk({
    subject: "庆祝建校 85 周年校庆典礼 — 全校师生参加",
    bodyPreview: "诚邀全校师生出席校庆典礼。",
    isRead: true,
    from: { emailAddress: { name: "Institutional Planning", address: "ipa@polyu.edu.hk" } },
  }));
  assert.equal(c.ignored, false);
  assert.equal(c.bucket, "watch");
  assert.ok(c.reasons.includes("校级活动"));
});
