// 从 digests\ 存档恢复待办台账
//
// 背景：2026-09-21 18:04 一次误用的删除通配符（.state\t*.json）把 todos.json 永久删掉了，
// 那一轮日报还没发，所以只能从**更早的本地存档**里把条目抠回来。
// 存档里的台账区格式固定，字段齐全（标题/做法/来源/首次提醒），可以直接重建；
// 截止日只有 "9/21" 这种就地的相对写法，按存档日期补年份。
//
// 用法（默认只预览，不动文件）：
//   runtime\node.exe tools\restore-from-archive.mjs
//   runtime\node.exe tools\restore-from-archive.mjs --write      真正写回台账
//   runtime\node.exe tools\restore-from-archive.mjs --file <路径> 指定台账文件（测试用）
import fs from "node:fs";
import path from "node:path";
import { LEDGER_FILE, isValidDue } from "../lib/todos.mjs";
import { ROOT } from "../lib/config.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const TARGET = val("--file", LEDGER_FILE);
const WRITE = has("--write");

/** 抓一份存档里的「待办台账」区 */
export function parseArchive(md, archiveDate) {
  const year = Number(String(archiveDate).slice(0, 4));
  const items = [];
  let cur = null;
  for (const line of String(md).split(/\r?\n/)) {
    // - **9/21（还有 2 天）** · 完成物理课前练习
    // - **已挂 1 天** · 完成并提交作业1
    const head = line.match(/^\s*-\s+\*\*(.+?)\*\*\s*·\s*(.+?)\s*$/);
    if (head) {
      const label = head[1];
      const title = head[2];
      const dueM = label.match(/(\d{1,2})\/(\d{1,2})/);
      let due = null;
      let dueText = "";
      if (dueM) {
        const iso = `${year}-${String(dueM[1]).padStart(2, "0")}-${String(dueM[2]).padStart(2, "0")}`;
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { due = iso; dueText = `${Number(dueM[1])}/${Number(dueM[2])}`; }
      } else {
        dueText = label;            // 例如「已挂 1 天」
      }
      // 同一条待办会在连续几天的存档里反复出现：按**标题**当键，晚的存档覆盖早的，
      // 这样既不会重复恢复，也能用上最新一次存档里的截止日/做法（它们可能被更新过）。
      cur = { title, action: "", source: "", due, dueText, firstSeen: null, keySeed: title };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    const act = line.match(/^\s{2,}-\s+(.+?)\s*$/);          // "  - 在下次课前完成 AP10006 课前练习"
    if (act && !cur.action) { cur.action = act[1]; continue; }
    const src = line.match(/^\s{2,}-\s*(.+?)\s*·\s*首次提醒\s*(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (src) {
      cur.source = src[1].trim();
      // 首次提醒没有年份：先按存档年份算，若比存档日期还晚（跨年）就往前推一年
      let y = year;
      const cand = Date.parse(`${y}-${src[2]}-${src[3]}T${src[4]}:${src[5]}:00+08:00`);
      if (!Number.isNaN(cand) && cand - Date.parse(`${archiveDate}T23:59:59+08:00`) > 0) y -= 1;
      cur.firstSeen = `${y}-${src[2]}-${src[3]}T${src[4]}:${src[5]}:00+08:00`;
    }
  }
  return items;
}

const files = fs.readdirSync(path.join(ROOT, "digests"))
  .filter((f) => /^\d{4}-\d{2}-\d{2}-digest\.md$/.test(f))
  .sort();

// 取每一条的最新一次出现：晚的存档覆盖早的（标题被改过、或已被完成的不该复活）
const latest = new Map();
for (const f of files) {
  const date = f.slice(0, 10);
  const md = fs.readFileSync(path.join(ROOT, "digests", f), "utf8");
  for (const it of parseArchive(md, date)) latest.set(it.keySeed, { ...it, archiveDate: date });
}
const recovered = [...latest.values()].sort((a, b) => String(b.archiveDate).localeCompare(String(a.archiveDate)));

console.log(`扫描 ${files.length} 份存档，恢复出 ${recovered.length} 条待办：`);
console.log("");
const now = new Date().toISOString();
const items = recovered.map((it, i) => {
  console.log(`  [${i + 1}] ${it.due ? it.due + " 到期" : "无截止日"} · ${it.title}`);
  console.log(`      ${it.action || "(存档里没有具体做法)"}`);
  console.log(`      来源：${it.source || "?"} · 首次提醒 ${it.firstSeen ? it.firstSeen.slice(0, 10) : "?"}（来自 ${it.archiveDate} 存档）`);
  return {
    key: `m:restore-${it.archiveDate}-${i + 1}`,
    status: "open",
    firstSeen: it.firstSeen ? new Date(it.firstSeen).toISOString() : now,
    lastSeen: now,
    title: it.title,
    action: it.action || "",
    due: it.due && isValidDue(it.due) ? it.due : null,
    dueText: it.dueText || "",
    subject: `(从 ${it.archiveDate} 存档恢复)`,
    source: it.source || "(存档恢复)",
  };
});

console.log("");
if (!WRITE) {
  console.log("以上只是预览，**没有改动任何文件**。确认无误后加 --write 写回：");
  console.log(`  runtime\\node.exe tools\\restore-from-archive.mjs --write`);
  process.exit(0);
}

let existing = { version: 1, items: [] };
try {
  const raw = fs.readFileSync(TARGET, "utf8");
  existing = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  if (!Array.isArray(existing.items)) existing.items = [];
} catch { /* 没有或坏了就用空的 */ }

const have = new Set(existing.items.map((i) => `${i.title}`));
const merged = [...existing.items];
for (const it of items) if (!have.has(it.title)) merged.push(it);

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, JSON.stringify({ ...existing, items: merged }, null, 2), "utf8");
console.log(`已写回 ${TARGET}：原有 ${existing.items.length} 条 → 现在 ${merged.length} 条。`);
