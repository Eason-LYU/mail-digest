// 「已报告名单」测试
//
// 为什么需要：窗口标准化成「前一天 20:00 → 现在」之后必然出现重叠
// （今天白天手动跑过、或昨晚跑晚了），同一批邮件会被再报一遍。
// 这份名单就是"别重复"的保险，同时**绝不能因为它在名单里而漏掉新邮件**。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATE_DIR } from "../lib/config.mjs";
import { loadReported, saveReported, filterUnreported, markReported } from "../lib/reported.mjs";

const TMP = path.join(STATE_DIR, "reported-test.json");

function fresh() { try { fs.rmSync(TMP, { force: true }); } catch { /* 没有就算了 */ } }
const mail = (id) => ({ id, subject: `邮件 ${id}` });

test("markReported + filterUnreported：报过的跳过，没报过的留下", () => {
  fresh();
  const reported = new Map();
  const mails = [mail("M1"), mail("M2"), mail("M3")];

  assert.equal(markReported(reported, [mails[0], mails[1]]), 2);
  const { kept, skipped } = filterUnreported(mails, reported);
  assert.deepEqual(kept.map((m) => m.id), ["M3"], "只有没报过的 M3 该留下");
  assert.equal(skipped, 2);
});

test("markReported：重复登记不会重复计数", () => {
  const reported = new Map();
  markReported(reported, [mail("M1")]);
  assert.equal(markReported(reported, [mail("M1")]), 0);
  assert.equal(reported.size, 1);
});

test("没有 id 的邮件永远保留（宁可重复，也不丢）", () => {
  const reported = new Map();
  const { kept } = filterUnreported([{ subject: "缺 id 的邮件" }], reported);
  assert.equal(kept.length, 1);
});

test("存盘 → 读回：名单能持久化（换进程也记得住）", () => {
  fresh();
  process.env.MAIL_REPORTED_FILE = TMP;
  const reported = new Map();
  markReported(reported, [mail("A"), mail("B")], new Date("2026-09-21T12:00:00Z"));
  saveReported(reported, new Date("2026-09-21T12:00:00Z"));

  const back = loadReported(new Date("2026-09-21T12:01:00Z"));
  assert.equal(back.size, 2);
  assert.ok(back.has("A") && back.has("B"));
  delete process.env.MAIL_REPORTED_FILE;
  fresh();
});

test("loadReported：超过 7 天的记录自动丢弃（名单不会无限长大）", () => {
  fresh();
  process.env.MAIL_REPORTED_FILE = TMP;
  const now = new Date("2026-09-21T12:00:00Z");
  saveReported(new Map([
    ["新", "2026-09-21T11:00:00Z"],
    ["旧", "2026-09-10T11:00:00Z"],
  ]), now);

  const back = loadReported(now);
  assert.ok(back.has("新"));
  assert.ok(!back.has("旧"), "8 天前的记录该丢掉");
  delete process.env.MAIL_REPORTED_FILE;
  fresh();
});

test("loadReported：文件不存在/坏了都不崩，当作空名单", () => {
  fresh();
  process.env.MAIL_REPORTED_FILE = TMP;
  assert.equal(loadReported().size, 0);
  fs.writeFileSync(TMP, "{ 这不是合法 JSON", "utf8");
  assert.equal(loadReported().size, 0);
  delete process.env.MAIL_REPORTED_FILE;
  fresh();
});

// ---- 2026-10-14 真实事故：同一批 20 封，18:45 和 20:00 各报了一遍 ----
// 根因：记录（markReported）当时**只跟着准点那次的过滤开关走**（if (DEDUPE) {...}），
// 于是非准点的那次（开机触发/手动）虽然把邮件发给了用户，却没进名单；
// 20:00 准点那次无从知道，又把同一批完整列了一遍，还顺手覆盖了当天的存档。

test("「已报告名单」：非准点那次报过的，准点那次就该跳过（10/14 场景）", () => {
  fresh();
  const day = [mail("A"), mail("B"), mail("C")];
  const reported = new Map();
  // 18:45 那次：不过滤（用户要看到当天全部），但**要记录**
  markReported(reported, day);
  // 20:00 那次：按名单过滤 → 一封都不该再列
  const { kept, skipped } = filterUnreported(day, reported);
  assert.equal(skipped, 3, "上午报过的三封，晚上必须被跳过");
  assert.equal(kept.length, 0);
  fresh();
});

test("结构守卫：报过的邮件要**每次正式发送都记**，不能只记准点那次", () => {
  const src = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  assert.match(src, /const RECORD = !FIXTURE && !HOURS_EXPLICIT;/,
    "要有一个独立的'要不要记名单'判定（别和准点过滤 DEDUPE 绑在一起）");
  assert.match(src, /if \(RECORD\) \{ markReported\(reported, messages, now\); saveReported\(reported, now\); \}/,
    "记录必须走 RECORD —— 2026-10-14 就是因为它跟着 DEDUPE 才重复报了一遍");
  assert.ok(!/if \(DEDUPE\) \{ markReported\(/.test(src),
    "不许退回'只有准点那次才记录'");
  assert.match(src, /const DEDUPE = NEAR_SCHEDULED/, "过滤仍然只认准点那次（手动跑要看到当天全部邮件）");
  assert.match(src, /if \(DEDUPE && messages\.length\)/, "过滤那半边的行为不变");
  // 记录必须发生在**发送成功之后**：发送失败时窗口起点不推进、下次要重报，
  // 那时若已经把邮件标成"报过"，重报就会被过滤掉 —— 那批邮件等于被永久错过。
  const sentAt = src.indexOf("已通过 Outlook 发送日报到");
  const recordAt = src.indexOf("if (RECORD) { markReported(");
  assert.ok(sentAt > 0, "没找到发送成功的日志，测试本身失效了");
  assert.ok(recordAt > 0, "没找到记录名单那一行，测试本身失效了");
  assert.ok(recordAt > sentAt, "必须在发送成功之后才记名单（发送失败时不能把邮件标成已报过）");
});
