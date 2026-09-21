// 翻译模块测试（不连网络，用桩函数）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { looksTranslatable, isSkippable, translateAll, makeTranslator, loadJson } from "../lib/translate.mjs";
import { STATE_DIR } from "../lib/config.mjs";
import { buildDigest } from "../lib/digest.mjs";

test("配置文件带 BOM 也能读（记事本保存常带 BOM，否则密钥会静默失效）", () => {
  const f = path.join(STATE_DIR, "bom-test.json");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ deepseekApiKey: "sk-from-notepad" }), "utf8");
  try {
    const obj = loadJson(f, {});
    assert.equal(obj.deepseekApiKey, "sk-from-notepad");
  } finally {
    fs.unlinkSync(f);
  }
});

test("JSON 坏掉时退回兜底值，不抛异常", () => {
  const f = path.join(STATE_DIR, "broken-test.json");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(f, "{ 这不是合法 JSON ", "utf8");
  try {
    assert.deepEqual(loadJson(f, { safe: true }), { safe: true });
  } finally {
    fs.unlinkSync(f);
  }
});

test("looksTranslatable：英文要译，中文不译，太短不译", () => {
  assert.equal(looksTranslatable("Assignment 1 now available"), true);
  assert.equal(looksTranslatable("关于选课注册与学费缴纳的重要通知"), false);
  assert.equal(looksTranslatable("作业 1 现已发布"), false);
  assert.equal(looksTranslatable("hi"), false);
  assert.equal(looksTranslatable(""), false);
  assert.equal(looksTranslatable(null), false);
});

test("translateAll：并发跑完所有任务，不丢不重", async () => {
  const done = [];
  const jobs = Array.from({ length: 10 }, (_, i) => async (t) => { done.push(i); await t("x"); });
  const stub = async (s) => `[${s}]`;
  await translateAll(jobs, stub, { concurrency: 3, gapMs: 0 });
  assert.equal(done.length, 10);
  assert.deepEqual([...done].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("provider=none 时一律返回 null（可彻底关闭翻译）", async () => {
  const tr = makeTranslator({ provider: "none" });
  assert.equal(await tr.translate("Assignment 1 now available"), null);
  tr.flush();
  assert.equal(tr.stats().provider, "none");
});

test("isSkippable：『已是中文』的启发式只能用于翻译，不能用于行动摘要", () => {
  const actionPrompt = "主题：Assignment 1 now available\n发件人：Course\n正文摘要：Dear Students, Assignment 1 has been uploaded.";
  // 翻译：中文过多 → 跳过
  assert.equal(isSkippable("关于选课注册与学费缴纳的重要通知", "translate"), true);
  // 行动摘要：输入是提示词，含中文标签也不该被跳过（曾经因此全部丢失）
  assert.equal(isSkippable(actionPrompt, "action"), false);
  assert.equal(isSkippable("", "action"), true);
  assert.equal(isSkippable(null, "translate"), true);
});

test("日报渲染：有行动摘要时出现「👉 要做什么」", () => {
  const m = {
    subject: "Last reminder: Invitation to take the DELTA",
    subjectZh: "最后提醒：邀请参加 DELTA",
    actionZh: "9月30日前完成 DELTA 英语测试，点邮件里的链接进入系统",
    bodyPreview: "Please complete it before 30 September.", lineZh: "请在9月30日前完成。",
    isRead: false, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "ELC", address: "elc@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "you@your-university.edu" } }],
    receivedDateTime: "2026-09-16T02:35:00Z",
    flag: { flagStatus: "notFlagged" },
  };
  const d = buildDigest([m], { since: "2026-09-15T00:00:00Z", until: "2026-09-16T00:00:00Z" });
  assert.match(d.markdown, /👉 \*\*要做什么：9月30日前完成 DELTA/);
  assert.match(d.html, /要做什么：<\/b>9月30日前完成 DELTA/);
});

test("日报渲染：没有行动摘要时不出现空的「要做什么」", () => {
  const m = {
    subject: "Plain note", bodyPreview: "hello there",
    isRead: true, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "Someone", address: "a@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "you@your-university.edu" } }],
    receivedDateTime: "2026-09-18T01:00:00Z",
    flag: { flagStatus: "notFlagged" },
  };
  const d = buildDigest([m], { since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z" });
  assert.ok(!d.markdown.includes("要做什么"));
});

test("日报渲染：有译文时出现「译：」和「原文：」两行", () => {
  const m = {
    subject: "Assignment 1 now available", subjectZh: "作业 1 现已发布",
    bodyPreview: "Dear Students, Assignment 1 has been uploaded.", lineZh: "同学们好，作业 1 已上传。",
    isRead: false, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "Course", address: "lms@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "you@your-university.edu" } }],
    receivedDateTime: "2026-09-18T01:00:00Z",
    flag: { flagStatus: "notFlagged" },
  };
  const d = buildDigest([m], { since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z" });
  assert.match(d.markdown, /译：作业 1 现已发布/);
  assert.match(d.markdown, /摘要：同学们好，作业 1 已上传。/);
  assert.match(d.markdown, /原文：Dear Students/);
  assert.match(d.html, /译：作业 1 现已发布/);
});

test("日报渲染：没有译文时保持原样，不出现空的「译：」", () => {
  const m = {
    subject: "Plain note", bodyPreview: "hello there",
    isRead: true, importance: "normal", hasAttachments: false, webLink: "",
    from: { emailAddress: { name: "Someone", address: "a@polyu.edu.hk" } },
    toRecipients: [{ emailAddress: { address: "you@your-university.edu" } }],
    receivedDateTime: "2026-09-18T01:00:00Z",
    flag: { flagStatus: "notFlagged" },
  };
  const d = buildDigest([m], { since: "2026-09-17T00:00:00Z", until: "2026-09-18T00:00:00Z" });
  assert.ok(!d.markdown.includes("译："));
  assert.ok(!d.markdown.includes("原文："));
});
