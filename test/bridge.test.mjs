// 主邮箱 / 发件账户的参数契约
//
// 背景：config.json 里的 mainMailbox 必须真的被用上——否则用户在向导里选了非默认邮箱，
// 程序却默默读默认账户，这正是配置契约最该避免的失效方式。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mailboxArgs } from "../lib/bridge.mjs";
import { ROOT } from "../lib/config.mjs";

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

// 桥接层源码守卫：-Dump 的"附加文件夹"契约。
//
// 为什么只能读源码守：这台机器/CI 里**没有 Outlook**，COM 那一段离线跑不起来；
// 而这一条恰恰是"指令邮件扫到 0 封"那个事故的修复点，不能没人看着。
// 行为层面另有离线验证：把 Add-WindowMail / Find-StoreSubFolder 的函数体抽出来喂假 COM 对象跑。
test("桥接层：-ExtraFolders 默认「重要,垃圾邮件」，附加文件夹的邮件带 folder 字段", () => {
  const src = fs.readFileSync(path.join(ROOT, "outlook-bridge.ps1"), "utf8");

  assert.match(src, /\[string\]\$ExtraFolders\s*=\s*'重要,垃圾邮件'/,
    "-ExtraFolders 的默认值必须正是「重要,垃圾邮件」（规则把外部来信分到那儿）");
  assert.match(src, /folder\s+=\s+\$Label/, "dump 里每封邮件都要带 folder 字段，Node 侧才判得了一致");
  assert.match(src, /-Label '收件箱'/, "收件箱的邮件也要显式标成「收件箱」");
  // 找不到的文件夹必须静默跳过（只写一行 stdout），绝不能因此让整次导出失败
  assert.match(src, /SKIPFOLDER\|/, "找不到的文件夹要写一行说明并跳过");
  assert.match(src, /EXTRAFOLDER\|/, "每个附加文件夹读了多少封要写出来，便于排查");

  const start = src.indexOf("function Find-StoreSubFolder");
  const end = src.indexOf("# -Account：");
  assert.ok(start > 0 && end > start, "没找到 Find-StoreSubFolder，测试本身可能失效了");
  const fn = src.slice(start, end);
  assert.ok(!/\bFail\b/.test(fn), "找文件夹的过程里不能调用 Fail（那会直接退出，连收件箱日报一起没了）");
  assert.ok(!/GetDefaultFolder/.test(fn),
    "必须在**正在读的那个存储**里找，不能退回 $ns.GetDefaultFolder（多账号时会跑去另一个邮箱）");
  assert.match(fn, /\.Parent/, "应从收件箱的父级（信息存储顶层）找起");
});