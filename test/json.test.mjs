// 邮件 dump 的解析必须**永远**给出数组 —— 2026-09-29 事故的守卫。
//
// 事故链条（真实数据）：
//   1) 用户 9/28 20:03:34 回信下指令（日报 20:00:19 刚发走，晚 3 分钟）
//   2) 9/29 09:01 那次运行的窗口里**恰好只有这一封**
//   3) 桥接层用 `$list | ConvertTo-Json` 写 dump —— PowerShell 对**单元素列表**写的是裸对象
//      而不是 [ {...} ]（桥接层日志：count=1）
//   4) 读取端 `Array.isArray(d) ? d : d.value || []` 看到裸对象既不是数组、也没有 .value
//      → 返回空数组 → 日报报「无新邮件」，那封指令被静默吞掉，拖到当晚 20:00 才执行
//
// 历史日志里 count=1 的导出出现过 8 次，所以这不是孤例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { asMailList } from "../lib/json.mjs";

const mail = (subject) => ({ subject, receivedDateTime: "2026-09-28T12:03:34.536Z" });

test("asMailList：正常数组原样返回", () => {
  assert.equal(asMailList([mail("A"), mail("B")]).length, 2);
});

test("asMailList：裸对象（PowerShell 单元素列表写成对象）→ 当成 1 封，绝不能丢", () => {
  const one = asMailList(mail("回复：📬 邮件日报 2026/09/28 · 15 封新邮件 · 0 项需行动"));
  assert.equal(one.length, 1);
  assert.equal(one[0].subject, "回复：📬 邮件日报 2026/09/28 · 15 封新邮件 · 0 项需行动");
});

test("asMailList：{ value: [...] }（Graph 信封）→ 取里面的数组", () => {
  assert.equal(asMailList({ value: [mail("A"), mail("B"), mail("C")] }).length, 3);
});

test("asMailList：空数组 / null / undefined / 字符串 / { value: 非数组 } → 空数组", () => {
  assert.deepEqual(asMailList([]), []);
  assert.deepEqual(asMailList(null), []);
  assert.deepEqual(asMailList(undefined), []);
  assert.deepEqual(asMailList("nope"), []);
  assert.deepEqual(asMailList({ value: "nope" }), []);
});
