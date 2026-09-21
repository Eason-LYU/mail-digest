// 待办台账管理：查看 / 标记完成 / 手动添加 / 清理归档
//
// 用法（一般通过 待办管理.cmd 双击运行）：
//   runtime\node.exe tools\todos.mjs                     交互模式：列出并逐条标记完成
//   runtime\node.exe tools\todos.mjs --list              只列出
//   runtime\node.exe tools\todos.mjs --done 3            把序号 3 标记完成
//   runtime\node.exe tools\todos.mjs --done c:AB12CD     按 key 前缀标记完成
//   runtime\node.exe tools\todos.mjs --add "标题" --due 2026-09-30 --action "怎么做的"
//   runtime\node.exe tools\todos.mjs --clean             删除已完成/已归档的
//   （加 --file <路径> 可操作指定的台账文件，方便测试）
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { loadLedger, saveLedger, openItems, markDone, dueLabel, makeKey, isValidDue } from "../lib/todos.mjs";
import { LEDGER_FILE } from "../lib/todos.mjs";
import { STATE_DIR } from "../lib/config.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const file = val("--file", LEDGER_FILE);
const useFile = () => {
  if (file === LEDGER_FILE) return loadLedger();
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { version: 1, items: [] }; }
};
const persist = (l) => {
  if (file === LEDGER_FILE) saveLedger(l);
  else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(l, null, 2), "utf8"); }
};

function printList(ledger) {
  const { shown, total, hidden } = openItems(ledger, new Date(), { limit: 50 });
  if (!shown.length) {
    console.log("  当前没有未完成的待办。");
    return shown;
  }
  console.log(`  未完成待办 ${total} 条：\n`);
  shown.forEach((t, i) => {
    console.log(`  [${i + 1}] ${dueLabel(t)} · ${t.title}`);
    if (t.action) console.log(`      ${t.action}`);
    console.log(`      来源：${t.source || "?"} · 首次提醒 ${String(t.firstSeen || "").slice(0, 10)}`);
  });
  if (hidden) console.log(`\n  （另有 ${hidden} 条未显示，用 --list 也只看前 50 条）`);
  return shown;
}

if (has("--list")) {
  printList(useFile());
  process.exit(0);
}

if (val("--done", null)) {
  const ledger = useFile();
  const ref = val("--done");
  const hit = markDone(ledger, ref, new Date());
  if (!hit) { console.log(`  [X] 找不到匹配的待办：${ref}`); process.exit(2); }
  persist(ledger);
  console.log(`  [OK] 已标记完成：${hit.title}`);
  process.exit(0);
}

if (has("--add")) {
  const title = val("--add");
  const due = val("--due", null);
  if (!title) { console.log("  [X] --add 需要标题"); process.exit(2); }
  if (due && !isValidDue(due)) { console.log(`  [X] 日期格式不对（要 YYYY-MM-DD 且在合理范围内）：${due}`); process.exit(2); }
  const ledger = useFile();
  ledger.items.push({
    key: `m:${Date.now()}`, status: "open",
    firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
    title, action: val("--action", ""), due: due || null, dueText: due || "",
    subject: "(手动添加)", source: "手动添加",
  });
  persist(ledger);
  console.log(`  [OK] 已添加：${title}${due ? `（${due} 到期）` : ""}`);
  process.exit(0);
}

if (has("--clean")) {
  const ledger = useFile();
  const before = ledger.items.length;
  ledger.items = ledger.items.filter((i) => i.status === "open");
  persist(ledger);
  console.log(`  [OK] 清理完成：${before} → ${ledger.items.length} 条`);
  process.exit(0);
}

// ---------- 交互模式 ----------
const ledger = useFile();
console.log("================================================================");
console.log("  待办台账：输入序号标记完成，直接回车退出");
console.log("================================================================");
console.log("");

let shown = printList(ledger);

// 用异步迭代器逐行读输入：比 rl.question 稳（question 会丢掉"比提问更早到达"的行，
// 在管道输入/自动化测试下尤其明显），真实终端下行为一样。
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
});
const lines = rl[Symbol.asyncIterator]();
async function ask(prompt) {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  return done ? null : String(value);
}

console.log("");
console.log("  操作：输入序号 = 标记完成 ｜ a = 新增一条（可带截止日）｜ 回车 = 退出");
while (true) {
  console.log("");
  const raw = await ask("  > ");
  if (raw === null) break;                 // 输入结束
  const ans = raw.trim();
  if (!ans) break;

  // ---- 新增 ----
  if (ans.toLowerCase() === "a") {
    const titleRaw = await ask("  事项名（例：交 FYP 进度报告）: ");
    const title = (titleRaw || "").trim();
    if (!title) { console.log("  [X] 没填事项名，已取消"); continue; }
    const dueRaw = ((await ask("  截止日 YYYY-MM-DD（没日期直接回车）: ")) || "").trim();
    let due = null;
    if (dueRaw) {
      due = dueRaw.replace(/\//g, "-");
      if (!isValidDue(due)) {
        console.log(`  [X] 日期不合法或超出合理范围：${dueRaw}（要形如 2026-09-30）`);
        continue;
      }
    }
    const action = ((await ask("  具体怎么做（可留空）: ")) || "").trim();
    ledger.items.push({
      key: `m:${Date.now()}`, status: "open",
      firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
      title, action, due, dueText: due || "",
      subject: "(手动添加)", source: "手动添加",
    });
    persist(ledger);
    console.log(`  [OK] 已添加：${title}${due ? `（${due} 到期，之后每天会倒计时提醒）` : "（没有截止日）"}`);
    console.log("");
    shown = printList(ledger);
    continue;
  }

  // ---- 标记完成 ----
  if (!/^\d+$/.test(ans) || Number(ans) < 1 || Number(ans) > shown.length) {
    console.log("  [X] 请输入列表里的序号，或输入 a 新增一条");
    continue;
  }
  const target = shown[Number(ans) - 1];
  const hit = markDone(ledger, target.key, new Date());
  if (hit) {
    persist(ledger);
    console.log(`  [OK] 已完成：${hit.title}`);
  }
  console.log("");
  shown = printList(ledger);
}
rl.close();
console.log("\n  已保存。");
