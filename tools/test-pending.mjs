// 「待你处理」清单的自测工具：造一条测试用的重要提醒 / 查看 / 清掉
//
// 用途：验证"我回复 收到（或 已读/搞定了）→ 这条重要提醒就被销掉"这条链路。
// 造出来的条目 id 以 TEST- 开头，绝不会和真实邮件的 id 撞上，也不会被真实邮件带出来。
//
// 用法：
//   runtime\node.exe tools\test-pending.mjs --add     造一条测试提醒
//   runtime\node.exe tools\test-pending.mjs --list    看清单里现在有什么
//   runtime\node.exe tools\test-pending.mjs --clear   清掉测试条目
import { loadPending, savePending } from "../lib/pending.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const TEST_SUBJECT = "【测试】重要提醒 — 回信「收到」即可销掉";
const isTest = (i) => String(i.id || "").startsWith("TEST-");

if (has("--list")) {
  const items = loadPending();
  if (!items.length) { console.log("  「待你处理」清单是空的。"); process.exit(0); }
  console.log(`  「待你处理」清单 ${items.length} 封：`);
  for (const i of items) {
    console.log(`   - [${isTest(i) ? "测试" : "真实"}] ${i.id.slice(0, 24)}… | ${i.subject}`);
  }
  process.exit(0);
}

if (has("--clear")) {
  const items = loadPending();
  const kept = items.filter((i) => !isTest(i));
  savePending(kept);
  console.log(`  [OK] 清掉 ${items.length - kept.length} 条测试条目，剩 ${kept.length} 封。`);
  process.exit(0);
}

// 默认 --add
const items = loadPending();
if (items.some(isTest)) {
  console.log("  已经有一条测试提醒了，不重复造。");
} else {
  const now = new Date();
  const tag = now.toISOString().replace(/[:.]/g, "-");
  items.push({
    id: `TEST-${tag}`,
    conversationId: `TESTCONV-${tag}`,
    subject: TEST_SUBJECT,
    fromName: "mail-digest 自测",
    fromAddr: "selftest@localhost",
    receivedDateTime: now.toISOString(),
    preview: "这条是故意造出来的假邮件，用来验证：你回信说「收到」（或 已读、搞定了）之后，它就该从日报里消失。",
    why: "测试：验证「收到」能销掉重要提醒",
    firstSeen: now.toISOString(),
  });
  savePending(items);
  console.log(`  [OK] 已造一条测试重要提醒，清单现在 ${items.length} 封。`);
}
console.log("");
console.log("  下一步：发一封日报（下面的命令），你收到后会看到它带 🔁 待你处理 标记。");
