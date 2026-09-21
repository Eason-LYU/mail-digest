// 首次配置向导 / First-run setup wizard
//
// 用法（双击 setup.cmd，或自己运行）：
//   node tools\setup.mjs            问答式配置：主邮箱 / 备用邮箱 / 白名单 / 翻译渠道 / 定时
//   node tools\setup.mjs --show     只显示当前配置和状态，不改任何东西
//   node tools\setup.mjs --no-probe 跳过"探测 Outlook 账户"这一步（没装 Outlook 或自动化时用）
//
// 它做的事：探测 Outlook 里已登录的账户 → 问你几个问题（中英双语）→ 写 config.json
// → 密钥写进 .state\secrets.json（**不写进 config.json**）→ 可选：检查通道 / 空跑一次 / 注册定时任务。
// 任何时候都可以重新运行，它会带着现有配置作为默认值。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { ROOT, STATE_DIR, CONFIG_FILE, CONFIG_FROM } from "../lib/config.mjs";

const argv = process.argv.slice(2);
const SHOW_ONLY = argv.includes("--show");
const NO_PROBE = argv.includes("--no-probe");   // 跳过 Outlook 探测（自动化测试 / 没装 Outlook 时用）

const SECRETS_FILE = path.join(STATE_DIR, "secrets.json");
const NODE = process.execPath;
const RUN = (args) => spawnSync(NODE, args, { cwd: ROOT, stdio: "inherit" });
/** 计划任务是 PowerShell 脚本，得用 powershell.exe 调（不是 node） */
const RUN_PS = (script, args = []) => spawnSync("powershell", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, script), ...args,
], { cwd: ROOT, stdio: "inherit" });

// ---------- 小工具：中英双语输出 ----------
const line = (zh, en = "") => console.log(en ? `  ${zh}\n  ${en}` : `  ${zh}`);
const head = (zh, en = "") => { console.log(""); console.log("=".repeat(66)); console.log(`  ${zh}${en ? `\n  ${en}` : ""}`); console.log("=".repeat(66)); };
const ok = (zh, en = "") => line(`[OK] ${zh}`, en ? `[OK] ${en}` : "");

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch { return {}; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}
const looksLikeMail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

/** 跑一次 Outlook 通道检查，把账号列表抠出来（失败就返回空数组，不阻塞向导） */
function probeOutlook() {
  console.log("");
  line("正在检查 Outlook 通道（只读，最多等 45 秒）…", "Checking the Outlook channel (read only, up to 45s) ...");
  const res = spawnSync(NODE, [path.join(ROOT, "main-outlook.mjs"), "--check"], { cwd: ROOT, encoding: "utf8", timeout: 45000 });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const accounts = [];
  for (const l of out.split(/\r?\n/)) {
    const m = l.match(/^ACCOUNT\|([^|]*)\|([^|]*)\|/);
    if (m) accounts.push({ name: m[1].trim(), smtp: m[2].trim() });
  }
  return { rc: res.status, accounts, out };
}

// ---------- 现有配置作为默认值 ----------
const cur = readJson(CONFIG_FILE);
const curCfg = Object.keys(cur).length ? cur : readJson(path.join(ROOT, "config.example.json"));
const curSecrets = readJson(SECRETS_FILE);

head("邮箱日报 · 配置向导", "Mail digest - setup wizard");
line("全程问答，中英双语；每一步都可以直接回车用默认值。",
     "Answer a few questions (Chinese + English). Press Enter to accept each default.");
line("随时可以重新运行本向导修改配置。", "You can re-run this wizard any time.");

if (CONFIG_FROM) line(`当前生效的配置来源：${CONFIG_FROM}`, `Active config source: ${CONFIG_FROM}`);

if (SHOW_ONLY) {
  head("当前配置 / Current configuration");
  console.log(JSON.stringify({
    mainMailbox: curCfg.mainMailbox || "(默认账户 / Outlook default)",
    digestTo: curCfg.digestTo || "(未填 / not set)",
    commandFrom: curCfg.commandFrom?.length ? curCfg.commandFrom : "(只允许备用邮箱 / delivery mailbox only)",
    translateProvider: curCfg.translateProvider || "auto",
    deepseekApiKey: curSecrets.deepseekApiKey ? "已保存 / saved" : "未设置 / not set",
    dailyHour: curCfg.dailyHour ?? 20,
  }, null, 2));
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
async function ask(zh, en, def = "") {
  const suffix = def ? ` [${def}]` : "";
  process.stdout.write(`\n  ${zh}${en ? `\n  ${en}` : ""}${suffix}\n  > `);
  const { value, done } = await lines.next();
  if (done) return def;
  const v = String(value).trim();
  return v || def;
}

// ---------- 1) 主邮箱 ----------
head("① 主邮箱（被读取的邮箱）", "1) Primary mailbox (the one being read)");
line("就是你想整理的那个学校/工作邮箱。", "The school/work mailbox whose mail you want digested.");
line("留空 = 用 Outlook 默认打开的那个账户。", "Empty = whatever account Outlook opens by default.");

const probe = NO_PROBE ? { rc: null, accounts: [] } : probeOutlook();
if (probe.accounts.length) {
  line("Outlook 里已登录的账户：", "Accounts signed in to Outlook:");
  probe.accounts.forEach((a, i) => console.log(`    [${i + 1}] ${a.smtp || a.name}${a.name && a.smtp ? `  (${a.name})` : ""}`));
} else {
  line("没能从 Outlook 读到账户列表（可能没装经典 Outlook 或没登录）。",
       "Could not read the account list from Outlook (classic Outlook missing or not signed in?).");
  line("可以稍后重跑本向导，或先跳过。", "You can re-run this wizard later, or skip for now.");
}
const mainAns = await ask("主邮箱（填地址，或输入上面的序号；留空 = 默认账户）",
                          "Primary mailbox (address, or the number above; empty = Outlook default)",
                          curCfg.mainMailbox || "");
let mainMailbox = mainAns;
const asIndex = Number(mainAns);
if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= probe.accounts.length) {
  mainMailbox = probe.accounts[asIndex - 1].smtp || "";
}
if (mainMailbox && !looksLikeMail(mainMailbox)) {
  line(`⚠️ 「${mainMailbox}」看起来不是邮箱地址，已忽略（用默认账户）。`,
       `Warning: "${mainMailbox}" does not look like an address - ignored (using the default account).`);
  mainMailbox = "";
}

// ---------- 2) 备用邮箱（日报收件人） ----------
head("② 备用邮箱（日报发到这里）", "2) Delivery mailbox (where the digest is sent)");
line("一般填你的私人邮箱（Gmail / QQ / 163 都行）。必填。",
     "Usually your private address (Gmail / QQ / 163 all fine). Required.");
let digestTo = "";
for (let i = 0; i < 5; i++) {
  digestTo = await ask("日报收件邮箱", "Send the digest to", curCfg.digestTo && looksLikeMail(curCfg.digestTo) ? curCfg.digestTo : "");
  if (looksLikeMail(digestTo)) break;
  line("⚠️ 这不像邮箱地址，请重填。", "Warning: that does not look like an e-mail address, please retry.");
  digestTo = "";
}
if (!digestTo) {
  line("没有填备用邮箱，配置没写完。", "No delivery mailbox given - configuration left untouched.");
  rl.close();
  process.exit(1);
}

// ---------- 3) 白名单 ----------
head("③ 白名单（谁能用邮件改你的待办）", "3) Whitelist (who may send to-do commands)");
line("只允许这些地址发来的邮件改你的台账；其他地址一律无效。",
     "Only these addresses can change your ledger by e-mail; everyone else is ignored.");
line("直接回车 = 只允许上面那个备用邮箱（推荐）。", "Enter alone = only the delivery mailbox above (recommended).");
const fromAns = await ask("额外白名单，逗号分隔（可留空）", "Extra addresses, comma separated (may be empty)",
                          (curCfg.commandFrom || []).join(","));
const commandFrom = fromAns.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
const badFrom = commandFrom.filter((a) => !looksLikeMail(a));
if (badFrom.length) line(`⚠️ 忽略不像地址的项：${badFrom.join(", ")}`, `Warning: ignoring non-address entries: ${badFrom.join(", ")}`);

// ---------- 4) 翻译渠道 ----------
head("④ 翻译渠道", "4) Translation channel");
line("1) auto     有 DeepSeek 密钥就用它，否则用 Google 免费接口（默认）",
     "1) auto     use DeepSeek when a key exists, else the free Google endpoint (default)");
line("2) deepseek 用你自己的密钥（行动摘要只有它能做）",
     "2) deepseek your own API key (only this one can produce the action summary)");
line("3) google   免费、无需密钥，但邮件内容会经过 Google",
     "3) google   free, no key, but mail content goes through Google");
line("4) none     不翻译（邮件内容完全不出本机）",
     "4) none     no translation (mail content never leaves this machine)");
const chanAns = await ask("选一个（1-4）", "Pick one (1-4)", String(
  ({ auto: "1", deepseek: "2", google: "3", none: "4" })[curCfg.translateProvider] || "1"));
const translateProvider = ({ "1": "auto", "2": "deepseek", "3": "google", "4": "none" })[chanAns] || "auto";

let apiKey = curSecrets.deepseekApiKey || "";
if (translateProvider === "deepseek" || translateProvider === "auto") {
  const want = await ask(
    apiKey ? "DeepSeek 密钥（已保存，直接回车保持；输入 - 可清除）"
           : "DeepSeek 密钥（可留空跳过；形如 sk-xxxxxxxx）",
    apiKey ? "DeepSeek API key (already saved; Enter keeps it, type - to clear)"
           : "DeepSeek API key (may be empty; looks like sk-xxxxxxxx)",
    "");
  if (want === "-") apiKey = "";
  else if (want) apiKey = want;
  if (apiKey && !/^sk-[A-Za-z0-9_-]{10,}$/.test(apiKey)) {
    line("⚠️ 这个字符串不像 DeepSeek 密钥（一般以 sk- 开头），已保留但可能无效。",
         "Warning: that does not look like a DeepSeek key (usually starts with sk-) - kept anyway.");
  }
}

// ---------- 5) 定时 ----------
head("⑤ 每天几点跑", "5) Daily run time");
const hourAns = await ask("小时（0-23，24 小时制）", "Hour (0-23, 24h clock)", String(curCfg.dailyHour ?? 20));
let dailyHour = Number(hourAns);
if (!Number.isInteger(dailyHour) || dailyHour < 0 || dailyHour > 23) {
  line("⚠️ 不是 0-23，用默认值 20（晚上 8 点）。", "Warning: not 0-23, using the default 20 (8pm).");
  dailyHour = 20;
}

// ---------- 写入 ----------
head("保存配置 / Saving");
const cfg = {
  _readme_zh: "这是唯一的配置文件。留空 = 用默认值。双击 setup.cmd 可重新生成。",
  _readme_en: "The only config file. Empty = default. Double-click setup.cmd to regenerate.",
  mainMailbox,
  digestTo,
  commandFrom: commandFrom.filter((a) => looksLikeMail(a)),
  translateProvider,
  translateTarget: curCfg.translateTarget || "zh-CN",
  dailyHour,
};
writeJson(CONFIG_FILE, cfg);
ok(`已写入 ${CONFIG_FILE}`, `wrote ${CONFIG_FILE}`);

if (apiKey) {
  writeJson(SECRETS_FILE, { ...curSecrets, deepseekApiKey: apiKey });
  ok(`密钥已保存到 ${SECRETS_FILE}（不会写进 config.json，也不会提交到 git）`,
     `API key saved to ${SECRETS_FILE} (never written into config.json, never committed)`);
} else if (!apiKey && (translateProvider === "deepseek")) {
  line("⚠️ 选了 deepseek 但没有密钥，运行时会退回免费渠道。",
       "Warning: deepseek selected but no key - it will fall back at runtime.");
}

console.log("");
line("配置摘要 / Summary:", "");
console.log(JSON.stringify({
  主邮箱_mainMailbox: mainMailbox || "(Outlook 默认账户 / default)",
  备用邮箱_digestTo: digestTo,
  白名单_commandFrom: cfg.commandFrom.length ? cfg.commandFrom : [digestTo],
  翻译渠道_translate: translateProvider,
  DeepSeek密钥_key: apiKey ? "已保存 / saved" : "未设置 / not set",
  每天几点_dailyHour: dailyHour,
}, null, 2));

// ---------- 可选：接下来的三件事 ----------
head("接下来想做什么？（可多选，回车跳过）", "What next? (comma separated, Enter to skip)");
line("1) 检查 Outlook 通道（只读）", "1) Check the Outlook channel (read only)");
line("2) 空跑一次，生成本地日报看看效果（不发信、不改状态）",
     "2) Dry run: build a digest locally to see the result (no mail sent, no state changed)");
line("3) 注册每天自动运行的计划任务", "3) Register the daily scheduled task");
const nextAns = await ask("例如 1,2,3（直接回车 = 什么都不做）", "e.g. 1,2,3 (Enter alone = skip)", "");
const picks = nextAns.split(/[,，\s]+/).filter(Boolean);
rl.close();

for (const p of picks) {
  if (p === "1") { head("检查通道 / Channel check"); RUN([path.join(ROOT, "main-outlook.mjs"), "--check"]); }
  if (p === "2") { head("空跑 / Dry run"); RUN([path.join(ROOT, "main-outlook.mjs"), "--dry-run", "--hours", "24"]); }
  if (p === "3") {
    head("注册计划任务 / Register the scheduled task");
    const time = `${String(dailyHour).padStart(2, "0")}:00`;
    RUN_PS("install-task.ps1", ["-Time", time]);
  }
}

head("完成 / Done");
line("日常用法：什么都不用做，它每天到点自己跑。",
     "Day-to-day: nothing to do - it runs itself at the scheduled time.");
line("想立刻跑一次：双击 send-test-digest.cmd（真发）或 dry-run.cmd（只本地生成）。",
     "To run now: send-test-digest.cmd (really sends) or dry-run.cmd (local only).");
line("主邮箱/备用邮箱要改：重新双击 setup.cmd。", "To change mailboxes: run setup.cmd again.");
console.log("");
