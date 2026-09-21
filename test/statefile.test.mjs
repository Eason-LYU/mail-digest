// 状态文件保护测试
//
// 为什么要有这一套：2026-09-21 一次误删把 .state\todos.json 永久删掉，几天的待办全没了，
// 而程序读不到文件时**静默当成空台账**、转头把空台账写回去——真数据就此消失且无人察觉。
// 下面每一条都对应那次事故里的一个失效环节。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../lib/config.mjs";
import { readJsonState, writeJsonState, listBackups, backupDirFor } from "../lib/statefile.mjs";

const TMP = path.join(STATE_DIR, "statefile-test");
const fileIn = (name) => path.join(TMP, name);

function freshDir() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}

test("readJsonState：文件不存在 → 明确标 missing（不是'内容坏了'）", () => {
  freshDir();
  const r = readJsonState(fileIn("nope.json"), { items: [] });
  assert.equal(r.missing, true);
  assert.equal(r.error, undefined, "文件不存在是正常情况，不该报警");
  assert.deepEqual(r.value, { items: [] });
});

test("readJsonState：内容坏了 → 原文另存 + 报错，绝不静默丢数据", () => {
  freshDir();
  const f = fileIn("broken.json");
  const original = '{ "items": [ { "title": "别丢了我" }';   // 半截 JSON：正是"写到一半被杀"的样子
  fs.writeFileSync(f, original, "utf8");

  const r = readJsonState(f, { items: [] });
  assert.equal(r.corrupt, true);
  assert.match(r.error, /不是合法 JSON/);
  assert.ok(r.stashed, "必须把原文另存一份");
  assert.equal(fs.readFileSync(r.stashed, "utf8"), original, "另存的必须是原文逐字节一致");
  assert.equal(r.value.items.length, 0, "同时给出可用的空值，让流程能继续");
});

test("readJsonState：空文件（写入被打断）也当作异常上报", () => {
  freshDir();
  const f = fileIn("empty.json");
  fs.writeFileSync(f, "", "utf8");
  const r = readJsonState(f, { items: [] });
  assert.ok(r.error, "空文件说明上次写盘被打断，必须让人知道");
  assert.equal(r.missing, true);
});

test("readJsonState：带 BOM 的正常文件仍能读（记事本/PowerShell 会加 BOM）", () => {
  freshDir();
  const f = fileIn("bom.json");
  fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ items: [1, 2] }), "utf8");
  const r = readJsonState(f, { items: [] });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value.items, [1, 2]);
});

test("writeJsonState：覆盖前自动备份旧内容（这就是'误覆盖'的救命绳）", () => {
  freshDir();
  const f = fileIn("todos.json");
  writeJsonState(f, { items: ["第一版", "第二版"] });
  writeJsonState(f, { items: [] });                     // 模拟"空台账覆盖真数据"

  const backups = listBackups(f);
  assert.equal(backups.length, 1, "应该正好留一份旧内容");
  const saved = JSON.parse(fs.readFileSync(backups[0].path, "utf8"));
  assert.deepEqual(saved.items, ["第一版", "第二版"], "备份里必须是覆盖前的真数据");
  assert.equal(backups[0].items, 2, "备份要能报出条目数，方便挑");
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")).items, []);
});

test("writeJsonState：内容没变就不产生备份（避免备份目录被重复副本塞满）", () => {
  freshDir();
  const f = fileIn("same.json");
  writeJsonState(f, { items: [1] });
  writeJsonState(f, { items: [1] });
  assert.equal(listBackups(f).length, 0);
});

test("writeJsonState：备份轮转，只保留最近的 keep 份", () => {
  freshDir();
  const f = fileIn("rot.json");
  for (let i = 0; i < 8; i++) writeJsonState(f, { items: [i] }, { keep: 3 });
  const backups = listBackups(f);
  assert.equal(backups.length, 3, "keep=3 就该只留 3 份");
  // 最新在前：第 1 份应当装着第 7 次写入前的值（也就是 6）
  assert.deepEqual(JSON.parse(fs.readFileSync(backups[0].path, "utf8")).items, [6]);
});

test("writeJsonState：原子写，不留临时文件（断电/被强杀也不会留半截 JSON）", () => {
  freshDir();
  const f = fileIn("atomic.json");
  writeJsonState(f, { items: ["ok"] });
  const leftovers = fs.readdirSync(TMP).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "临时文件必须已被改名，不能留在目录里");
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")).items, ["ok"]);
});

test("writeJsonState：目标目录不存在时自动创建", () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const f = path.join(TMP, "deep", "nested.json");
  writeJsonState(f, { items: [1] });
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).items.length, 1);
  assert.ok(backupDirFor(f).includes("backups"));
  freshDir();
});

test("listBackups：目录不存在时返回空数组，不抛异常", () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.deepEqual(listBackups(fileIn("none.json")), []);
});
