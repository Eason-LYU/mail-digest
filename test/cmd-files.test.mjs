// 守卫：所有 .cmd 必须是纯 ASCII
//
// 为什么：cmd.exe 按 ANSI/OEM 代码页读取批处理文件。一旦文件里出现 UTF-8 中文字节
// （即使只有 9 个字节），cmd 的字节偏移就会错位，开始吞字符、把命令解析得面目全非，
// 脚本还没跑到正题就崩掉退出——用户看到的就是"窗口一闪就没了"。
// 这个坑真实发生过（立即运行计划任务.cmd 里的 findstr /C:"完成。" 导致的）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/config.mjs";

test("所有 .cmd 必须是纯 ASCII（否则 cmd.exe 会吞字符导致脚本瞬间崩掉）", () => {
  const files = fs.readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith(".cmd"));
  assert.ok(files.length > 0, "没找到任何 .cmd 文件，测试本身可能失效了");
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    const bad = [...buf].filter((b) => b > 127).length;
    assert.equal(bad, 0, `${f} 含 ${bad} 个非 ASCII 字节；请把中文改成英文，或把逻辑移进 .ps1`);
  }
});

// 守卫：所有 .ps1 必须带 UTF-8 BOM
//
// 为什么：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当成 GBK/ANSI 读，
// 中文注释立刻变乱码并把语法撑爆（报一堆"缺少 ) / 意外的标记"）。
// 编辑工具保存时默认不加 BOM，这个坑真实发生过好几次，所以用测试守住。
test("所有 .ps1 必须带 UTF-8 BOM", () => {
  const files = fs.readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith(".ps1"));
  assert.ok(files.length > 0, "没找到任何 .ps1 文件，测试本身可能失效了");
  for (const f of files) {
    const b = fs.readFileSync(path.join(ROOT, f));
    const hasBom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    assert.ok(hasBom, `${f} 缺少 UTF-8 BOM；编辑后必须显式补回`);
  }
});
