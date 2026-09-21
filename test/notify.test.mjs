// 失败提醒测试（不真的弹窗：spawn 注入桩函数）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { failureText, writeFailureLog, notifyFailure, clearFailureNotice } from "../lib/notify.mjs";
import { STATE_DIR } from "../lib/config.mjs";

const WHEN = new Date("2026-09-18T12:00:00Z");

test("failureText：包含原因、怎么办、时间与说明，且是纯文本", () => {
  const t = failureText({
    when: WHEN, reason: "Outlook 读取失败（桥接退出码 2）",
    hint: "打开经典版 Outlook 确认能收发邮件", context: { "详细日志": "logs\\task.log" },
  });
  assert.match(t, /邮件日报运行失败/);
  assert.match(t, /原因：Outlook 读取失败/);
  assert.match(t, /怎么办：打开经典版 Outlook/);
  assert.match(t, /详细日志：logs\\task\.log/);
  assert.match(t, /自动删除/);            // 告诉用户问题修好后会自己消失
  assert.ok(t.includes("\r\n"), "应是 Windows 换行，记事本打开才正常");
});

test("failureText：没有 hint 时不出现空的『怎么办』", () => {
  const t = failureText({ when: WHEN, reason: "未知错误" });
  assert.ok(!t.includes("怎么办："));
});

test("writeFailureLog：按日期命名写到指定目录", () => {
  const dir = path.join(STATE_DIR, "notify-test");
  const p = writeFailureLog("hello", WHEN, dir);
  try {
    assert.ok(fs.existsSync(p));
    assert.match(path.basename(p), /^FAILURE-2026-09-18\.txt$/);
    assert.equal(fs.readFileSync(p, "utf8"), "hello");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notifyFailure：会调 notify.ps1（-Mode warn）并把失败详情文件传过去", () => {
  const calls = [];
  const dir = path.join(STATE_DIR, "notify-test2");
  const logs = [];
  const res = notifyFailure({
    reason: "发送失败", hint: "检查 Outlook", when: WHEN, spawn: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; },
    log: (m) => logs.push(m),
  });
  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "powershell.exe");
    assert.ok(calls[0].args.includes("-Mode"));
    assert.ok(calls[0].args.includes("warn"));
    assert.ok(calls[0].args.some((a) => String(a).endsWith(".ps1")));
    assert.ok(calls[0].args.some((a) => String(a).includes("FAILURE-")));
    assert.ok(res.file && fs.existsSync(res.file), "应留下失败记录文件");
  } finally {
    if (res.file) fs.rmSync(res.file, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notifyFailure：弹窗调用失败也不能抛异常（提醒失败不能拖垮主流程）", () => {
  const res = notifyFailure({
    reason: "测试", when: WHEN,
    spawn: () => { throw new Error("powershell 起不来"); },
    log: () => {},
  });
  assert.ok(res.file, "即使弹窗失败，失败记录仍应写下来");
  fs.rmSync(res.file, { force: true });
});

test("clearFailureNotice：成功运行时调 -Mode clear 清掉桌面旧提醒", () => {
  const calls = [];
  clearFailureNotice({ spawn: (cmd, args) => { calls.push(args); return { status: 0 }; } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("-Mode"));
  assert.ok(calls[0].includes("clear"));
});
