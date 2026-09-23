// 「待你处理的重要邮件」清单测试
//
// 关键设计：**不看已读/未读**（用户不靠标已读管理邮件），只认"用户回复说已读/搞定了"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { addPending, removeHandled, prunePending, listPending, toRenderable, dismiss } from "../lib/pending.mjs";
import fs from "node:fs";
import path from "node:path";
import { applyOps } from "../lib/commands.mjs";
import { ROOT } from "../lib/config.mjs";
import { buildDigest, shouldSend } from "../lib/digest.mjs";

const NOW = new Date("2026-09-21T12:00:00+08:00");
const mail = (id, subject, recv, conv) => ({
  id, conversationId: conv || id, subject, receivedDateTime: recv,
  from: { emailAddress: { name: "SAO Office", address: "sao@polyu.edu.hk" } },
  bodyPreview: "内容预览", rank: { why: "需要处理", bucket: "action" },
});

test("addPending：记入清单且幂等（同一封不会重复记）", () => {
  const list = [];
  assert.equal(addPending(list, [mail("M1", "诈骗提醒", "2026-09-17T02:00:00Z")], NOW), 1);
  assert.equal(list.length, 1);
  assert.equal(addPending(list, [mail("M1", "诈骗提醒", "2026-09-17T02:00:00Z")], NOW), 0, "重复的不该再加");
  assert.equal(list.length, 1);
  assert.equal(list[0].why, "需要处理");
});

test("removeHandled：支持按邮件 id、线程 id、标题片段、发件人名字销掉", () => {
  const list = [];
  addPending(list, [
    mail("M1", "Phone scam warning", "2026-09-17T02:00:00Z", "C1"),
    mail("M2", "Library book due", "2026-09-18T02:00:00Z", "C2"),
    mail("M3", "Assignment 3", "2026-09-19T02:00:00Z", "C3"),
  ], NOW);

  assert.equal(removeHandled(list, ["M1"]).removed.length, 1);
  assert.equal(removeHandled(list, ["C2"]).removed[0].id, "M2");
  assert.equal(removeHandled(list, ["Assignment 3"]).removed[0].id, "M3");
  assert.equal(removeHandled(list, ["SAO Office"]).removed.length, 3, "按完整发件人名可以批量销");
  assert.equal(removeHandled(list, ["SAO"]).removed.length, 0, "太短的名字（SAO/ELC 这种）不许批量销——否则回信里出现这三个字母就把该发件人的提醒全销了");
  assert.equal(removeHandled(list, ["对不上"]).removed.length, 0);
});

test("prunePending：超过 30 天还没销掉的自动移出（兜底防无限增长）", () => {
  const list = [];
  addPending(list, [
    mail("OLD", "很久以前", "2026-07-01T02:00:00Z"),
    mail("NEW", "最近", "2026-09-20T02:00:00Z"),
  ], NOW);
  const kept = prunePending(list, NOW, 30);
  assert.deepEqual(kept.map((i) => i.id), ["NEW"]);
});

test("listPending：按收到时间倒序，并算出差几天", () => {
  const list = [];
  addPending(list, [
    mail("A", "早", "2026-09-18T02:00:00Z"),
    mail("B", "晚", "2026-09-20T02:00:00Z"),
  ], NOW);
  const shown = listPending(list, NOW);
  assert.deepEqual(shown.map((i) => i.id), ["B", "A"]);
  assert.equal(shown[0].daysAgo, 1);
  assert.equal(shown[1].daysAgo, 3);
});

test("toRenderable：变成能进日报的邮件对象，且分档固定为 action", () => {
  const list = [];
  addPending(list, [mail("M1", "诈骗提醒", "2026-09-17T02:00:00Z")], NOW);
  const r = toRenderable(list[0]);
  assert.equal(r.id, "M1");
  assert.equal(r.carryOver, true);
  assert.equal(r.rank.bucket, "action");
  assert.equal(r.from.emailAddress.name, "SAO Office");
  assert.ok(r.bodyPreview.includes("内容预览"));
});

test("handled 指令：只把邮件移出清单，**绝不**动台账里的任务（任务只能靠明确说做完才销）", () => {
  const list = [];
  addPending(list, [mail("M1", "Phone scam warning", "2026-09-17T02:00:00Z", "CONV-1")], NOW);
  const ledger = { version: 1, items: [
    { key: "c:CONV-1", status: "open", title: "诈骗提醒", due: null, firstSeen: "2026-09-17T00:00:00Z", lastSeen: "2026-09-17T00:00:00Z" },
    { key: "c:CONV-9", status: "open", title: "别的事", due: null, firstSeen: "2026-09-17T00:00:00Z", lastSeen: "2026-09-17T00:00:00Z" },
  ] };
  const res = applyOps(ledger, [{ op: "handled", id: "M1" }], NOW, { pending: list });

  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].op, "handled");
  assert.equal(res.pending.length, 0, "清单里应被销掉");
  // 用户明确要求的语义：回一句"收到/已读"只销「重要提醒」那一半，
  // 台账里的任务是另一份清单，必须他说"做完了"才销。
  assert.equal(ledger.items.find((i) => i.key === "c:CONV-1").status, "open", "同线程的台账任务不该被自动完成");
  assert.equal(ledger.items.find((i) => i.key === "c:CONV-9").status, "open", "别的线程更不受影响");
});

test("handled 指令：找不到对应邮件时记入 failed，不静默忽略", () => {
  const res = applyOps({ version: 1, items: [] }, [{ op: "handled", id: "不存在" }], NOW, { pending: [] });
  assert.equal(res.applied.length, 0);
  assert.match(res.failed[0].reason, /找不到/);
});

// 守卫：只有保留邮件（零新邮件、台账 0 条）时也必须发送
//
// 为什么：日报的发送条件是"有新邮件 或 台账有待办"。保留邮件必须被算进总封数，
// 否则"没有新邮件 + 台账刚好清空 + 清单里还挂着一封重要邮件"的那天会**静默不发**，
// 重要邮件就此消失——正是用户抱怨的那个场景。
test("只有保留邮件时也必须发送（零新邮件 + 台账 0 条 → 仍要发）", () => {
  const carried = toRenderable({
    id: "A1", conversationId: "A1", subject: "Assignment 3 due Friday", fromName: "Prof. Chan",
    fromAddr: "chan@polyu.edu.hk",
    receivedDateTime: new Date(Date.now() - 3 * 86400000).toISOString(),
    preview: "请在周五前提交作业3", why: "作业截止",
  });
  const d = buildDigest([carried], { since: new Date(Date.now() - 86400000).toISOString(), until: new Date().toISOString(), todos: null });

  assert.equal(d.stats.total, 1, "保留邮件必须算进总封数");
  assert.equal(shouldSend({ totalMails: d.stats.total, pendingTodos: 0 }), true, "否则这天不会发送，重要邮件悄悄消失");
  assert.match(d.markdown, /待你处理/);
  assert.match(d.markdown, /3 天前/);
});

// 守卫：带出「待你处理」的那段必须写在 `if (TRANSLATE && messages.length)` **之外**
//
// 为什么：这段曾经被缩进到"今天有新邮件"的分支里，后果是——**零新邮件的那一天，
// 清单里所有重要邮件集体消失**（而那正是用户最需要看到提醒的情况）。
// 这类"位置放错"的 bug 纯逻辑单测抓不到，只能用源码结构守。
test("结构守卫：带出「待你处理」的代码必须在「今天有邮件」分支之外（否则零新邮件那天会整段消失）", () => {
  const src = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  const lines = src.split(/\r?\n/);

  const guardIdx = lines.findIndex((l) => l.trim() === "if (TRANSLATE && messages.length) {");
  const carryIdx = lines.findIndex((l) => l.trim() === 'if (!has("--no-carry-over")) {');
  assert.ok(guardIdx >= 0, "没找到 TRANSLATE 分支，测试本身失效了");
  assert.ok(carryIdx >= 0, "没找到带出「待你处理」的分支，测试本身失效了");
  assert.ok(carryIdx > guardIdx, "带出「待你处理」的分支应在分档/翻译分支之后");
  const indent = lines[carryIdx].match(/^\s*/)[0].length;
  assert.equal(indent, 2, `带出「待你处理」的分支缩进是 ${indent} 空格（第 ${carryIdx + 1} 行），像是又被塞回 TRANSLATE 分支里了`);

  const closedBetween = lines.slice(guardIdx + 1, carryIdx).some((l) => l === "  }");
  assert.ok(closedBetween, "TRANSLATE 分支在带出「待你处理」之前没有闭合，说明这段又被包进「今天有新邮件」里了");
});

// ===== 2026-09-23：两条防错 =====
test("dismiss：销掉的红标记进已忽略名单（幂等），并随清单一起存盘", () => {
  const d = {};
  assert.equal(dismiss(d, [{ id: "A" }, { id: "B" }], NOW), 2);
  assert.equal(dismiss(d, [{ id: "A" }], NOW), 0, "重复记不该再加");
  assert.equal(Object.keys(d).length, 2);
  assert.ok(d.A);
});



test("applyOps add：从邮件指令新增的待办也拿固定编号", () => {
  const ledger = { version: 1, items: [{ key: "c:X", status: "open", num: 3, title: "老的" }] };
  applyOps(ledger, [{ op: "add", title: "从邮件加的" }], NOW, { pending: [] });
  assert.equal(ledger.items.find((i) => i.title === "从邮件加的").num, 4);
});