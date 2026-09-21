// 分档交给 LLM 之后的测试：优先用 LLM 结论、字段兼容、下游尊重 LLM 分桶
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveRank, classify } from "../lib/classify.mjs";
import { slimForRank } from "../lib/rank.mjs";
import { restMessages } from "../lib/threads.mjs";
import { buildDigest } from "../lib/digest.mjs";

const mk = (o) => ({
  subject: "", bodyPreview: "", isRead: true, importance: "normal", hasAttachments: false, webLink: "",
  from: { emailAddress: { name: "Someone", address: "s@polyu.edu.hk" } },
  toRecipients: [{ emailAddress: { address: "me@polyu.edu.hk" } }],
  receivedDateTime: "2026-09-19T01:00:00Z",
  flag: { flagStatus: "notFlagged" },
  ...o,
});

const llmRank = (bucket, why, score = 80) => ({
  bucket, score, why, source: "llm", reasons: [why], senderName: "Someone", sender: "s@polyu.edu.hk",
});

test("effectiveRank：有 LLM 结论就用 LLM 的，没有才退回本地规则", () => {
  // 规则会把这封判成 action（作业+截止+未读）
  const m = mk({ subject: "Assignment 3 submission deadline", isRead: false });
  assert.equal(classify(m).bucket, "action");
  assert.equal(effectiveRank(m).bucket, "action", "没有 m.rank 时应退回规则");

  // LLM 说它只是通知 → 以 LLM 为准
  m.rank = llmRank("info", "已评分通知，无需行动", 10);
  assert.equal(effectiveRank(m).bucket, "info");
  assert.equal(effectiveRank(m).source, "llm");
});

test("effectiveRank：LLM 把邀请类判成 action 时也以 LLM 为准（规则不再是最终裁判）", () => {
  const m = mk({ subject: "Invitation: English Drama Club Orientation", isRead: false });
  assert.equal(classify(m).bucket, "info", "规则会把邀请压进 info");
  m.rank = llmRank("action", "要求本周内回复是否出席", 70);
  assert.equal(effectiveRank(m).bucket, "action");
});

test("slimForRank：只保留判断需要的字段并截断，控制 token", () => {
  const m = mk({
    id: "ID-1", subject: "S".repeat(200), bodyPreview: "P".repeat(500),
    isRead: false, hasAttachments: true, flag: { flagStatus: "flagged" },
    from: { emailAddress: { name: "N".repeat(80), address: "a@b.c" } },
  });
  const s = slimForRank(m, 40);
  assert.equal(s.id, "ID-1");
  assert.equal(s.subject.length, 120);
  assert.equal(s.preview.length, 40);
  assert.equal(s.from.length, 40);
  assert.equal(s.unread, true);
  assert.equal(s.attach, true);
  assert.equal(s.flagged, true);
  assert.ok(!("bodyPreview" in s), "不应把原始字段整包发出去");
});

test("日报渲染：LLM 分档的邮件能正常显示理由与发件人（字段形状兼容）", () => {
  const m = mk({
    subject: "Last reminder: DELTA",
    rank: llmRank("action", "需在9月30日前完成测试", 88),
  });
  const d = buildDigest([m], { since: "2026-09-18T00:00:00Z", until: "2026-09-19T00:00:00Z" });
  assert.match(d.markdown, /## 🔴 需要你行动（1）/);
  assert.match(d.markdown, /需在9月30日前完成测试/);          // 理由来自 LLM 的 why
  assert.match(d.markdown, /发件人：Someone/);                  // 发件人不能被漏掉
  assert.match(d.markdown, /匹配度 88/);
});

test("日报渲染：规则分档（reasons 数组）仍照旧工作", () => {
  const m = mk({ subject: "Assignment 3 submission deadline", isRead: false });
  const d = buildDigest([m], { since: "2026-09-18T00:00:00Z", until: "2026-09-19T00:00:00Z" });
  assert.match(d.markdown, /为何重要：/);
  assert.ok(!d.markdown.includes("undefined"));
});

test("其余清单：按 LLM 的分档结果挑，而不是按规则", () => {
  // 规则会把这封判成 watch（截止词），LLM 判成 info → 它必须出现在"其余"里
  const m = mk({ conversationId: "C1", subject: "Extended application deadline: hostel booking" });
  const rulesBucket = classify(m).bucket;
  assert.equal(rulesBucket, "watch");
  m.rank = llmRank("info", "与我无关的住宿通知", 20);

  const r = restMessages([m], 12);
  assert.equal(r.actionCount, 0);
  assert.equal(r.watchTop.length, 0, "LLM 判成 info，就不该出现在第二档");
  assert.equal(r.rest.length, 1, "应落到其余清单");
});
