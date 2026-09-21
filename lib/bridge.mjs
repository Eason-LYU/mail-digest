// 调 PowerShell 桥接的统一入口。
// 关键：用 stdio:inherit + 文件交换数据，而不是管道捕获——
// 某些受限沙箱（如 DSH）禁止程序打开命名管道，piped stdio 会直接 EPERM。
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./config.mjs";

export const BRIDGE = path.join(ROOT, "outlook-bridge.ps1");

/**
 * 把可选的"用哪个邮箱"参数拼成桥接命令行片段。
 * 空值一律不传 —— 不传时桥接走 Outlook 自己的默认存储 / 默认发件账户（与改动前一致）。
 *   account → -Account <smtp>（读这个账户的收件箱；地址不存在时桥接退出码 3）
 *   from    → -From    <smtp>（用这个账户发信；找不到只警告，仍按默认账户发）
 */
export function mailboxArgs({ account = "", from = "" } = {}) {
  const extra = [];
  if (account) extra.push("-Account", String(account));
  if (from) extra.push("-From", String(from));
  return extra;
}

/** 运行桥接，返回退出码（0 成功 / 2 Outlook 不可用 / 3 其他失败）
 *  opts.account / opts.from 为新增可选参数，不传时行为与以前完全相同。 */
export function runBridge(args, { timeoutMs = 10 * 60 * 1000, account = "", from = "" } = {}) {
  const r = spawnSync("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BRIDGE, ...args, ...mailboxArgs({ account, from })],
    { stdio: "inherit", windowsHide: true, timeout: timeoutMs });
  if (r.error) throw new Error(`无法启动 PowerShell 桥接: ${r.error.message}`);
  if (r.status === null) throw new Error("PowerShell 桥接超时或被强制结束");
  return r.status;
}
