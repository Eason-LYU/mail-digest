// 其余邮件的压缩清单测试（归并策略：批发件人优先 → 主题家族 → 单条）
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSubject, subjectFamily, buildCompactItems, restMessages } from "../lib/threads.mjs";
import { buildDigest } from "../lib/digest.mjs";

const from = (name) => ({ emailAddress: { name, address: `${name.replace(/\W+/g, ".").toLowerCase()}@example.edu` } });

const mk = (o) => ({
  subject: "", bodyPreview: "", isRead: true, importance: "normal", hasAttachments: false,
  conversationId: undefined,
  from: from("Sender"),
  toRecipients: [{ emailAddress: { address: "me@example.edu" } }],
  receivedDateTime: "2026-09-18T01:00:00Z",
  flag: { flagStatus: "notFlagged" },
  ...o,
});

test("normalizeSubject：去掉回复/转发前缀与多余空白", () => {
  assert.equal(normalizeSubject("Re: Assignment 1"), "Assignment 1");
  assert.equal(normalizeSubject("RE: Fwd: 会议通知"), "会议通知");
  assert.equal(normalizeSubject("答复：作业"), "作业");
  assert.equal(normalizeSubject("转发: 通知"), "通知");
  assert.equal(normalizeSubject("[External] Library notice"), "Library notice");
  assert.equal(normalizeSubject("  多余   空格  "), "多余 空格");
  assert.equal(normalizeSubject(null), "");
});

test("subjectFamily：剥掉日期/编号/括号，让同类通知归到一起", () => {
  assert.equal(
    subjectFamily("Assignment graded: Post-class quiz 20260916"),
    subjectFamily("Assignment graded: Post-class quiz 20260914"),
  );
  assert.equal(
    subjectFamily("Assignment graded: Online Assignment 1 (Ch. 35, 36)"),
    subjectFamily("Assignment graded: Online Assignment 1 (Ch. 37, 38)"),
  );
  assert.notEqual(subjectFamily("Library hours"), subjectFamily("Library workshop"));
  assert.equal(subjectFamily("公告：9月25日截止"), subjectFamily("公告：10月8日截止"));
});

test("buildCompactItems：同一发件人 ≥3 封合成一条（这是真实邮箱里最有效的归并）", () => {
  const lib = from("Library Notice");
  const msgs = [
    mk({ conversationId: "L1", subject: "Library Hours During Mid-Autumn Festival", from: lib, receivedDateTime: "2026-09-18T09:00:00Z" }),
    mk({ conversationId: "L2", subject: "READ@PolyU: Meet the Author", from: lib, receivedDateTime: "2026-09-18T08:00:00Z" }),
    mk({ conversationId: "L3", subject: "[Library Workshops] AI Essentials", from: lib, receivedDateTime: "2026-09-18T07:00:00Z" }),
    mk({ conversationId: "S1", subject: "一封单独的邮件", from: from("Someone Else"), receivedDateTime: "2026-09-18T06:00:00Z" }),
  ];
  const c = buildCompactItems(msgs, { minGroupSize: 3 });
  assert.equal(c.totalMails, 4);
  assert.equal(c.totalItems, 2);
  assert.equal(c.groupItems, 1);
  assert.equal(c.items[0].kind, "group");
  assert.equal(c.items[0].count, 3);
  assert.equal(c.items[0].subjects.length, 3);
  assert.equal(c.items[1].kind, "single");
  assert.equal(c.items[1].subject, "一封单独的邮件");
});

test("buildCompactItems：发件人不足 3 封时按主题家族归并", () => {
  const prof = from("PHYSICS II");
  const msgs = [
    mk({ conversationId: "P1", subject: "Assignment graded: quiz 20260916", from: prof }),
    mk({ conversationId: "P2", subject: "Assignment graded: quiz 20260914", from: prof }),
    mk({ conversationId: "Z1", subject: "完全不同的另一件事", from: from("Another Sender") }),
  ];
  const c = buildCompactItems(msgs, { minGroupSize: 3, familyGroupSize: 2 });
  assert.equal(c.totalItems, 2);
  assert.equal(c.groupItems, 1);
  assert.equal(c.items.find((i) => i.kind === "group").count, 2);
  assert.equal(c.items.filter((i) => i.kind === "single").length, 1);
});

test("buildCompactItems：按最新时间倒序，超出上限只计数", () => {
  const msgs = [];
  for (let i = 0; i < 5; i++) {
    msgs.push(mk({
      conversationId: `X${i}`, subject: `通知 ${i}`, from: from(`Sender ${i}`),
      receivedDateTime: `2026-09-18T0${i}:00:00Z`,
    }));
  }
  const c = buildCompactItems(msgs, { limit: 3 });
  assert.equal(c.totalItems, 5);
  assert.equal(c.items.length, 3);
  assert.equal(c.hidden, 2);
  assert.equal(c.items[0].subject, "通知 4");    // 09:00 最新
});

test("restMessages：分出行动数、第二档前 N 条、以及其余部分（含第二档溢出）", () => {
  const msgs = [
    mk({ conversationId: "A", subject: "Assignment 1 deadline submission" }),                                              // action
    ...Array.from({ length: 14 }, (_, i) => mk({ conversationId: `W${i}`, subject: `Extended application deadline: hostel room booking ${i}` })),  // watch（截止 +35，未达行动阈值 45）
    ...Array.from({ length: 3 }, (_, i) => mk({ conversationId: `I${i}`, subject: `newsletter unsubscribe ${i}` })),        // info
  ];
  const r = restMessages(msgs, 12);
  assert.equal(r.actionCount, 1);
  assert.equal(r.watchTop.length, 12);
  assert.equal(r.rest.length, 2 + 3);     // 第二档溢出 2 条 + 其余 3 条
});

test("日报渲染：提供 compact 时用归并清单，且不再输出旧的逐封清单", () => {
  const d = buildDigest([mk({ subject: "x" })], {
    since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z",
    compact: {
      totalMails: 96, totalItems: 22, groupItems: 12, hidden: 0,
      items: [
        { id: "g:sender:library", kind: "group", count: 6, sender: "Library Notice", subjects: ["Library Hours"], zh: "图书馆开放时间、工作坊与活动", latest: "2026-09-18T01:00:00Z" },
        { id: "s:1", kind: "single", sender: "Notice, ELC", subject: "English Drama Club Orientation", zh: "英语戏剧社迎新会", latest: "2026-09-18T01:00:00Z" },
      ],
    },
  });
  assert.match(d.markdown, /其余邮件（共 96 封，已按来源归并为 22 条）/);
  assert.match(d.markdown, /\*\*6 封\*\* Library Notice — 图书馆开放时间、工作坊与活动/);
  assert.match(d.markdown, /English Drama Club Orientation（英语戏剧社迎新会） — Notice, ELC/);
  assert.match(d.html, /图书馆开放时间、工作坊与活动/);
  assert.ok(!d.markdown.includes("## ⚪ 其余（1）"), "有 compact 时不应再输出旧的逐封清单");
});

test("日报渲染：没有 compact 时保持旧的逐封清单（向后兼容）", () => {
  const d = buildDigest([mk({ subject: "newsletter unsubscribe" })], {
    since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z",
  });
  assert.match(d.markdown, /## ⚪ 其余（1）/);
  assert.ok(!d.markdown.includes("已按来源归并"));
});
