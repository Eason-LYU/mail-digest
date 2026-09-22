// 日报渲染回归测试（重点：HTML 转义、分区计数、空邮件不炸）
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, shouldSend } from "../lib/digest.mjs";

const mk = (o) => ({
  subject: "", bodyPreview: "", isRead: true, importance: "normal",
  hasAttachments: false, webLink: "",
  from: { emailAddress: { name: "Someone", address: "someone@polyu.edu.hk" } },
  toRecipients: [{ emailAddress: { address: "yixing.lyu@connect.polyu.hk" } }],
  receivedDateTime: "2026-09-18T01:00:00Z",
  flag: { flagStatus: "notFlagged" },
  ...o,
});

const META = { since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z", archiveName: "x.md" };

test("HTML 会转义邮件正文/主题里的尖括号和引号（防止把邮件模板撑坏）", () => {
  const d = buildDigest([mk({
    subject: '<script>alert("x")</script> & more',
    bodyPreview: 'a <b>bold</b> claim & "quoted"',
  })], META);
  assert.ok(!d.html.includes("<script>alert"), "不得出现未转义的 script 标签");
  assert.ok(d.html.includes("&lt;script&gt;"), "尖括号应被转义");
  assert.ok(d.html.includes("&amp;"), "& 应被转义");
});

test("三个分区计数与标题一致", () => {
  const msgs = [
    mk({ subject: "Assignment 2 deadline", isRead: false }),
    mk({ subject: "Meeting invitation: project sync", bodyPreview: "please confirm" }),
    mk({ subject: "casual hello", bodyPreview: "hi" }),
  ];
  const d = buildDigest(msgs, META);
  assert.equal(d.stats.total, 3);
  assert.match(d.markdown, /🔴 需要你行动（2）/);
  assert.match(d.markdown, /⚪ 其余（1）/);
  assert.match(d.html, /需要你行动（2）/);
});

test("空邮件：不崩、有兜底文案、统计全 0", () => {
  const d = buildDigest([], META);
  assert.deepEqual(d.stats, { total: 0, action: 0, watch: 0, info: 0, unread: 0, withAttach: 0 });
  assert.match(d.markdown, /今天没有明显需要行动的邮件/);
  assert.match(d.html, /今天没有明显需要行动的邮件/);
  assert.match(d.subject, /0 封新邮件/);
});

test("邮件按时间倒序排列", () => {
  const d = buildDigest([
    mk({ subject: "older", receivedDateTime: "2026-09-17T01:00:00Z" }),
    mk({ subject: "newer", receivedDateTime: "2026-09-17T20:00:00Z" }),
  ], META);
  assert.ok(d.markdown.indexOf("newer") < d.markdown.indexOf("older"));
});

test("归档文件名会被写进页脚", () => {
  const d = buildDigest([mk({ subject: "x" })], { ...META, archiveName: "2026-09-18-digest.md" });
  assert.ok(d.html.includes("2026-09-18-digest.md"));
});

// ---------- 仍未读的重要邮件：一直保留到你标为已读 ----------

test("待你处理清单：分项计数、主题标注、条目上有标记", () => {
  const old = mk({
    subject: "Urgent! Phone scam warning", isRead: false, carryOver: true,
    receivedDateTime: "2026-09-17T02:00:00Z",
    from: { emailAddress: { name: "SAO", address: "sao@polyu.edu.hk" } },
  });
  const fresh = mk({ subject: "New notice", receivedDateTime: "2026-09-18T02:00:00Z" });
  const d = buildDigest([fresh, old], { since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z" });

  assert.match(d.subject, /1 封新邮件（含 1 封待你处理）/);
  assert.match(d.markdown, /另保留 1 封待你处理的重要邮件/);
  // 天数基准改成"本次运行的时刻"后，跨零点重放不会飘；两种都接受（今天 / N 天前）
  assert.match(d.markdown, /🔁 待你处理（(今天|\d+ 天前)）/);
  assert.match(d.html, /🔁 待你处理/);
});

test("待你处理清单：没有新邮件但有保留的未读时，不发「无新邮件」主题", () => {
  const old = mk({
    subject: "Assignment 1 now available", isRead: false, carryOver: true,
    receivedDateTime: "2026-09-16T02:00:00Z",
  });
  const d = buildDigest([old], { since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z" });
  assert.match(d.subject, /📬 邮件日报/);
  assert.ok(!d.subject.includes("无新邮件"));
  assert.match(d.subject, /0 封新邮件（含 1 封待你处理）/);
});

test("待你处理清单：标为已读后（不再 carryOver）就不再出现标记", () => {
  const d = buildDigest([mk({ subject: "x", isRead: true })], { since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z" });
  assert.ok(!d.markdown.includes("待你处理"));
  assert.ok(!d.markdown.includes("待你处理"));
});

// ---------- 用户要求：没有新邮件、但有未完成待办时，仍然每天发（DDL 倒计时不能断）----------

test("shouldSend：有待办就必须发；两样都空才不发", () => {
  assert.equal(shouldSend({ totalMails: 5, pendingTodos: 0 }), true);
  assert.equal(shouldSend({ totalMails: 0, pendingTodos: 3 }), true, "没有新邮件但有未完成待办 → 必须发");
  assert.equal(shouldSend({ totalMails: 0, pendingTodos: 0 }), false, "两样都空 → 不发，避免纯噪音");
  assert.equal(shouldSend({ totalMails: 0, pendingTodos: 0, force: true }), true);
  assert.equal(shouldSend(), false);
});

test("没有新邮件但有台账时：主题变成「待办提醒」并带上最近截止日", () => {
  const d = buildDigest([], {
    since: "2026-09-18T20:00:00Z", until: "2026-09-19T12:00:00Z",
    todos: {
      total: 2, hidden: 0,
      shown: [
        { due: "2026-09-25", daysLeft: 6, title: "选课确认与缴费", action: "登录 eStudent", source: "教务处", firstSeen: "2026-09-15T02:00:00Z" },
        { due: null, daysLeft: null, title: "完成作业1", action: "", source: "课程", firstSeen: "2026-09-16T02:00:00Z" },
      ],
    },
  });
  assert.match(d.subject, /📬 待办提醒/);
  assert.match(d.subject, /无新邮件/);
  assert.match(d.subject, /最近 9\/25（还有 6 天）/);
  assert.match(d.markdown, /今天没有新邮件。这封只为提醒下面仍未完成的事项/);
  assert.match(d.html, /今天没有新邮件。这封只为提醒/);
  assert.match(d.markdown, /📌 待办台账（含往日未完成，共 2 条）/);
});

test("有新邮件时主题仍是常规的「邮件日报」", () => {
  const d = buildDigest([mk({ subject: "x" })], {
    ...META,
    todos: { total: 1, hidden: 0, shown: [{ due: "2026-09-25", daysLeft: 6, title: "t", action: "", source: "s", firstSeen: "2026-09-15T02:00:00Z" }] },
  });
  assert.match(d.subject, /📬 邮件日报/);
  assert.ok(!d.subject.includes("待办提醒"));
  assert.ok(!d.markdown.includes("今天没有新邮件。这封只为提醒"));
});

// 2026-09-22：用户要按"待办3删除"这种**日报里的编号**下指令，所以编号必须显示在日报上
test("日报渲染：待办台账每条都带序号（用户要用这个号下指令）", () => {
  const todos = { shown: [
    { key: "m:1", title: "甲", due: "2026-09-24", daysLeft: 3, source: "手动添加" },
    { key: "m:2", title: "乙", due: "2026-10-01", daysLeft: 10, source: "邮件指令" },
  ], total: 2, hidden: 0 };
  const m = { subject: "x", bodyPreview: "y", isRead: true, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "S", address: "s@polyu.edu.hk" } }, toRecipients: [{ emailAddress: { address: "me@polyu.edu.hk" } }],
    receivedDateTime: "2026-09-21T01:00:00Z", flag: { flagStatus: "notFlagged" } };
  const d = buildDigest([m], { since: "2026-09-20T00:00:00Z", until: "2026-09-21T00:00:00Z", todos });
  assert.match(d.markdown, /\[1\][\s\S]{0,40}甲/);
  assert.match(d.markdown, /\[2\][\s\S]{0,40}乙/);
  assert.ok(d.html.includes("[1]") && d.html.includes("[2]"), "邮件正文（HTML）里也要有编号");
});