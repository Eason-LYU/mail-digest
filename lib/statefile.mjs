// 状态文件的读写保护
//
// 为什么需要这个模块（血的教训）：
//   2026-09-21 一次误用的删除通配符把 .state\todos.json 永久删掉了，几天的待办全没了，
//   而程序对此毫无察觉——下一次运行时 loadLedger() 读不到文件，就当成"新用户"从空台账开始，
//   直接把空台账写回去。**删除和"文件损坏读不出来"这两种情况，程序必须有备份可退。**
//
// 三条规则：
//   1) 写盘前先备份旧内容（轮转保留最近 N 份）——误删/误覆盖都能捞回来；
//   2) 写盘用"临时文件 + 改名"原子替换——断电/被强杀不会留下半截 JSON；
//   3) 文件存在但解析不了时，**绝不静默当成空**：把原文另存为 .corrupt-* 并把错误报上去。
import fs from "node:fs";
import path from "node:path";

export function backupDirFor(file) {
  return path.join(path.dirname(file), "backups");
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 轮转：只保留最新的 keep 份备份 */
function rotate(dir, base, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith(".json"))
      .sort();                                     // 名字里带 ISO 时间戳，字典序就是时间序
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* 轮转失败不影响主流程 */ }
}

/**
 * 读 JSON 状态文件。
 * 返回 { value, error?, missing?, corrupt?, stashed? }——**调用方必须检查 error**，
 * 因为"读不出来"和"本来就是空的"含义完全不同。
 */
export function readJsonState(file, fallback = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { value: fallback, missing: true };
    return { value: fallback, error: `读不到 ${file}：${e.message}` };
  }
  if (!raw.trim()) return { value: fallback, missing: true, error: `${file} 是空文件（上次写入可能被打断）` };
  try {
    const o = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return { value: o, raw };
  } catch (e) {
    const stashed = stashCorrupt(file, raw);
    return {
      value: fallback, corrupt: true, stashed,
      error: `${file} 不是合法 JSON（${e.message}）；原文已另存为 ${stashed}`,
    };
  }
}

/** 解析失败时把原文另存一份，避免"读失败 → 写空 → 原文永久消失" */
function stashCorrupt(file, raw) {
  try {
    const dir = backupDirFor(file);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${path.basename(file, ".json")}-corrupt-${stamp()}.json`);
    fs.writeFileSync(p, raw, "utf8");
    return p;
  } catch { return "(另存失败)"; }
}

/**
 * 原子写 JSON 状态文件，并在写之前备份旧内容。
 * @param {object} opts { keep = 10 保留几份备份, backup = true 是否备份 }
 */
export function writeJsonState(file, value, { keep = 10, backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2);

  if (backup) {
    try {
      if (fs.existsSync(file)) {
        const cur = fs.readFileSync(file, "utf8");
        // 内容没变就不必留备份，免得备份目录被无意义的重复副本塞满
        if (cur.trim() && cur !== text) {
          const dir = backupDirFor(file);
          fs.mkdirSync(dir, { recursive: true });
          const base = path.basename(file, ".json");
          // 备份失败不能挡住写盘：数据已经在内存里，不写才是真丢
          fs.writeFileSync(path.join(dir, `${base}-${stamp()}.json`), cur, "utf8");
          rotate(dir, base, keep);
        }
      }
    } catch { /* 同上 */ }
  }

  // 原子替换：先写同目录临时文件，再改名覆盖（同一卷上改名是原子操作）
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了 */ }
    throw e;
  }
}

/** 列出某个状态文件的备份（新的在前），供"恢复台账.cmd"用 */
export function listBackups(file) {
  const dir = backupDirFor(file);
  const base = path.basename(file, ".json");
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => f.startsWith(`${base}-`) && f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => {
      const full = path.join(dir, f);
      let items = null; let broken = false;
      try {
        const o = JSON.parse(fs.readFileSync(full, "utf8"));
        items = Array.isArray(o?.items) ? o.items.length : null;
      } catch { broken = true; }
      return { name: f, path: full, size: fs.statSync(full).size, items, broken };
    });
}
