// 配置读取：主邮箱 / 备用邮箱 / 白名单 / 翻译渠道 / 路径
//
// 你**不需要**改这个文件：所有可配置项都在根目录的 config.json 里。
//   双击 setup.cmd 会问答式地帮你生成 config.json。
// 优先级：环境变量 > config.json > config.example.json > 代码里的默认值。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const STATE_DIR = path.join(ROOT, ".state");   // 本地状态（含备份），已在 .gitignore 里
export const LOG_DIR = path.join(ROOT, "logs");
export const OUT_DIR = path.join(ROOT, "digests");    // 每天的本地存档
export const HOME = os.homedir();
export const CONFIG_FILE = path.join(ROOT, "config.json");
const EXAMPLE_FILE = path.join(ROOT, "config.example.json");

/**
 * 读配置。**读坏了要大声说**——否则会静默用默认值把日报发到错的地方 / 用错渠道。
 * 返回 { values, from }：from 是实际生效的文件路径（用于向导里显示）。
 */
function readConfig() {
  for (const f of [CONFIG_FILE, EXAMPLE_FILE]) {
    let raw;
    try { raw = fs.readFileSync(f, "utf8"); }
    catch (e) { if (e.code === "ENOENT") continue; console.error(`[config] 读不到 ${f}：${e.message}`); return { values: {}, from: null }; }
    try {
      const o = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      return { values: o && typeof o === "object" && !Array.isArray(o) ? o : {}, from: f };
    } catch (e) {
      console.error(`[config] ${f} 不是合法 JSON：${e.message}`);
      console.error(`[config] ${f} is not valid JSON: ${e.message}`);
      console.error("[config] 请重新双击 setup.cmd 生成，或手工修好再运行。 / Re-run setup.cmd, or fix the file.");
      return { values: {}, from: f, error: e.message };
    }
  }
  return { values: {}, from: null };
}

const { values: CFG, from: CONFIG_FROM } = readConfig();
export { CONFIG_FROM };

/** 取第一个"有内容"的值（空字符串 / 空数组 / undefined 都当没填） */
const pick = (...vals) => {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    if (Array.isArray(v) && !v.length) continue;
    return v;
  }
  return "";
};

// ---------- 主邮箱（被读取的那个） ----------
// 空 = 用 Outlook 默认打开的那个账户。会在 outlook-bridge.ps1 里以 -Account 传入。
export const MAIN_MAILBOX = String(pick(process.env.MAIL_MAIN, CFG.mainMailbox)).trim();

// ---------- 备用邮箱（日报收件人） ----------
export const DIGEST_TO = String(pick(process.env.MAIL_TO, CFG.digestTo)).trim();
/** 是否已经配置过（没配就该提示去跑 setup.cmd，而不是静默发给空地址） */
export const IS_CONFIGURED = /@/.test(DIGEST_TO);

// ---------- 翻译渠道 ----------
//   auto（默认）：有 DeepSeek key 就用它，否则退回 Google 免费接口
//   deepseek    ：用你自己的 key（.state/secrets.json），**行动摘要只有它能做**
//   google      ：免费接口，无需 key，但邮件内容会经过 Google
//   none        ：不翻译（邮件内容完全不出本机）
export const TRANSLATE_PROVIDER = String(pick(process.env.MAIL_TRANSLATE, CFG.translateProvider, "auto")).trim();
export const TRANSLATE_TARGET = String(pick(process.env.MAIL_TRANSLATE_TARGET, CFG.translateTarget, "zh-CN")).trim();

// ---------- 待办指令白名单 ----------
// 两道闸都要过：① 发件人在白名单里；② 主题含标记词。否则任何给你发信的人都能改你的待办。
const DEFAULT_COMMAND_FROM = [DIGEST_TO].filter(Boolean).join(",");
export const COMMAND_FROM = (() => {
  const raw = pick(process.env.MAIL_COMMAND_FROM, CFG.commandFrom, DEFAULT_COMMAND_FROM);
  const list = (Array.isArray(raw) ? raw.join(",") : String(raw)).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DEFAULT_COMMAND_FROM.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
})();
export const COMMAND_MARKERS = (process.env.MAIL_COMMAND_MARKERS || "待办,todo,task,任务,ddl,邮件日报,待办提醒,📬")
  .split(",").map((s) => s.trim()).filter(Boolean);

// ---------- 每天几点跑（install-task.ps1 / setup.mjs 用） ----------
export const DAILY_HOUR = (() => {
  const n = Number(pick(process.env.MAIL_DAILY_HOUR, CFG.dailyHour, 20));
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 20;
})();
