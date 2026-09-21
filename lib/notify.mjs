// 失败提醒：写记录 + 调用 notify.ps1（桌面文件 + 自动消失的弹窗）
//
// 只在**真的失败**时触发（Outlook 读不到、发送失败、未预期异常）；干跑和 --check 不触发。
// 成功运行时调用 clearFailureNotice() 清掉桌面上的旧提醒，避免修好了还挂着红字。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LOG_DIR, ROOT } from "./config.mjs";

export const NOTIFY_PS1 = path.join(ROOT, "notify.ps1");

const hkDate = (d) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
}).format(d);
const hkTime = (d) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short",
}).format(d);

/** 提醒正文（纯文本，桌面文件与弹窗共用） */
export function failureText({ when = new Date(), reason = "", hint = "", context = {} } = {}) {
  const lines = [
    "邮件日报运行失败",
    "",
    `时间：${hkTime(when)}（香港时间）`,
    `原因：${reason}`,
  ];
  if (hint) lines.push(`怎么办：${hint}`);
  for (const [k, v] of Object.entries(context)) {
    if (v !== undefined && v !== null && v !== "") lines.push(`${k}：${v}`);
  }
  lines.push(
    "",
    "说明：",
    "· 这是本机 mail-digest 脚本自动生成的提醒。",
    "· 当天没有收到日报邮件，就是因为这次失败。",
    "· 问题解决、下一次成功运行后，这个文件会被自动删除。",
    "· 详细日志：mail-digest\\logs\\task.log （用记事本打开即可）",
  );
  return lines.join("\r\n");
}

/** 把提醒正文写到 logs 里留档，返回文件路径 */
export function writeFailureLog(text, when = new Date(), dir = LOG_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `FAILURE-${hkDate(when)}.txt`);
  fs.writeFileSync(p, text, "utf8");
  return p;
}

/** 调 notify.ps1（spawn 可注入，便于测试） */
export function runNotify(args, { spawn = spawnSync } = {}) {
  const r = spawn("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", NOTIFY_PS1, ...args],
    { stdio: "inherit", windowsHide: true, timeout: 5 * 60 * 1000 });
  if (r.error) throw new Error(r.error.message);
  return r.status;
}

/** 失败提醒主入口。任何内部错误都不应影响主流程（提醒失败也不能让脚本崩） */
export function notifyFailure({ reason, hint = "", context = {}, log = () => {}, seconds = 60, when = new Date(), spawn } = {}) {
  const text = failureText({ when, reason, hint, context });
  let file = null;
  try {
    file = writeFailureLog(text, when);
    log(`已记录失败详情：${file}`);
  } catch (e) {
    log(`写失败记录出错：${e.message}`);
  }
  if (file) {
    try {
      runNotify(["-Mode", "warn", "-TextFile", file, "-Seconds", String(seconds)], { spawn });
      log("已在桌面生成提醒文件并弹出提示框");
    } catch (e) {
      log(`弹窗提醒失败（失败记录已保留）：${e.message}`);
    }
  }
  return { file, text };
}

/** 成功运行后清掉桌面上的旧提醒 */
export function clearFailureNotice({ log = () => {}, spawn } = {}) {
  try {
    runNotify(["-Mode", "clear"], { spawn });
  } catch (e) {
    log(`清理旧提醒出错（不影响运行）：${e.message}`);
  }
}
