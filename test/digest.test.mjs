// 日报渲染回归测试（重点：HTML 转义、分区计数、空邮件不炸）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { archiveBaseName, buildDigest, shouldSend } from "../lib/digest.mjs";
import { ROOT } from "../lib/config.mjs";

const mk = (o) => ({
  subject: "", bodyPreview: "", isRead: true, importance: "normal",
  hasAttachments: false, webLink: "",
  from: { emailAddress: { name: "Someone", address: "someone@polyu.edu.hk" } },
  toRecipients: [{ emailAddress: { address: "you@your-university.edu" } }],
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

// ---- 2026-10-02：空跑（--dry-run）不许覆盖当天那份**真**存档 ----
// 「跑一遍只读诊断.cmd」第 2 步就是 `--dry-run --hours 72`，而存档路径原本无条件写成
// digests\<今天>-digest.md —— 于是一次"只读诊断"会把当天的真日报存档换成 72 小时的诊断版，
// 过后想查"那天到底报了什么"就查不到了（2026-09-24 的存档已被测试发送覆盖过一次）。

test("存档文件名：正常运行仍是 <日期>-digest，空跑另存 .dry-run（不覆盖真存档）", () => {
  assert.equal(archiveBaseName("2026-10-02"), "2026-10-02-digest");
  assert.equal(archiveBaseName("2026-10-02", { dryRun: true }), "2026-10-02-digest.dry-run");
  assert.notEqual(archiveBaseName("2026-10-02"), archiveBaseName("2026-10-02", { dryRun: true }));
});

test("存档文件名：空跑件不会被救援工具当成正式存档（restore-from-archive 只认 <日期>-digest.md）", () => {
  const pattern = /^\d{4}-\d{2}-\d{2}-digest\.md$/;      // tools\restore-from-archive.mjs 的筛选式
  assert.ok(pattern.test(`${archiveBaseName("2026-10-02")}.md`), "正常存档必须被救援工具认得");
  assert.ok(!pattern.test(`${archiveBaseName("2026-10-02", { dryRun: true })}.md`), "空跑件混进救援扫描会污染台账");
});

test("结构守卫：main-outlook 的存档路径必须走 archiveBaseName（不许再硬编码真存档名）", () => {
  const src = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  assert.match(src, /archiveBaseName\(hkDate\(\), \{ dryRun: DRY_RUN \}\)/,
    "存档名必须由 archiveBaseName 决定；写死 ${hkDate()}-digest.md 会让 --dry-run 覆盖真存档");
  assert.ok(!/\$\{hkDate\(\)\}-digest\.md`/.test(src),
    "还残留硬编码的真存档名 —— 空跑会踩掉当天存档");
});

// ---- 2026-10-14：正文 20 封新邮件，顶上却写"这次收信后没有更新的邮件" ----
// 用户截图来问"这个没邮件的 bug 还没修好"。真实日志：18:45 那次已把覆盖点推到
// 10/14 09:48:14.903Z（= 最新那封 +1 秒），20:00 再跑时收件箱里最新还是同一封
// （09:48:13.903Z，就早这 1 秒）→ 判定"没同步完" → 收信+等 20 秒重读（都白跑）→
// 最后落到 info 分支写下这句。收信动作留着没问题，但这话在"正文有新邮件"时是自相矛盾。
const STALE_INFO_1014 = "这次收信后没有更新的邮件；收件箱里最新一封是 2026-10-14 09:48 UTC（约 2 小时前）。";

test("日报渲染：正文有新邮件时，不许再写'这次收信后没有更新的邮件'（10/14 真实数据）", () => {
  const many = Array.from({ length: 3 }, (_, i) => mk({ id: `M${i}`, subject: `校内通知 ${i + 1}` }));
  const d = buildDigest(many, {
    since: "2026-10-13T12:00:00Z", until: "2026-10-14T12:00:00Z", staleInfo: STALE_INFO_1014,
  });
  assert.ok(!d.markdown.includes("没有更新的邮件"), "正文列着新邮件，顶上不能说'没有更新的邮件'");
  assert.ok(!d.html.includes("没有更新的邮件"));
  assert.match(d.subject, /新邮件/);
});

test("日报渲染：真的 0 封新邮件时，这句必须保留（它就是为了解释'0 封'）", () => {
  const d = buildDigest([], {
    since: "2026-10-13T12:00:00Z", until: "2026-10-14T12:00:00Z", staleInfo: STALE_INFO_1014,
  });
  assert.match(d.markdown, /这次收信后没有更新的邮件/);
  assert.ok(d.html.includes("没有更新的邮件"));
});

test("日报渲染：只有「待你处理」带出来的旧邮件（0 封新邮件）→ 这句也要保留", () => {
  const carried = mk({ id: "C1", subject: "作业截止提醒", carryOver: true, receivedDateTime: "2026-10-10T01:00:00Z" });
  const d = buildDigest([carried], {
    since: "2026-10-13T12:00:00Z", until: "2026-10-14T12:00:00Z", staleInfo: STALE_INFO_1014,
  });
  assert.match(d.markdown, /待你处理/);
  assert.match(d.markdown, /这次收信后没有更新的邮件/, "带出来的旧邮件不算'新邮件'，0 封新邮件时这句要留着");
});

test("日报渲染：⚠️ 报警（staleNotice）不受影响 —— 有任何新邮件时也必须照常显示", () => {
  const many = [mk({ id: "M1", subject: "校内通知" })];
  const d = buildDigest(many, {
    since: "2026-10-13T12:00:00Z", until: "2026-10-14T12:00:00Z",
    staleNotice: "Outlook 本地缓存比服务器少 14 封（正在重新同步）。这份日报可能不完整 —— 确认 Outlook 联网后可以重跑一次。",
  });
  assert.match(d.markdown, /邮件可能没读全/);
});