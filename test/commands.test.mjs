// 待办指令邮件测试：白名单识别、操作应用与二次校验、防重复
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCommandMail, applyOps, buildCommandPrompt, stripQuoted, isAckReply, processCommandMails } from "../lib/commands.mjs";
import { buildDigest } from "../lib/digest.mjs";
import { COMMAND_FROM, DIGEST_TO } from "../lib/config.mjs";

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
  const opts = { from: [DIGEST_TO.toLowerCase(), "you@163.com"], markers: ["待办", "todo", "task", "任务", "ddl", "邮件日报", "待办提醒", "📬"] };
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
  // 大小写和空格都要容忍（用配置里的收件人，避免把某个具体地址写死在测试里）
  assert.equal(isCommandMail(mk({ subject: "待办", from: { emailAddress: { address: ` ${DIGEST_TO.toUpperCase()} ` } } }), opts), true);
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
  assert.match(d.markdown, /🔁 改期：参加DELTA英语评估 → 2026-09-30/);
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
  const real = "CAUTION: This email is not originated from PolyU. Do not click links or open attachments unless you recognize the sender and know the content is safe. 已读 ---- 回复的原邮件 ---- 发件人 Student Name [Student]<you@your-university.edu> <mailto:you@your-university.edu> 发送日期 2026年09月21日 18:46 主题 邮件日报 2026/09/21 · 2 封新邮件 统计窗口 09/21 16:46 → 09/21 18:46 待办台账（含往日未完成，共 5 条） 9/24（还有 3 天） · AAE2004 TM2009 as1";
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
