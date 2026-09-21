// 「已报告名单」测试
//
// 为什么需要：窗口标准化成「前一天 20:00 → 现在」之后必然出现重叠
// （今天白天手动跑过、或昨晚跑晚了），同一批邮件会被再报一遍。
// 这份名单就是"别重复"的保险，同时**绝不能因为它在名单里而漏掉新邮件**。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../lib/config.mjs";
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
