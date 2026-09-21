// 主邮箱 / 发件账户的参数契约
//
// 背景：config.json 里的 mainMailbox 必须真的被用上——否则用户在向导里选了非默认邮箱，
// 程序却默默读默认账户，这正是配置契约最该避免的失效方式。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailboxArgs } from "../lib/bridge.mjs";

test("mailboxArgs：主邮箱为空 → 一个参数都不加（行为与旧版完全一致）", () => {
  assert.deepEqual(mailboxArgs({ account: "", from: "" }), []);
  assert.deepEqual(mailboxArgs({}), []);
  assert.deepEqual(mailboxArgs(), []);
});

test("mailboxArgs：主邮箱非空 → 读信用 -Account、发信也用同一个账户", () => {
  assert.deepEqual(mailboxArgs({ account: "me@uni.edu" }), ["-Account", "me@uni.edu"]);
  assert.deepEqual(mailboxArgs({ account: "me@uni.edu", from: "me@uni.edu" }),
    ["-Account", "me@uni.edu", "-From", "me@uni.edu"]);
});

test("mailboxArgs：只给发件账户时只加 -From（读信仍用默认账户）", () => {
  assert.deepEqual(mailboxArgs({ from: "send@uni.edu" }), ["-From", "send@uni.edu"]);
});