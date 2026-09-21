// 把 DeepSeek 密钥写进 .state/secrets.json（Node 写的 UTF-8 天然无 BOM，避开记事本/PS 的 BOM 坑）
// 用法: runtime\node.exe tools\set-key.mjs        （从环境变量 DEEPSEEK_KEY 读）
//       runtime\node.exe tools\set-key.mjs sk-xxx （或直接作为参数传）
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../lib/config.mjs";

const key = (process.env.DEEPSEEK_KEY || process.argv[2] || "").trim();
if (!key) {
  console.error("[X] 没有提供密钥");
  process.exit(2);
}
if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
  console.error(`[!] 这个值看起来不像 DeepSeek 密钥（应以 sk- 开头）。长度 ${key.length}。`);
  console.error("    仍然会写入，但请确认没有粘贴错。");
}

const file = path.join(STATE_DIR, "secrets.json");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  deepseekApiKey: key,
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
}, null, 2), "utf8");

const bytes = fs.readFileSync(file);
console.log(`[OK] 已写入 ${file}`);
console.log(`     密钥长度 ${key.length}，前 3 字节 ${[...bytes.subarray(0, 3)].join(",")}（应为 123,10,32 = 无 BOM 的 "{\\n "）`);
