// 待办指令邮件测试：白名单识别、操作应用与二次校验、防重复
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isCommandMail, applyOps, buildCommandPrompt, stripQuoted, isAckReply, processCommandMails, resolveSeqRefs, parseQuotedNumbers, isInboxMail, splitByFolder, pickCommandMails } from "../lib/commands.mjs";
import { buildDigest } from "../lib/digest.mjs";
import { COMMAND_FROM, DIGEST_TO, ROOT } from "../lib/config.mjs";

const NOW = new Date("2026-09-21T12:00:00+08:00");

const FROM = { emailAddress: { name: "Me", address: "you@gmail.com" } };
const OTHER = { emailAddress: { name: "Spam", address: "someone@evil.com" } };
const mk = (o) => ({ subject: "", bodyPreview: "", id: "M1", from: FROM, ...o });
const baseLedger = () => ({
  version: 1,
  items: [
    { key: "c:AAA", status: "open", title: "完成并提交作业1", due: null, firstSeen: "2026-09-18T00:00:00Z", lastSeen: "2026-09-18T00:00:00Z" },
    { key: "c:BBB", status: "open", title: "参加DELTA英语评估", due: null, firstSeen: "2026-09-18T00:00:00Z", lastSeen: "2026-09-18T00:00:00Z" },
    { key: "c:CCC", status: "done", title: "已完成的事", due: null, firstSeen: "2026-09-18T00:00:00Z", lastSeen: "2026-09-18T00:00:00Z" },
  ],
});

test("默认白名单就是日报收件人（用环境变量覆盖时跳过）", () => {
  if (process.env.MAIL_COMMAND_FROM) return;      // 被环境变量覆盖，这条不适用
  assert.ok(COMMAND_FROM.includes(DIGEST_TO.toLowerCase()), "应包含日报收件人");
  assert.ok(COMMAND_FROM.every((a) => a === a.toLowerCase()), "白名单应统一小写，避免大小写漏判");
});

// ---------- 直接回复日报来下指令 ----------

test("回复日报也能被识别：主题 Re: 📬 邮件日报 … 且在白名单里", () => {
  const opts = { from: ["you@gmail.com", "you@163.com"], markers: ["待办", "todo", "task", "任务", "ddl", "邮件日报", "待办提醒", "📬"] };
  assert.equal(isCommandMail(mk({ subject: "Re: 📬 邮件日报 2026/09/21 · 3 封新邮件 · 1 项需行动" }), opts), true);
  assert.equal(isCommandMail(mk({ subject: "回复：📬 待办提醒 · 2026/09/21 · 无新邮件 · 最近 9/25" }), opts), true);
  assert.equal(isCommandMail(mk({ subject: "Re: 别的邮件" }), opts), false);
});

test("stripQuoted：只留你写的话，丢掉引用进来的整封日报", () => {
  const reply = [
    "作业1做完了，DELTA 改到 9月30日。",
    "",
    "在 2026-09-21 20:00，mail-digest 写道：",
    "> ## 📮 已按你的邮件更新台账（4 项）",
    "> - ✅ 完成：完成并提交作业1",
    "> ## 📌 待办台账（含往日未完成，共 2 条）",
    "> - 10/5（还有 14 天）· 把 FYP 进度报告发给导师",
  ].join("\n");
  const kept = stripQuoted(reply);
  assert.match(kept, /作业1做完了/);
  assert.ok(!kept.includes("待办台账"), "引用部分必须丢掉，否则模型会把旧内容当新指令");
  assert.ok(!kept.includes("✅ 完成"), "引用里的旧指令结果也必须丢掉");
});

test("stripQuoted：Gmail 风格引用头 / 原始邮件分隔线 / > 引用都能截断", () => {
  assert.equal(stripQuoted("新增：交报告\nOn Sep 21, 2026, digest wrote:\n> old").includes("old"), false);
  assert.equal(stripQuoted("新增：交报告\n------------------ 原始邮件 ------------------\n旧内容").includes("旧内容"), false);
  assert.equal(stripQuoted("新增：交报告\n发件人: mail-digest\n旧内容").includes("旧内容"), false);
  assert.equal(stripQuoted("   ").length >= 0, true);
});

test("buildCommandPrompt：喂给模型的是去引用后的正文", () => {
  const mail = {
    subject: "Re: 📬 邮件日报 2026/09/21",
    bodyPreview: "物理课前练习做完了\n\n在 2026-09-21 写道：\n> - 参考：AP10006 课前练习",
  };
  const p = JSON.parse(buildCommandPrompt(mail, baseLedger()));
  assert.match(p.邮件正文, /物理课前练习做完了/);
  assert.ok(!p.邮件正文.includes("AP10006"), "引用内容不应进入模型输入");
  assert.equal(p.当前未完成待办.length, 2);
});

test("isCommandMail：白名单 + 主题标记，两道闸都要过", () => {
  const opts = { from: ["you@gmail.com"], markers: ["待办", "todo"] };
  assert.equal(isCommandMail(mk({ subject: "待办更新" }), opts), true);
  assert.equal(isCommandMail(mk({ subject: "TODO list" }), opts), true);
  // 主题没标记 → 不认（避免把随手转发的邮件当指令）
  assert.equal(isCommandMail(mk({ subject: "随手转发的东西" }), opts), false);
  // 发件人不在白名单 → 即使标题像也不认（安全关键）
  assert.equal(isCommandMail(mk({ subject: "待办更新", from: OTHER }), opts), false);
  // 大小写与空格容错
  assert.equal(isCommandMail(mk({ subject: "待办", from: { emailAddress: { address: " YOU@Gmail.com " } } }), opts), true);
});

test("applyOps：done / add / set_due / delete 都能正确应用", () => {
  const ledger = baseLedger();
  const now = new Date("2026-09-21T12:00:00+08:00");
  const res = applyOps(ledger, [
    { op: "done", id: "c:AAA" },
    { op: "add", title: "交 FYP 进度报告", action: "发草稿给导师", due: "2026-10-05", dueText: "10月5日前" },
    { op: "set_due", id: "c:BBB", due: "2026-09-30", dueText: "改到9月30日" },
  ], now);

  assert.equal(res.applied.length, 3);
  assert.equal(res.failed.length, 0);
  assert.equal(ledger.items.find((i) => i.key === "c:AAA").status, "done");
  assert.equal(ledger.items.find((i) => i.key === "c:BBB").due, "2026-09-30");
  const added = ledger.items.find((i) => i.title === "交 FYP 进度报告");
  assert.ok(added && added.due === "2026-10-05");
  assert.equal(added.source, "邮件指令");

  // set_due 记录改期前后，便于日报显示
  const op = res.applied.find((x) => x.op === "set_due");
  assert.equal(op.from, null);
  assert.equal(op.to, "2026-09-30");
});

test("applyOps：引用不存在的待办 → 记入 failed，绝不乱改", () => {
  const ledger = baseLedger();
  const res = applyOps(ledger, [{ op: "done", id: "c:不存在" }], new Date());
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].reason, /找不到/);
  assert.equal(ledger.items.find((i) => i.key === "c:AAA").status, "open", "不应误伤其它待办");
});

test("applyOps：日期不合法 → 不改动并报告（宁可不动，不可乱改）", () => {
  const ledger = baseLedger();
  const res = applyOps(ledger, [{ op: "set_due", id: "c:BBB", due: "2035-01-01" }], new Date("2026-09-21T12:00:00+08:00"));
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 1);
  assert.equal(ledger.items.find((i) => i.key === "c:BBB").due, null);
});

test("applyOps：add 没有合法日期时仍然新增，只是不带截止日，并提示", () => {
  const ledger = baseLedger();
  const res = applyOps(ledger, [{ op: "add", title: "模糊的事", due: "随便什么时候" }], new Date());
  assert.equal(res.applied.length, 1);
  assert.equal(res.failed.length, 1, "日期不合法要被报告出来");
  assert.equal(ledger.items.find((i) => i.title === "模糊的事").due, null);
});

test("applyOps：不认识的指令计入 failed，不静默忽略", () => {
  const res = applyOps(baseLedger(), [{ op: "explode", id: "c:AAA" }], new Date());
  assert.equal(res.applied.length, 0);
  assert.match(res.failed[0].reason, /不认识/);
});

test("applyOps：delete 是软删除（保留数据，只改状态）", () => {
  const ledger = baseLedger();
  applyOps(ledger, [{ op: "delete", id: "c:BBB" }], new Date());
  assert.equal(ledger.items.find((i) => i.key === "c:BBB").status, "deleted");
  assert.equal(ledger.items.length, 3, "不真删数据");
});

test("buildCommandPrompt：把当前未完成待办（带 id）一起给模型，已完成的不给", () => {
  const p = JSON.parse(buildCommandPrompt({ subject: "待办更新", bodyPreview: "作业1做完了" }, baseLedger()));
  assert.equal(p.邮件主题, "待办更新");
  assert.equal(p.当前未完成待办.length, 2);
  assert.ok(p.当前未完成待办.some((i) => i.id === "c:AAA"));
  assert.ok(!p.当前未完成待办.some((i) => i.title === "已完成的事"));
});

test("日报渲染：出现「已按你的邮件更新台账」段落，含完成/新增/改期与未识别项", () => {
  const m = {
    subject: "x", bodyPreview: "y", isRead: true, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "S", address: "s@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "me@polyu.edu.hk" } }],
    receivedDateTime: "2026-09-21T01:00:00Z", flag: { flagStatus: "notFlagged" },
  };
  const d = buildDigest([m], {
    since: "2026-09-20T00:00:00Z", until: "2026-09-21T00:00:00Z",
    commands: {
      mails: 1,
      applied: [
        { op: "done", title: "完成并提交作业1" },
        { op: "add", title: "交 FYP 报告", due: "2026-10-05" },
        { op: "set_due", title: "参加DELTA英语评估", from: null, to: "2026-09-30" },
      ],
      failed: [{ op: "done", ref: "某件事", reason: "找不到对应待办" }],
    },
  });
  assert.match(d.markdown, /📮 已按你的邮件更新台账（3 项）/);
  assert.match(d.markdown, /✅ 完成：完成并提交作业1/);
  assert.match(d.markdown, /➕ 新增：交 FYP 报告（2026-10-05 到期）/);
  assert.match(d.markdown, /🔁 改期：参加DELTA英语评估 → 09\/30/);
  assert.match(d.markdown, /未识别 1 项/);
  assert.match(d.html, /已按你的邮件更新台账/);
});

test("日报渲染：没有指令邮件时不出现该段落", () => {
  const m = {
    subject: "x", bodyPreview: "y", isRead: true, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "S", address: "s@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "me@polyu.edu.hk" } }],
    receivedDateTime: "2026-09-21T01:00:00Z", flag: { flagStatus: "notFlagged" },
  };
  const d = buildDigest([m], { since: "2026-09-20T00:00:00Z", until: "2026-09-21T00:00:00Z" });
  assert.ok(!d.markdown.includes("已按你的邮件更新台账"));
});

// ---- 真实世界的两个坑（2026-09-21 实测踩到）----

test("stripQuoted：削掉 PolyU 门户给外部来信加的安全横幅（横幅和你写的话会挤在同一行）", () => {
  const real = "CAUTION: This email is not originated from PolyU. Do not click links or open attachments unless you recognize the sender and know the content is safe. 待办123都搞定了，加入9.24 AAE2004 TM2009 as1";
  const out = stripQuoted(real);
  assert.ok(!/CAUTION/i.test(out), "横幅必须被削掉，否则模型要读一堆废话");
  assert.match(out, /^待办123都搞定了/);
  assert.match(out, /AAE2004 TM2009 as1/);
});

test("stripQuoted：bodyPreview 里换行已被压成空格（整封是一行），仍要能截断引用", () => {
  // 真实样本：Gmail 网页回复 → 网关加横幅 → 换行被压平
  const real = "CAUTION: This email is not originated from PolyU. Do not click links or open attachments unless you recognize the sender and know the content is safe. 已读 ---- 回复的原邮件 ---- 发件人 Some One [Student]<you@your-university.edu> <mailto:you@your-university.edu> 发送日期 2026年09月21日 18:46 主题 邮件日报 2026/09/21 · 2 封新邮件 统计窗口 09/21 16:46 → 09/21 18:46 待办台账（含往日未完成，共 5 条） 9/24（还有 3 天） · AAE2004 TM2009 as1";
  const out = stripQuoted(real);
  assert.equal(out, "已读", "只该剩下你写的两个字");
  assert.equal(isAckReply(out), true, "这就是为什么必须削干净：否则被判成非回执，白白多调一次模型");
});

test("stripQuoted：Outlook 中文客户端的「---- 回复的原邮件 ----」也要能截断（多行版）", () => {
  const out = stripQuoted("已读\n\n---- 回复的原邮件 ----\n发件人 A <a@b.c>\n主题 日报\n待办台账 5 条");
  assert.equal(out, "已读");
});

test("stripQuoted：正向正文里有 From/在 这类词，不能被误当引用头截断", () => {
  const s = "加入 10.5 交 FYP 报告，From tomorrow 开始写，在图书馆写完";
  assert.equal(stripQuoted(s), s, "整句都要保留");
});

// ---- 「收到」也算销账（用户要求：已读 / 收到 都能作为删掉重要提醒的依据）----

test("isAckReply：识别各种一句话回执", () => {
  for (const s of ["收到", "收到了", "已收到", "收到！", "收到。", "OK", "ok!", "好的", "已读", "已阅",
    "搞定了", "都搞定了", "知道了", "谢谢", "辛苦了", "收到，谢谢", "OK 谢谢", "👍", "Done", "明白"]) {
    assert.equal(isAckReply(s), true, `「${s}」应该被认成回执`);
  }
});

test("isAckReply：只要夹带了别的事，就不算回执（绝不能误销账）", () => {
  for (const s of ["收到，但作业1还没做", "已读，另外帮我加一条 10/5 交 FYP", "作业1搞定了", "收到 请把 DELTA 改到 9/30",
    "第三章我读了但是没看懂", "", "   ", "这是一封很长的说明，说了很多别的事情，不应该被当成回执处理掉"]) {
    assert.equal(isAckReply(s), false, `「${s}」不该被认成回执`);
  }
});

test("applyOps：handled all → 「重要提醒」全部销掉，但台账里的任务一条都不许动", () => {
  const pending = [
    { id: "M1", conversationId: "C1", subject: "诈骗提醒" },
    { id: "M2", conversationId: "C2", subject: "宿舍检查" },
    { id: "M3", conversationId: null, subject: "无关线程的消息" },
  ];
  const ledger = { version: 1, items: [
    { key: "c:C1", status: "open", title: "警惕诈骗" },
    { key: "c:C2", status: "open", title: "配合宿舍检查" },
    { key: "c:C9", status: "open", title: "别的" },
  ] };
  const res = applyOps(ledger, [{ op: "handled", all: true }], NOW, { pending });

  assert.equal(res.pending.length, 0, "整封回执应把「重要提醒」清空");
  assert.equal(res.applied.length, 3, "每一封都要在日报里列出来（透明，不能悄悄销）");
  assert.ok(res.applied.every((a) => a.op === "handled" && a.all === true));
  // 「待你处理的重要邮件」和「待办台账」是两份清单：回"收到"只销前者。
  // 台账任务必须等用户明确说"做完了"（done）才销——不能替他判断。
  assert.equal(ledger.items.filter((i) => i.status === "open").length, 3, "台账里的任务一条都不该被自动完成");
});

test("applyOps：清单本来就是空的时候，handled all 记 failed 而不是假装成功", () => {
  const res = applyOps({ version: 1, items: [] }, [{ op: "handled", all: true }], NOW, { pending: [] });
  assert.equal(res.applied.length, 0);
  assert.match(res.failed[0].reason, /本来就是空的/);
});

test("processCommandMails：正文只写「收到」→ 不动用模型，直接销掉清单里的重要邮件", async () => {
  const pending = [
    { id: "P1", conversationId: "CC1", subject: "【测试】重要提醒", receivedDateTime: "2026-09-21T09:00:00Z" },
  ];
  const ledger = { version: 1, items: [{ key: "c:CC1", status: "open", title: "重要提醒" }] };
  const logs = [];
  const reply = {
    id: "R1", subject: "Re: 📬 待办提醒 · 2026/09/21 · 无新邮件 · 最近 9/24（还有 3 天）",
    bodyPreview: "收到\n\n在 2026年9月21日 写道：\n> 📬 待办提醒 …\n> ## 📌 待办台账",
  };
  const res = await processCommandMails([reply], { ledger, pending }, { log: (s) => logs.push(s) });

  assert.equal(res.pending.length, 0, "回执应把「重要提醒」销空");
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].op, "handled");
  assert.equal(ledger.items[0].status, "open", "台账里的任务必须留着——只有明确说'做完了'才销");
  assert.ok(logs.some((l) => l.includes("未动用模型")), "回执走的是代码直通，不该调用模型");
});

test("processCommandMails：回执但清单是空的 → 报出来，不崩", async () => {
  const logs = [];
  const res = await processCommandMails(
    [{ id: "R2", subject: "Re: 📬 邮件日报", bodyPreview: "已读" }],
    { ledger: { version: 1, items: [] }, pending: [] },
    { log: (s) => logs.push(s) },
  );
  assert.equal(res.applied.length, 0);
  assert.ok(logs.some((l) => l.includes("本来就是空的")));
});

// ---- 黄标 → 红标（用户要求的"把某封 service 从黄标改成红标"）----

const WATCH = [
  { id: "W1", conversationId: "CW1", subject: "【Service-Learning】Indication of interest from 12-14 October", from: { emailAddress: { name: "SLLO", address: "sllo.info@polyu.edu.hk" } }, receivedDateTime: "2026-09-21T02:00:00Z", bodyPreview: "SL subjects pre-selection", rank: { bucket: "watch", why: "学校活动", score: 60 } },
  { id: "W2", conversationId: "CW2", subject: "Library workshop: Using EndNote", from: { emailAddress: { name: "Library", address: "library.notice@polyu.edu.hk" } }, receivedDateTime: "2026-09-21T03:00:00Z", bodyPreview: "workshop", rank: { bucket: "watch", why: "讲座", score: 55 } },
];

test("applyOps：promote 把「值得一看」的黄标升级进「待你处理」（从此每天带出）", () => {
  const pending = [];
  const res = applyOps({ version: 1, items: [] }, [{ op: "promote", id: "W1" }], NOW, { pending, watch: WATCH });
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].op, "promote");
  assert.equal(res.pending.length, 1, "升级后应进清单");
  assert.equal(res.pending[0].id, "W1");
  assert.equal(res.pending[0].subject.includes("Service-Learning"), true);
});

test("applyOps：promote 也认标题片段（用户不会记得 id，会说「那个 service 的」）", () => {
  const res = applyOps({ version: 1, items: [] }, [{ op: "promote", subject: "Service-Learning" }], NOW, { pending: [], watch: WATCH });
  assert.equal(res.applied.length, 1);
  assert.equal(res.pending[0].id, "W1");
});

test("applyOps：promote 找不到 → 记 failed，绝不乱加", () => {
  const res = applyOps({ version: 1, items: [] }, [{ op: "promote", id: "不存在的东西" }], NOW, { pending: [], watch: WATCH });
  assert.equal(res.applied.length, 0);
  assert.match(res.failed[0].reason, /值得一看/);
  assert.equal(res.pending.length, 0);
});

test("applyOps：promote 已升级过的同一封 → 不重复加（幂等）", () => {
  const pending = [];
  applyOps({ version: 1, items: [] }, [{ op: "promote", id: "W2" }], NOW, { pending, watch: WATCH });
  const res = applyOps({ version: 1, items: [] }, [{ op: "promote", id: "W2" }], NOW, { pending, watch: WATCH });
  assert.equal(res.pending.length, 1, "还是 1 封");
  assert.equal(res.applied[0].already, true, "要如实告诉用户它本来就在清单里");
});

test("buildCommandPrompt：把今天的黄标清单也喂给模型（否则它没法把「那封」对上号）", () => {
  const p = buildCommandPrompt({ subject: "回复：日报", bodyPreview: "把那封 service 的改成红标" }, { version: 1, items: [] }, [], WATCH);
  const o = JSON.parse(p);
  assert.equal(o.今日值得一看的邮件.length, 2);
  assert.equal(o.今日值得一看的邮件[0].id, "W1");
  assert.ok(o.今日值得一看的邮件[0].subject.includes("Service-Learning"));
});
// 2026-09-22 真实事故：用户回信说「待办3，5，9删除」（日报里的编号），
// 但提示词里没有序号、模型自己猜位置 → 删错了一条。现在序号由**代码**解析。
test("resolveSeqRefs：把「序号」确定性地翻成 id（模型不许自己认人）", () => {
  const numbered = [
    { 序号: 1, id: "m:1", title: "甲" },
    { 序号: 2, id: "m:2", title: "乙" },
    { 序号: 3, id: "m:3", title: "丙" },
  ];
  const out = resolveSeqRefs([{ op: "delete", seq: 3 }, { op: "delete", 序号: 1 }, { op: "done", id: "m:2" }], numbered);
  assert.equal(out[0].id, "m:3");
  assert.equal(out[1].id, "m:1");
  assert.equal(out[2].id, "m:2", "原本就是 id 的不动");
  assert.equal(out[0].seq, undefined, "解析后要把 seq 去掉");
});

test("resolveSeqRefs：序号越界时标记出来，交给 applyOps 报未识别（绝不乱删）", () => {
  const out = resolveSeqRefs([{ op: "delete", seq: 99 }], [{ 序号: 1, id: "m:1" }]);
  assert.equal(out[0]._seqUnknown, 99);
  assert.equal(out[0].id, undefined);
});

test("buildCommandPrompt：带上序号（1..n），顺序与日报一致", () => {
  const numbered = [{ 序号: 1, id: "m:1", title: "甲", due: "2026-09-24" }, { 序号: 2, id: "m:2", title: "乙", due: null }];
  const o = JSON.parse(buildCommandPrompt({ subject: "回复：日报", bodyPreview: "待办1删除" }, { version: 1, items: [] }, [], [], numbered));
  assert.equal(o.当前未完成待办[0].序号, 1);
  assert.equal(o.当前未完成待办[1].id, "m:2");
});
// 用户 2026-09-23 的用法确认：序号跟着**最近那封日报**走。回复时引文里带着那封的编号，
// 所以按引文对齐，而不是按"处理时的清单位次"（中间新增/完成会让位次漂移）。
//
// ---------- 2026-10-08 真实事故 ----------
// 回信「删去待办1、2、3」本意是删那三条 10/7 到期的，结果程序删掉了当时恰好排前三位的
// **另外三条**（登录官网 / 选 service learning / AP 期中考试）。三个原因叠在一起：
//   1) 线上 bodyPreview 里换行已被压成空格（**整封是一行**），而 parseQuotedNumbers 按行解析
//      → 整段引文只匹配出 1 号一条，标题还把后面全吞了 → 编号 2、3 根本不存在；
//   2) 引文对不上时，resolveSeqRefs 仍然退回"当前清单位次" → 删错人；
//   3) 旧测试喂的是**多行**引文（下列格式），跟线上的一行纯文本不是一回事 → 测试全绿。
const OCT8 = new Date("2026-10-08T00:30:00+08:00");

/** 真实回信正文（bodyPreview 的形状：一行、末尾是客户端引用头 + 被引用的那封日报） */
const REAL_BODY = "CAUTION: This email is not originated from PolyU. Do not click links or open "
  + "attachments unless you recognize the sender and know the content is safe. 删去待办1、2、3 "
  + "---- 回复的原邮件 ---- 发件人 Some One [Student]<you@your-university.edu> 发送日期 "
  + "2026年10月07日 22:45 收件人 you@gmail.com 主题 📬 邮件日报 2026/10/07 · 10 封新邮件 · 0 项需行动 "
  + "📬 邮件日报 · 2026/10/07 统计窗口 10/06 20:00 → 10/07 22:45（香港时间） 📌 待办台账（含往日未完成，共 11 条） "
  + "[1] 10/7（今天到期） · AAE2004 AS1 手动添加 · 首次提醒 09/21 18:24 "
  + "[2] 10/7（今天到期） · 填写课程反馈表 通过邮件中的链接完成 Class Feedback Form 并提交 AAE Info [AAE] · 首次提醒 10/02 20:00 "
  + "[3] 10/7（今天到期） · 提交作业1 完成并提交 INTRODUCTION TO AVIATION SYSTEM AND AIR TRANSPORT REGULATION 的 Assignment 1 · 首次提醒 10/04 21:29 "
  + "[4] 10/8（明天到期） · 登录官网 登录官网 邮件指令 · 首次提醒 10/07 20:04 "
  + "[5] 10/12（还有 5 天） · 选 service learning 选 service learning 邮件指令 · 首次提醒 09/22 20:26";

test("parseQuotedNumbers：一行式引文也要把**每个**编号都抽出来（按行解析时只出得来 1 号）", () => {
  const m = parseQuotedNumbers(REAL_BODY);
  assert.deepEqual(Object.keys(m).sort(), ["1", "2", "3", "4", "5"], "编号 2..5 都必须解析出来");
  assert.match(m[1], /AAE2004 AS1/);
  assert.match(m[3], /提交作业1/);
  assert.match(m[5], /选 service learning/);
});

test("parseQuotedNumbers：不是回信（没有引用标记）时，不拿正文里的方括号当编号", () => {
  assert.deepEqual(parseQuotedNumbers("新增 [1] 买个键盘 10/9 到期"), {});
});

test("resolveSeqRefs：真实事故回放 —— 「删去待办1、2、3」必须对上 10/7 那三条，而不是当时排前面的另外三条", () => {
  // 处理那一刻的清单：10/7 那三条还在，但前三位是 10/8、10/12 的
  const numbered = [
    { 序号: 1, id: "cmd:LOGIN", title: "登录官网" },
    { 序号: 2, id: "cmd:SL", title: "选 service learning" },
    { 序号: 3, id: "cmd:AP", title: "AP 期中考试" },
    { 序号: 4, id: "m:AAE", title: "AAE2004 AS1" },
    { 序号: 5, id: "m:FB", title: "填写课程反馈表" },
    { 序号: 6, id: "m:A1", title: "提交作业1" },
  ];
  const quoted = parseQuotedNumbers(REAL_BODY);
  const ops = resolveSeqRefs(
    [{ op: "delete", seq: 1 }, { op: "delete", seq: 2 }, { op: "delete", seq: 3 }], numbered, quoted);
  assert.deepEqual(ops.map((o) => o.id), ["m:AAE", "m:FB", "m:A1"], "按引文对齐，删的是用户看到的那三条");
});

test("resolveSeqRefs：是回信但引文对不上 → 什么都不做（绝不退回当前位次）", () => {
  const numbered = [{ 序号: 1, id: "cmd:LOGIN", title: "登录官网" }];
  const out = resolveSeqRefs([{ op: "delete", seq: 1 }], numbered, {});   // 回信，但一条编号都没解析出来
  assert.equal(out[0].id, undefined, "不许退回当前位次");
  assert.equal(out[0]._seqUnknown, 1);
  assert.match(out[0]._seqWhy, /引文/);
});

test("applyOps：序号对不上时一条都不许改，并报未识别", () => {
  const ledger = { version: 1, items: [{ key: "cmd:LOGIN", status: "open", title: "登录官网", due: "2026-10-08" }] };
  const numbered = [{ 序号: 1, id: "cmd:LOGIN", title: "登录官网", due: "2026-10-08" }];
  const res = applyOps(ledger, resolveSeqRefs([{ op: "delete", seq: 1 }], numbered, {}), OCT8);
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].reason, /引文/);
  assert.equal(ledger.items[0].status, "open", "台账必须原封不动");
});

test("resolveSeqRefs：新邮件（没有引文）仍按当前清单位次解释，不受影响", () => {
  const numbered = [{ 序号: 1, id: "m:1", title: "甲" }, { 序号: 2, id: "m:2", title: "乙" }];
  const out = resolveSeqRefs([{ op: "delete", seq: 2 }], numbered, null);
  assert.equal(out[0].id, "m:2");
});

// 端到端：真实事故那条路径（模型给序号 → 代码按引文对齐 → 落到正确的三条）
test("processCommandMails：真实回信端到端只删对那三条", async () => {
  const items = [
    { key: "cmd:LOGIN", status: "open", title: "登录官网", due: "2026-10-08" },
    { key: "cmd:SL", status: "open", title: "选 service learning", due: "2026-10-12" },
    { key: "cmd:AP", status: "open", title: "AP 期中考试", due: "2026-10-12" },
    { key: "m:AAE", status: "open", title: "AAE2004 AS1", due: "2026-10-07" },
    { key: "m:FB", status: "open", title: "填写课程反馈表", due: "2026-10-07" },
    { key: "m:A1", status: "open", title: "提交作业1", due: "2026-10-07" },
  ];
  const ledger = { version: 1, items };
  const numbered = items.map((it, i) => ({ 序号: i + 1, id: it.key, title: it.title, due: it.due }));
  const stub = {
    ask: async () => JSON.stringify([{ op: "delete", seq: 1 }, { op: "delete", seq: 2 }, { op: "delete", seq: 3 }]),
    flush: () => {}, stats: () => ({ provider: "stub" }),
  };
  const mail = { id: "M1", subject: "回复：📬 邮件日报 2026/10/07 · 10 封新邮件 · 0 项需行动", from: FROM, bodyPreview: REAL_BODY };
  const res = await processCommandMails([mail], { ledger, pending: [], numbered }, { translator: stub, now: OCT8 });
  assert.deepEqual(ledger.items.filter((i) => i.status === "deleted").map((i) => i.title).sort(),
    ["AAE2004 AS1", "提交作业1", "填写课程反馈表"].sort());
  assert.equal(res.failed.length, 0);
  assert.equal(ledger.items.find((i) => i.key === "cmd:LOGIN").status, "open", "没被误删");
});

// 2026-10-08 的另一半：模型返回空操作时**不能静默**，否则用户以为指令没生效
test("processCommandMails：模型返回空操作 → 日报里要留一句（不再静默）", async () => {
  const stub = { ask: async () => "[]", flush: () => {}, stats: () => ({ provider: "stub" }) };
  const mail = { id: "M1", subject: "回复：📬 待办提醒 · 2026/10/08", from: FROM, bodyPreview: "添加待办 登录官网 10/8 到期" };
  const ledger = { version: 1, items: [] };
  const res = await processCommandMails([mail], { ledger, pending: [] }, { translator: stub, now: OCT8 });
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].reason, /没解析出可执行的操作/);
});

test("processCommandMails：空回信（只有引文、没写字）→ 不打扰", async () => {
  const stub = { ask: async () => "[]", flush: () => {}, stats: () => ({ provider: "stub" }) };
  const mail = { id: "M1", subject: "回复：📬 待办提醒 · 2026/10/08", from: FROM, bodyPreview: "---- 回复的原邮件 ---- 什么都没有写" };
  const res = await processCommandMails([mail], { ledger: { version: 1, items: [] }, pending: [] }, { translator: stub, now: OCT8 });
  assert.equal(res.failed.length, 0);
});

// ---------- 「加一个」绝不能被当成「改期」 ----------
// 2026-09-23 真实事故：AMA 期中考试通知（11/1）到了，我回信说"加一个"，
// 模型输出 set_due，已有任务「AMA as1」的 10/23 被直接覆盖成 11/1：
// 新任务没进来，旧日期还丢了。

const dueLedger = () => ({
  version: 1,
  items: [{ key: "m:AMA1", num: 6, status: "open", title: "AMA as1", due: "2026-10-23", firstSeen: "2026-09-18T00:00:00Z", lastSeen: "2026-09-18T00:00:00Z" }],
});

test("applyOps：说的是「加一个」时，即使模型给了 set_due，也新增一条而不是改掉旧日期", () => {
  const ledger = dueLedger();
  const res = applyOps(ledger, [{ op: "set_due", id: "m:AMA1", title: "AMA2111 期中考试", due: "2026-11-01" }], NOW,
    { text: "加一个：AMA2111 期中考试 11月1日", subject: "Re: 📬 邮件日报 2026/09/23" });
  assert.equal(ledger.items.find((i) => i.key === "m:AMA1").due, "2026-10-23", "已有任务的日期必须原封不动");
  const added = ledger.items.find((i) => i.title === "AMA2111 期中考试");
  assert.ok(added, "应新增一条任务");
  assert.equal(added.due, "2026-11-01");
  assert.equal(added.status, "open");
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].op, "add");
  assert.equal(res.applied[0].becauseAddIntent, true);
  assert.equal(res.applied[0].untouched, "AMA as1", "要报告哪条没被动过");
});

test("applyOps：我明确说「改期」时，set_due 照常执行并记下旧日期（可撤销）", () => {
  const ledger = dueLedger();
  const res = applyOps(ledger, [{ op: "set_due", id: "m:AMA1", due: "2026-11-01" }], NOW,
    { text: "AMA as1 改期到 11月1日", subject: "Re: 📬 邮件日报" });
  assert.equal(ledger.items[0].due, "2026-11-01");
  assert.equal(res.applied[0].op, "set_due");
  assert.equal(res.applied[0].from, "2026-10-23", "必须留下旧日期，用户才能改回来");
  assert.equal(ledger.items.length, 1, "改期不应该多出一条");
});

test("applyOps：既没说「加一个」也没说「改期」时，按模型给的操作走（不猜意图）", () => {
  const ledger = dueLedger();
  applyOps(ledger, [{ op: "add", title: "交 FYP 报告", due: "2026-10-05" }], NOW, { text: "记得交 FYP 报告 10月5日" });
  assert.equal(ledger.items.length, 2);
  assert.equal(ledger.items[0].due, "2026-10-23", "正牌 add 不会碰已有条目");
});

test("日报渲染：改期显示「旧日期 → 新日期」并附撤销原话", () => {
  const d = buildDigest([], {
    date: new Date("2026-09-23T20:00:00+08:00"),
    commands: { applied: [{ op: "set_due", title: "AMA as1", from: "2026-10-23", to: "2026-11-01" }], failed: [] },
  });
  assert.match(d.markdown, /🔁 改期：AMA as1　10\/23 → 11\/01/);
  assert.match(d.markdown, /改错了？回信写「↩️ AMA as1 改回 10\/23」即可撤销/);
  assert.match(d.html, /10\/23 → 11\/01/);
});

test("日报渲染：误判成新增的那条也给出撤销原话", () => {
  const d = buildDigest([], {
    date: new Date("2026-09-23T20:00:00+08:00"),
    commands: { applied: [{ op: "add", title: "AMA2111 期中考试", due: "2026-11-01", becauseAddIntent: true, untouched: "AMA as1" }], failed: [] },
  });
  assert.match(d.markdown, /撤销「AMA2111 期中考试」/);
});

// ---------- 邮件落在哪个文件夹：指令邮件在「重要 / 垃圾邮件」里也要认得，日报正文只列收件箱 ----------
//
// 真实事故：用户从手机回信下指令（"删去待办1，2"），PolyU(Exchange) 的规则把这类**外部来信**
// 分到「重要」文件夹 —— 桥接层只读收件箱时程序扫到 0 封，指令邮件永远执行不了。
// 修法：桥接层把「重要/垃圾邮件」里窗口内的邮件也追加进同一个 dump（每封带 folder 字段），
// 由 Node 侧分开使用：指令识别看**全部**，日报正文只看**收件箱**。

test("指令邮件落在「重要」文件夹里也能被识别（只看收件箱就是事故现场）", () => {
  const opts = { from: ["you@gmail.com"], markers: ["待办", "邮件日报"] };
  const dump = [
    mk({ id: "IN1", subject: "普通通知", folder: "收件箱" }),
    mk({ id: "IM1", subject: "Re: 📬 邮件日报 2026/09/24 · 删去待办1，2", folder: "重要" }),
    mk({ id: "JK1", subject: "特价促销", folder: "垃圾邮件" }),
  ];

  const found = pickCommandMails(dump, opts);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "IM1", "发到「重要」里的指令邮件必须被认出来");

  const { inbox } = splitByFolder(dump);
  assert.equal(inbox.length, 1);
  assert.equal(pickCommandMails(inbox, opts).length, 0, "只用收件箱识别 → 一封都认不出（这就是事故原因）");

  // 安全闸一点没放宽：即使在「重要」里，也必须是白名单发件人 + 主题含标记词
  assert.equal(pickCommandMails([{ ...dump[1], from: OTHER }], opts).length, 0, "非白名单发件人不认");
  assert.equal(pickCommandMails([{ ...dump[1], subject: "随便聊聊" }], opts).length, 0, "主题没有标记词不认");
});

test("日报正文不含附加文件夹的邮件（「重要/垃圾邮件」只用于识别指令）", () => {
  const mkDigestMail = (o) => ({
    id: "M0", subject: "s", bodyPreview: "b", isRead: true, importance: "normal",
    hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "S", address: "s@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "me@polyu.edu.hk" } }],
    receivedDateTime: "2026-09-24T01:00:00Z", flag: { flagStatus: "notFlagged" },
    ...o,
  });
  const dump = [
    mkDigestMail({ id: "IN1", subject: "【收件箱】作业通知", folder: "收件箱" }),
    mkDigestMail({ id: "IM1", subject: "【重要】外部来信", folder: "重要", rank: { bucket: "action", why: "需要你行动", score: 90 } }),
    mkDigestMail({ id: "JK1", subject: "【垃圾邮件】中奖通知", folder: "垃圾邮件", rank: { bucket: "action", why: "需要你行动", score: 90 } }),
  ];
  const meta = { since: "2026-09-23T12:00:00Z", until: "2026-09-24T12:00:00Z" };

  // 反向对照：整份 dump 直接交给渲染，这两封**会**出现在正文里 —— 证明"筛掉它们"的是 splitByFolder
  const all = buildDigest(dump, meta);
  assert.match(all.markdown, /【重要】外部来信/);
  assert.equal(all.stats.total, 3);

  const { inbox, extra } = splitByFolder(dump);
  assert.equal(extra.length, 2);
  const d = buildDigest(inbox, meta);
  assert.equal(d.stats.total, 1, "统计只算收件箱（附加文件夹不参与分档/统计）");
  assert.match(d.markdown, /【收件箱】作业通知/);
  assert.ok(!d.markdown.includes("【重要】外部来信"), "「重要」里的邮件不许进日报正文");
  assert.ok(!d.markdown.includes("【垃圾邮件】中奖通知"), "「垃圾邮件」里的更不许进");
  assert.ok(!d.html.includes("【重要】外部来信"), "HTML 版同样不许有");
  assert.ok(!d.html.includes("【垃圾邮件】中奖通知"));
});

test("旧 dump 缺少 folder 字段 → 按收件箱处理（向后兼容，不能因此把邮件弄丢）", () => {
  const legacy = { id: "L1", subject: "旧版桥接层导出的邮件" };        // 旧 dump 只导收件箱
  assert.equal(isInboxMail(legacy), true);
  assert.equal(isInboxMail({ folder: "" }), true);
  assert.equal(isInboxMail({ folder: "   " }), true);
  assert.equal(isInboxMail({ folder: "收件箱" }), true);
  assert.equal(isInboxMail({ folder: "重要" }), false);
  assert.equal(isInboxMail({ folder: "Junk Email" }), false, "别的名字一律不算收件箱");

  const { inbox, extra } = splitByFolder([legacy, { id: "X1", folder: "垃圾邮件" }]);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, "L1");
  assert.equal(extra.length, 1);
});

// 结构守卫：主脚本"接错线"这类 bug 单测抓不到（helpers 全绿，日报却还是把「重要」混进去）。
test("结构守卫：main-outlook 用全部邮件识别指令、日报只拿收件箱", () => {
  const src = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  assert.match(src, /splitByFolder\(allMails\)/, "必须先按 folder 把收件箱拆出来");
  assert.match(src, /pickCommandMails\(commandPool/, "指令识别必须用全部邮件（收件箱 + 附加文件夹）");
  const cmdLine = src.split(/\r?\n/).find((l) => l.includes("pickCommandMails("));
  assert.ok(cmdLine, "没找到 pickCommandMails 调用，测试本身失效了");
  assert.ok(!/pickCommandMails\(messages\b/.test(cmdLine), "用 messages（只有收件箱）就会漏掉「重要」里的指令邮件");
  assert.match(src, /buildDigest\(messages,/, "日报正文只能用 messages（= 收件箱 + 带出的待你处理）");
});

// ===== 2026-10-15 修复 =====

// 「回信视为我已看到」自动销红标时漏传 dismissed：dismiss() 写进临时对象被丢弃，
// 下次运行窗口还盖着那封邮件 → 红标复活。这里钉死：自动销账必须进 dismissed 名单。
test("processCommandMails：回信自动销掉红标时，必须记进 dismissed（否则下次运行复活）", async () => {
  const pending = [{ id: "P9", conversationId: "CX9", subject: "重要邮件", receivedDateTime: "2026-10-08T00:00:00Z" }];
  const dismissed = {};
  const stub = { ask: async () => "[]", flush: () => {}, stats: () => ({ provider: "stub" }) };
  const mail = { id: "M1", subject: "Re: 📬 邮件日报 2026/10/08", from: FROM, bodyPreview: "周报我明天再写" };
  const res = await processCommandMails([mail], { ledger: { version: 1, items: [] }, pending, dismissed }, { translator: stub, now: OCT8 });
  assert.equal(res.pending.length, 0, "回信后红标应被销掉");
  assert.ok(res.dismissed["P9"], "自动销掉的红标必须进 dismissed——主流程靠它挡住下次的重新加回");
});

// 结构守卫：主流程里每一次 -Dump 都必须带 account。
// 强制收信后那次重读曾漏传 { account: MAIN_MAILBOX }，会退回 Outlook 默认存储——
// 「缓存有没有同步完」的整套判断就落在了另一个邮箱的数据上。
test("结构守卫：main-outlook 里每一次 -Dump 都必须传 account", () => {
  const src = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  const dumpCalls = src.match(/runBridge\(\["-Dump"[\s\S]{0,160}?\}\)/g) || [];
  assert.ok(dumpCalls.length >= 3, `只找到 ${dumpCalls.length} 次 -Dump 调用，测试本身失效了`);
  for (const c of dumpCalls) {
    assert.ok(c.includes("account: MAIN_MAILBOX"), `-Dump 调用漏传 account：${c.slice(0, 100)}`);
  }
});

// 结构守卫：shouldHoldWindow 的 takenCount 必须只算收件箱（messages）。
// 用 allMails 时，附加文件夹里恰好有一封指令邮件就会让保护失效，
// 收件箱里没读到的邮件被覆盖点永久跳过。
test("结构守卫：shouldHoldWindow 的 takenCount 只算收件箱", () => {
  const src = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  assert.match(src, /shouldHoldWindow\(\{ takenCount: messages\.length/,
    "takenCount 必须是 messages.length（只算收件箱），不能是 allMails.length");
});

// ===== 同一类坑的通用守卫（2026-10-16 补）=====
// 上面那条 behavioral 测试只覆盖"自动销账"这一条路径；这里把**规则**钉死：
// 以后谁再新写一条带 handled 的 applyOps 调用而忘了 dismissed，CI 当场红。

test("结构守卫：凡是用 handled 销账的 applyOps 调用都必须传 dismissed（否则红标会复活）", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/commands.mjs"), "utf8");
  const calls = src.match(/applyOps\([\s\S]{0,260}?\}\)/g) || [];
  const handling = calls.filter((c) => c.includes("handled"));
  assert.ok(handling.length >= 2, `只在 applyOps 调用里找到 ${handling.length} 处 handled，测试本身失效了`);
  for (const c of handling) {
    assert.ok(c.includes("dismissed"),
      `这条 handled 调用漏了 dismissed：${c.replace(/\s+/g, " ").slice(0, 120)}`);
  }
});

test("结构守卫：main-outlook 要把 dismissed 取回来、并随 pending 一起落盘", () => {
  const src = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  assert.match(src, /dismissedList = res\.dismissed \?\? dismissedList/,
    "指令处理返回的 dismissed 必须取回来，否则记了也白记");
  assert.match(src, /savePending\(pendingList, dismissedList\)/,
    "保存清单时必须带上 dismissed，否则下次运行读不到、红标照样复活");
});