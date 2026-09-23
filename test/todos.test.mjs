// 待办台账测试：日期校验、归并去重、跨天带出、过期归档、渲染
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidDue, normalizeDue, makeKey, mergeItems, openItems, markDone, dueLabel,
} from "../lib/todos.mjs";
import { buildDigest } from "../lib/digest.mjs";

const NOW = new Date("2026-09-18T12:00:00+08:00");

test("isValidDue：只接受合法且在合理范围内的 ISO 日期", () => {
  assert.equal(isValidDue("2026-09-25", NOW), true);
  assert.equal(isValidDue("2026-09-25T10:00:00Z", NOW), false);   // 必须是纯日期
  assert.equal(isValidDue("26-09-25", NOW), false);
  assert.equal(isValidDue("2026-13-45", NOW), false);
  assert.equal(isValidDue("2035-01-01", NOW), false);             // 未来太远，多半是模型编的
  assert.equal(isValidDue("2019-01-01", NOW), false);             // 过去太久
  assert.equal(isValidDue(undefined, NOW), false);
  assert.equal(isValidDue(null, NOW), false);
});

test("normalizeDue：把中文/斜杠日期补成 ISO，垃圾输入返回 null", () => {
  assert.equal(normalizeDue("9月25日", NOW), "2026-09-25");
  assert.equal(normalizeDue("2026/9/25", NOW), "2026-09-25");
  assert.equal(normalizeDue("2026-09-25", NOW), "2026-09-25");
  assert.equal(normalizeDue("尽快", NOW), null);
  assert.equal(normalizeDue("", NOW), null);
  assert.equal(normalizeDue("2035/1/1", NOW), null);              // 仍然会被范围校验挡住
});

test("makeKey：同线程同键，无线程 id 时同主题同键", () => {
  assert.equal(makeKey("CONV-1", "任意主题"), makeKey("CONV-1", "另一个主题"));
  assert.equal(makeKey(null, "Assignment 1"), makeKey(null, "Assignment 1"));
  assert.notEqual(makeKey(null, "A"), makeKey(null, "B"));
});

test("mergeItems：新事项入账、重复提醒只更新不重复、已完成的不会被重新打开", () => {
  const ledger = { version: 1, items: [] };
  const r1 = mergeItems(ledger, [
    { key: "c:1", title: "选课确认", due: "2026-09-25", subject: "S1", source: "AR" },
    { key: "c:2", title: "DELTA 测试", due: null, subject: "S2", source: "ELC" },
  ], NOW);
  assert.deepEqual(r1, { added: 2, updated: 0 });
  assert.equal(ledger.items.length, 2);

  // 第二天又来一封同线程的提醒：应更新，不新增
  const r2 = mergeItems(ledger, [
    { key: "c:1", title: "选课确认与缴费", due: "2026-09-25", action: "登录 eStudent", subject: "S1", source: "AR" },
  ], new Date("2026-09-19T12:00:00+08:00"));
  assert.deepEqual(r2, { added: 0, updated: 1 });
  assert.equal(ledger.items.length, 2);
  assert.equal(ledger.items[0].title, "选课确认与缴费");
  assert.equal(ledger.items[0].firstSeen, NOW.toISOString());          // 首次时间保留
  assert.notEqual(ledger.items[0].lastSeen, NOW.toISOString());        // 最近一次被更新

  // 标记完成后再收到同线程提醒，不应重新打开
  markDone(ledger, "c:2", NOW);
  assert.equal(ledger.items[1].status, "done");
  mergeItems(ledger, [{ key: "c:2", title: "DELTA 测试", due: null }], new Date("2026-09-20T12:00:00+08:00"));
  assert.equal(ledger.items[1].status, "done");
});

test("mergeItems：后来才给出截止日期时会被补上", () => {
  const ledger = { version: 1, items: [] };
  mergeItems(ledger, [{ key: "c:9", title: "交作业", due: null }], NOW);
  assert.equal(ledger.items[0].due, null);
  mergeItems(ledger, [{ key: "c:9", title: "交作业", due: "2026-09-30" }], NOW);
  assert.equal(ledger.items[0].due, "2026-09-30");
});

test("openItems：按截止日升序，没日期的排后面，并算出剩余天数", () => {
  const ledger = { version: 1, items: [
    { key: "a", status: "open", title: "无期限事项", due: null, lastSeen: "2026-09-18T00:00:00Z" },
    { key: "b", status: "open", title: "下周", due: "2026-09-25", lastSeen: NOW.toISOString() },
    { key: "c", status: "open", title: "明天", due: "2026-09-19", lastSeen: NOW.toISOString() },
    { key: "d", status: "done", title: "已完成", due: "2026-09-19", lastSeen: NOW.toISOString() },
  ] };
  const { shown, total } = openItems(ledger, NOW, { limit: 10 });
  assert.equal(total, 3);
  assert.deepEqual(shown.map((i) => i.title), ["明天", "下周", "无期限事项"]);
  assert.equal(shown[0].daysLeft, 1);
  assert.equal(shown[1].daysLeft, 7);
  assert.equal(shown[2].daysLeft, null);
  assert.ok(!shown.some((i) => i.title === "已完成"));
});

test("openItems：过期太久自动归档为 expired，超出上限的只计数", () => {
  const ledger = { version: 1, items: [
    { key: "old", status: "open", title: "很久以前", due: "2026-06-01", lastSeen: NOW.toISOString() },
    { key: "k1", status: "open", title: "1", due: "2026-09-20", lastSeen: NOW.toISOString() },
    { key: "k2", status: "open", title: "2", due: "2026-09-21", lastSeen: NOW.toISOString() },
    { key: "k3", status: "open", title: "3", due: "2026-09-22", lastSeen: NOW.toISOString() },
  ] };
  const { shown, total, hidden } = openItems(ledger, NOW, { maxAgeDays: 30, limit: 2 });
  assert.equal(ledger.items.find((i) => i.key === "old").status, "expired");
  assert.equal(total, 3);
  assert.equal(shown.length, 2);
  assert.equal(hidden, 1);
});

test("openItems：默认一过期就删除（按用户要求「过了就删掉」），当天到期的仍保留", () => {
  const ledger = { version: 1, items: [
    { key: "y", status: "open", title: "昨天就该做完", due: "2026-09-17", lastSeen: NOW.toISOString() },
    { key: "t", status: "open", title: "今天到期", due: "2026-09-18", lastSeen: NOW.toISOString() },
    { key: "m", status: "open", title: "明天到期", due: "2026-09-19", lastSeen: NOW.toISOString() },
  ] };
  const { shown, total } = openItems(ledger, NOW);
  assert.equal(total, 2);
  assert.deepEqual(shown.map((i) => i.title), ["今天到期", "明天到期"]);
  assert.equal(ledger.items.find((i) => i.key === "y").status, "expired", "过期项应归档，不再出现在日报里");
  assert.ok(!shown.some((i) => i.daysLeft < 0), "不应再出现负数天数（已过期）");
});

test("openItems：没有截止日的事项，超过 15 天（默认）没再被提醒就归档", () => {
  const ledger = { version: 1, items: [
    { key: "fresh", status: "open", title: "刚记的", due: null, lastSeen: NOW.toISOString() },
    { key: "d14", status: "open", title: "挂了14天", due: null, lastSeen: "2026-09-04T12:00:00+08:00" },
    { key: "d16", status: "open", title: "挂了16天", due: null, lastSeen: "2026-09-02T12:00:00+08:00" },
  ] };
  const { shown, total } = openItems(ledger, NOW);
  assert.equal(total, 2, "14 天的还在，16 天的归档");
  assert.deepEqual(shown.map((i) => i.title).sort(), ["刚记的", "挂了14天"]);
  assert.equal(ledger.items.find((i) => i.key === "d16").status, "expired");
});

test("openItems：可以把 undatedMaxAgeDays 调大以保留更久", () => {
  const ledger = { version: 1, items: [
    { key: "stale", status: "open", title: "旧事项", due: null, lastSeen: "2026-09-01T00:00:00Z" },
  ] };
  assert.equal(openItems(ledger, NOW, { undatedMaxAgeDays: 60 }).total, 1);
});

test("dueLabel：没有截止日时显示「已挂 N 天」，而不是干巴巴的「无期限」", () => {
  assert.equal(dueLabel({ due: null, daysLeft: null, heldDays: 0 }), "今天新增");
  assert.equal(dueLabel({ due: null, daysLeft: null, heldDays: 1 }), "已挂 1 天");
  assert.equal(dueLabel({ due: null, daysLeft: null, heldDays: 12 }), "已挂 12 天");
  assert.equal(dueLabel({ due: null, daysLeft: null }), "无期限", "没算过 heldDays 时退回原文案");
});

test("dueLabel：今天/明天/还有 N 天/已过期 都说人话", () => {
  assert.equal(dueLabel({ due: "2026-09-18", daysLeft: 0 }), "9/18（今天到期）");
  assert.equal(dueLabel({ due: "2026-09-19", daysLeft: 1 }), "9/19（明天到期）");
  assert.equal(dueLabel({ due: "2026-09-25", daysLeft: 7 }), "9/25（还有 7 天）");
  assert.equal(dueLabel({ due: "2026-09-15", daysLeft: -3 }), "9/15（已过期 3 天）");
  assert.equal(dueLabel({ due: null, daysLeft: null }), "无期限");
});

test("markDone：支持按序号和按 key 前缀", () => {
  const ledger = { version: 1, items: [
    { key: "c:aaa", status: "open", title: "先到期", due: "2026-09-19", lastSeen: NOW.toISOString() },
    { key: "c:bbb", status: "open", title: "后到期", due: "2026-09-25", lastSeen: NOW.toISOString() },
  ] };
  assert.equal(markDone(ledger, "1", NOW).title, "先到期");            // 序号 1 = 最早到期
  assert.equal(markDone(ledger, "c:bbb", NOW).title, "后到期");        // 完整 key
  assert.equal(ledger.items.filter((i) => i.status === "done").length, 2);
  assert.equal(markDone(ledger, "不存在的引用", NOW), null);
});

test("日报渲染：有待办台账时出现「📌 待办台账」段落", () => {
  const m = {
    subject: "x", bodyPreview: "y", isRead: true, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "Someone", address: "a@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "you@your-university.edu" } }],
    receivedDateTime: "2026-09-18T01:00:00Z", flag: { flagStatus: "notFlagged" },
  };
  const d = buildDigest([m], {
    since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z",
    todos: { shown: [{ due: "2026-09-25", daysLeft: 7, title: "选课确认与缴费", action: "登录 eStudent 核对", source: "教务处", firstSeen: "2026-09-15T02:00:00Z" }], total: 1, hidden: 0 },
  });
  assert.match(d.markdown, /📌 待办台账（含往日未完成，共 1 条）/);
  assert.match(d.markdown, /9\/25（还有 7 天）\*\* · 选课确认与缴费/);
  assert.match(d.html, /📌 待办台账/);
  assert.match(d.html, /登录 eStudent 核对/);
});

test("日报渲染：没有待办时不出现空段落", () => {
  const m = {
    subject: "x", bodyPreview: "y", isRead: true, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "Someone", address: "a@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "you@your-university.edu" } }],
    receivedDateTime: "2026-09-18T01:00:00Z", flag: { flagStatus: "notFlagged" },
  };
  const d = buildDigest([m], { since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z" });
  assert.ok(!d.markdown.includes("待办台账"));
});

// 2026-09-21 评审发现：mergeItems 原来会无条件改写**已完成/已删除**的条目，
// 后果是用户自己在「待办管理.cmd」里改过的标题、截止日会被模型结果悄悄改回去。
test("mergeItems：已完成/已删除的条目不许被同线程的重复提醒改写", () => {
  const ledger = { version: 1, items: [
    { key: "c:C1", status: "done", title: "用户改过的标题", action: "用户改过的做法", due: "2026-10-01", dueText: "10/1", firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-09-01T00:00:00Z" },
    { key: "c:C2", status: "deleted", title: "用户说不做了", action: "", due: null, dueText: "", firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-09-01T00:00:00Z" },
    { key: "c:C3", status: "open", title: "旧标题", action: "", due: null, dueText: "", firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-09-01T00:00:00Z" },
  ] };
  const res = mergeItems(ledger, [
    { key: "c:C1", title: "模型给的标题", action: "模型给的做法", due: "2026-12-31", dueText: "12/31" },
    { key: "c:C2", title: "模型硬塞回来", action: "x", due: null, dueText: "" },
    { key: "c:C3", title: "新标题", action: "新做法", due: "2026-11-11", dueText: "11/11" },
  ], new Date("2026-09-21T12:00:00+08:00"));

  const done = ledger.items.find((i) => i.key === "c:C1");
  assert.equal(done.title, "用户改过的标题", "已完成的条目一个字都不许改");
  assert.equal(done.due, "2026-10-01");
  assert.equal(done.lastSeen, "2026-09-01T00:00:00Z", "lastSeen 也不许动");
  assert.equal(ledger.items.find((i) => i.key === "c:C2").title, "用户说不做了", "软删除的也不许复活");
  assert.equal(ledger.items.find((i) => i.key === "c:C3").title, "新标题", "未完成的照常更新");
  assert.equal(res.updated, 1, "只该算那条 open 的更新");
  assert.equal(res.added, 0);
});

// ===== 2026-09-23：两条防错 =====


test("mergeItems：新条目拿到固定编号 num（不再随日期重排）", () => {
  const ledger = { version: 1, items: [
    { key: "c:X", status: "open", num: 7, title: "老的", firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-09-01T00:00:00Z" },
  ] };
  mergeItems(ledger, [{ key: "c:Y", title: "新的" }], NOW);
  assert.equal(ledger.items.find((i) => i.key === "c:Y").num, 8, "应接着最大值往下发号");
});

