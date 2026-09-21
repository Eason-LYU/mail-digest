// 状态文件恢复：列出备份 / 还原
//
// 每次写盘前 lib\statefile.mjs 都会自动留一份旧内容到 .state\backups\，
// 所以"误删/误覆盖/写坏"都不再是终局。这个工具把备份列出来并让你挑一份还原。
//
// 用法（一般通过 恢复台账.cmd 双击运行）：
//   runtime\node.exe tools\restore-state.mjs                 交互：列出备份，输入序号还原
//   runtime\node.exe tools\restore-state.mjs --list           只列出
//   runtime\node.exe tools\restore-state.mjs --restore 2      还原"第 2 新"的那份
//   runtime\node.exe tools\restore-state.mjs --pending        改看「待你处理」清单的备份
//   （加 --file <路径> 可指定别的状态文件）
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { LEDGER_FILE } from "../lib/todos.mjs";
import { STATE_DIR } from "../lib/config.mjs";
import { listBackups, readJsonState, writeJsonState, backupDirFor } from "../lib/statefile.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const TARGET = val("--file", has("--pending")
  ? (process.env.MAIL_PENDING_FILE || path.join(STATE_DIR, "pending-mails.json"))
  : LEDGER_FILE);

function describe(b) {
  const when = b.name.replace(/^.*-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}).*$/, "$1 $2:$3:$4");
  if (b.broken) return `${when} · ${(b.size / 1024).toFixed(1)} KB · ⚠️ 内容已损坏`;
  if (b.items !== null) return `${when} · ${b.items} 条`;
  return `${when} · ${(b.size / 1024).toFixed(1)} KB`;
}

function show() {
  const backups = listBackups(TARGET);
  console.log(`状态文件：${TARGET}`);
  console.log(`备份目录：${backupDirFor(TARGET)}`);
  console.log("");
  const { value, error } = readJsonState(TARGET, { items: [] });
  const cur = Array.isArray(value?.items) ? value.items.length : null;
  console.log(`当前文件：${cur === null ? "（读不出条目）" : `${cur} 条`}${error ? ` · ⚠️ ${error}` : ""}`);
  console.log("");
  if (!backups.length) {
    console.log("  还没有任何备份。");
    console.log("  （备份从 2026-09-21 起才自动生成；在那之前的误删无法用这里恢复。）");
    return backups;
  }
  console.log(`  可用备份 ${backups.length} 份（1 = 最新）：\n`);
  backups.forEach((b, i) => console.log(`  [${i + 1}] ${describe(b)}`));
  return backups;
}

const backups = show();

if (has("--list") || !backups.length) process.exit(0);

if (val("--restore", null)) {
  const n = Number(val("--restore"));
  const b = backups[n - 1];
  if (!b) { console.log(`\n  [X] 没有第 ${n} 份备份`); process.exit(2); }
  const parsed = readJsonState(b.path, { items: [] });
  writeJsonState(TARGET, parsed.value);
  console.log(`\n  [OK] 已用第 ${n} 份备份还原（${describe(b)}）→ ${TARGET}`);
  process.exit(0);
}

// ---------- 交互 ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
async function ask(p) { process.stdout.write(p); const { value, done } = await lines.next(); return done ? null : String(value); }

console.log("");
console.log("  输入序号 = 用那份备份还原当前文件 ｜ 回车 = 退出");
while (true) {
  const raw = await ask("  > ");
  if (raw === null) break;
  const ans = raw.trim();
  if (!ans) break;
  const n = Number(ans);
  if (!/^\d+$/.test(ans) || !backups[n - 1]) { console.log("  [X] 请输入列表里的序号"); continue; }
  const b = backups[n - 1];
  const parsed = readJsonState(b.path, { items: [] });
  writeJsonState(TARGET, parsed.value);
  console.log(`  [OK] 已还原（${describe(b)}）。当前文件现在有 ${(parsed.value.items || []).length} 条。`);
  break;
}
rl.close();
console.log("\n  完成。");
