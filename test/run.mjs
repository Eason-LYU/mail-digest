// 进程内测试入口：顺序 import 所有 *.test.mjs，交给 node:test 自带的报告器
// （不用 `node --test`，因为它会 spawn 子进程并用管道回传结果，在某些受限沙箱里会被拒）
// 运行: runtime\node.exe test\run.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = import.meta.dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
for (const f of files) {
  await import(pathToFileURL(path.join(dir, f)).href);
}
