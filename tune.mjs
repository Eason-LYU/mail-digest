// 用真实邮件校准分类规则：按分数从高到低列出最近 N 天的邮件，一眼看出误判
// 用法:
//   node tune.mjs                                  # 默认走 Outlook COM
//   node tune.mjs --source graph                   # 走 Microsoft Graph（需要授权令牌）
//   node tune.mjs --days 7 --limit 80 --csv logs\tuning.csv
import fs from "node:fs";
import path from "node:path";
import { OUT_DIR, STATE_DIR } from "./lib/config.mjs";
import { runBridge } from "./lib/bridge.mjs";
import { asMailList } from "./lib/json.mjs";
import { classify, oneLine } from "./lib/classify.mjs";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const SOURCE = val("--source", "outlook");
const DAYS = Number(val("--days", "7"));
const LIMIT = Number(val("--limit", "60"));
const CSV = val("--csv", null);
const FROM_DUMP = val("--from-dump", null);

let messages = [];

if (FROM_DUMP) {
  // 离线校准：直接用之前缓存下来的邮件 dump，不碰 Outlook，便于反复调规则
  const raw = JSON.parse(fs.readFileSync(path.resolve(FROM_DUMP), "utf8"));
  messages = asMailList(raw);
  console.log(`[离线模式] 从缓存读取 ${messages.length} 封邮件：${path.resolve(FROM_DUMP)}`);
} else if (SOURCE === "outlook") {
  const dumpFile = path.join(STATE_DIR, "tune-dump.json");
  console.log(`通过 Outlook COM 拉取最近 ${DAYS} 天的邮件…`);
  const st = runBridge(["-Dump", dumpFile, "-Hours", String(DAYS * 24), "-Max", "500"]);
  if (st !== 0) {
    console.error(`Outlook 读取失败（桥接退出码 ${st}）。先在沙箱外运行 检查Outlook通道.cmd 确认通道可用。`);
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(dumpFile, "utf8"));
  messages = asMailList(raw);
} else {
  const { graph, loadTokens } = await import("./lib/graph.mjs");
  if (!loadTokens()?.refresh_token) {
    console.error("尚未授权：请先运行 node auth-login.mjs 完成一次性登录。");
    process.exit(2);
  }
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
  const q = new URLSearchParams({
    $filter: `receivedDateTime ge ${since}`,
    $orderby: "receivedDateTime desc",
    $top: "300",
    $select: "id,subject,from,receivedDateTime,isRead,importance,hasAttachments,bodyPreview,webLink,flag",
  });
  console.log(`通过 Graph 拉取最近 ${DAYS} 天的邮件…`);
  const res = await graph(`/me/mailFolders/inbox/messages?${q}`);
  messages = res.value || [];
}

const rows = messages
  .map((m) => ({ m, c: classify(m) }))
  .sort((a, b) => b.c.score - a.c.score);

const icon = (b) => (b === "action" ? "🔴" : b === "watch" ? "🟡" : "⚪");
console.log(`\n共 ${rows.length} 封。按分数降序（分数越高越"需要行动"）:\n`);
console.log("分数 级别 未读 发件人 / 主题 / 命中标签");
console.log("-".repeat(100));
for (const { m, c } of rows.slice(0, LIMIT)) {
  console.log(`${String(c.score).padStart(4)} ${icon(c.bucket)} ${m.isRead ? "  " : "未读"} ${(c.senderName || c.sender).slice(0, 22)} | ${(m.subject || "(无主题)").slice(0, 52)}`);
  if (c.reasons.length) console.log(`     └ ${c.reasons.join(" / ")}`);
}
if (rows.length > LIMIT) console.log(`\n（只显示前 ${LIMIT} 条，共 ${rows.length} 条；用 --limit 调整）`);

if (CSV) {
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["score", "bucket", "isRead", "receivedDateTime", "from", "subject", "reasons", "preview", "webLink"].join(","),
    ...rows.map(({ m, c }) => [
      c.score, c.bucket, m.isRead, m.receivedDateTime,
      c.sender, m.subject, c.reasons.join(" / "), oneLine(m, 300), m.webLink,
    ].map(esc).join(",")),
  ];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.resolve(CSV), "\uFEFF" + lines.join("\r\n"), "utf8");
  console.log(`\n已导出 ${rows.length} 条到 ${path.resolve(CSV)}`);
}
