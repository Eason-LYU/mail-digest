// 统计窗口测试：**标准化到 20:00 锚点** + **一封都不许漏**
//
// 用户的规则："当天邮件整理的时间标准化为前一天晚上 8 点到整理邮件（正常是到当天晚上 8 点这 24 小时），
// 如果报告出得晚了，比如 8:30 才出，那就一直到最新的。"
//
// 同时必须守住旧底线：桥接层读的是 Outlook 本地缓存，缓存没同步完时会"读到 0 封"，
// 那种情况下**绝不能**把覆盖点推到"现在"，否则那批邮件永久跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../lib/digest.mjs";
import { computeSince, nextWindowStart, standardWindowStart, shouldRetryEmptyRead, staleVerdict } from "../lib/window.mjs";

const HK = (s) => new Date(s);
const iso = (d) => d.toISOString();

test("standardWindowStart：不论几点跑，起点都是香港时间「前一天 20:00」", () => {
  assert.equal(iso(standardWindowStart(HK("2026-09-21T20:00:03+08:00"))), iso(HK("2026-09-20T20:00:00+08:00")));
  // 跑晚了也一样（20:30 起算的仍是前一天 20:00）
  assert.equal(iso(standardWindowStart(HK("2026-09-21T20:30:00+08:00"))), iso(HK("2026-09-20T20:00:00+08:00")));
  // 20:00 之前跑（例如早上 9 点手动跑）→ 前一天的 20:00
  assert.equal(iso(standardWindowStart(HK("2026-09-21T09:00:00+08:00"))), iso(HK("2026-09-20T20:00:00+08:00")));
  // 刚好 20:00 那一刻跑的（任务计划程序 20:00:00.9 触发）→ 也是前一天 20:00
  assert.equal(iso(standardWindowStart(HK("2026-09-21T20:00:00+08:00"))), iso(HK("2026-09-20T20:00:00+08:00")));
});

test("computeSince：正常每天 20:00 跑 → 日报显示的就是「前一天 20:00 → 现在」这 24 小时", () => {
  const w = computeSince({
    windowStart: "2026-09-20T11:58:01.000Z",     // 上次覆盖到 9/20 19:58
    lastSeenMailAt: "2026-09-20T11:58:00.000Z",
    now: HK("2026-09-21T20:00:03+08:00"),
  });
  assert.equal(iso(w.labelStart), iso(HK("2026-09-20T20:00:00+08:00")), "显示的窗口起点必须是标准 20:00");
  // 实际读取起点略早于标准起点（比上次覆盖点更早的都不必重读），这是"不漏"的代价，只有两分钟
  assert.equal(iso(w.since), "2026-09-20T11:58:01.000Z");
  assert.match(w.why, /标准窗口/);
});

test("computeSince：报告出得晚（20:30）→ 显示窗口仍是标准 24 小时，终点一直延伸到最新", () => {
  const w = computeSince({
    windowStart: "2026-09-20T11:58:01.000Z",
    now: HK("2026-09-21T20:30:00+08:00"),
  });
  assert.equal(iso(w.labelStart), iso(HK("2026-09-20T20:00:00+08:00")), "起点不因晚跑而变");
  // 终点由调用方用 now 决定 → 也就是覆盖到 20:30 那一刻的最新邮件
  assert.ok(w.labelStart < HK("2026-09-21T20:30:00+08:00"));
});

test("computeSince：今天白天手动跑过 → 晚上仍按标准窗口报（重叠部分交给已报告名单去重）", () => {
  const w = computeSince({
    windowStart: "2026-09-21T09:24:36.000Z",     // 今天 17:24 手动跑过
    now: HK("2026-09-21T20:00:03+08:00"),
  });
  assert.equal(iso(w.since), iso(HK("2026-09-20T20:00:00+08:00")), "要的就是标准那一天");
  assert.equal(iso(w.labelStart), iso(w.since));
  assert.match(w.why, /标准窗口/);
});

test("computeSince：上一次就跑晚了 → 仍按标准窗口报（重叠由已报告名单过滤，不重复刷屏）", () => {
  const w = computeSince({
    windowStart: "2026-09-20T12:30:01.000Z",     // 上次跑到 9/20 20:30
    now: HK("2026-09-21T20:00:03+08:00"),
  });
  assert.equal(iso(w.since), iso(HK("2026-09-20T20:00:00+08:00")));
  assert.equal(iso(w.labelStart), iso(w.since));
});

test("computeSince：关机两天补跑 → 从上次覆盖处补起（绝不能只报最近 24 小时而丢掉中间那天）", () => {
  const w = computeSince({
    windowStart: "2026-09-19T11:00:01.000Z",     // 上次覆盖到 9/19 19:00
    now: HK("2026-09-21T20:05:00+08:00"),
  });
  assert.equal(iso(w.since), "2026-09-19T11:00:01.000Z");
  assert.match(w.why, /避免漏邮件/);
  // 补跑时显示的窗口要如实放宽，免得报告里的邮件落在标题窗口之外
  assert.equal(iso(w.labelStart), "2026-09-19T11:00:01.000Z");
  // 反例说明：若错误地套用"标准窗口"，起点会变成 9/20 20:00，9/19 19:00→9/20 20:00 之间的邮件就永久丢了
  assert.notEqual(iso(w.since), iso(HK("2026-09-20T20:00:00+08:00")));
});

test("computeSince：显式 --hours 优先于一切（手动补看/调试用）", () => {
  const w = computeSince({
    windowStart: "2026-09-20T11:58:01.000Z", hours: 6, explicitHours: true,
    now: HK("2026-09-21T20:00:03+08:00"),
  });
  assert.equal(iso(w.since), iso(HK("2026-09-21T14:00:03+08:00")));
  assert.equal(iso(w.labelStart), iso(w.since), "手动指定小时数时窗口就如实显示");
  assert.match(w.why, /显式指定/);
});

test("computeSince：历史记录超过上限（默认 7 天）→ 从上限补起，不会一次补出一个月", () => {
  const w = computeSince({ windowStart: "2026-08-01T00:00:00.000Z", floorDays: 7, now: HK("2026-09-21T20:00:03+08:00") });
  assert.equal(iso(w.since), iso(new Date(HK("2026-09-21T20:00:03+08:00").getTime() - 7 * 24 * 3600 * 1000)));
  assert.match(w.why, /上限/);
});

test("computeSince：没有任何历史记录 → 用标准窗口（不是随机的 24 小时）", () => {
  const w = computeSince({ now: HK("2026-09-21T20:00:03+08:00") });
  assert.equal(iso(w.since), iso(HK("2026-09-20T20:00:00+08:00")));
  assert.equal(iso(w.labelStart), iso(w.since));
  assert.match(w.why, /无历史记录/);
});

test("computeSince：兼容旧状态——只有 lastSeenMailAt / lastRunAt 时也能算出合理起点", () => {
  const w = computeSince({ lastSeenMailAt: "2026-09-20T11:58:00.000Z", now: HK("2026-09-21T20:00:03+08:00") });
  assert.equal(iso(w.labelStart), iso(HK("2026-09-20T20:00:00+08:00")), "落后于标准窗口 → 显示标准窗口");
  assert.equal(iso(w.since), "2026-09-20T11:58:01.000Z", "但读取要覆盖到上次那封之后，确保不漏");
});

// ---- 下面这条是防漏邮件的底线，任何窗口改动都不许破坏 ----

test("nextWindowStart：读到了邮件 → 推进到最新那封 +1 秒（不会重复读同一封）", () => {
  const next = nextWindowStart({ since: "2026-09-19T14:41:28.000Z", newestSeenMailAt: "2026-09-20T09:15:30.000Z" });
  assert.equal(next, "2026-09-20T09:15:31.000Z");
});

test("nextWindowStart：一封都没读到 → 保持不变（这是防漏邮件最关键的一条）", () => {
  const since = "2026-09-19T14:41:28.000Z";
  assert.equal(nextWindowStart({ since, newestSeenMailAt: null }), new Date(since).toISOString());
  assert.equal(nextWindowStart({ since, newestSeenMailAt: undefined }), new Date(since).toISOString());
});

test("nextWindowStart：收到非法时间字符串时不推进", () => {
  const since = "2026-09-19T14:41:28.000Z";
  assert.equal(nextWindowStart({ since, newestSeenMailAt: "不是时间" }), new Date(since).toISOString());
});

test("真实场景回放：9/20 开机补跑读到 0 封 → 覆盖点不被推进，下次仍覆盖这段区间", () => {
  const since = new Date("2026-09-19T14:41:27.707Z");
  const next = nextWindowStart({ since, newestSeenMailAt: null });
  assert.equal(next, since.toISOString(), "读到 0 封时必须保持原样，下次才能覆盖这段区间");
  assert.notEqual(next, HK("2026-09-20T20:38:00+08:00").toISOString());

  // 紧接着：这次补跑没推进覆盖点，下一天的窗口必须仍然覆盖到 9/19 那段（不会漏）
  const w = computeSince({ windowStart: next, now: HK("2026-09-21T20:00:03+08:00") });
  assert.equal(iso(w.since), since.toISOString());
});

// 2026-09-22 真实事故：Outlook 刚被拉起来、缓存只同步到几小时前 → "取到 0 封"，
// 日报却说"今天没有新邮件"（当天实际来了 130+ 封）。这条守卫决定要不要等一下重读。
test("shouldRetryEmptyRead：读到了、也不陈旧 → 不重试；连最新邮件时间都没有 → 重试", () => {
  assert.equal(shouldRetryEmptyRead({ count: 3, newestSeenMailAt: "2026-09-21T00:30:00Z", since: "2026-09-21T00:00:00Z", coveragePoint: "2026-09-20T23:00:00Z", now: "2026-09-21T01:00:00Z" }), false);
  assert.equal(shouldRetryEmptyRead({ count: 0, newestSeenMailAt: null, since: "2026-09-21T00:00:00Z" }), true);
});

// 2026-09-23 13:25 事故：Outlook 缓存停在**前一天 20:53**（当天一整天的邮件都没进来），
// 覆盖点也是 20:53 —— 两者一致，看起来"很安静"，于是读到 4 封就发了"0 封新邮件"。
// 抓住它的是第二条线：收件箱里最新邮件落后"现在"太久。
test("shouldRetryEmptyRead：缓存整个停在十几小时前（覆盖点也跟着停）→ 仍然要重试", () => {
  assert.equal(shouldRetryEmptyRead({
    count: 4,
    newestSeenMailAt: "2026-09-22T12:53:50.460Z",   // 9/22 20:53 HK
    since: "2026-09-22T12:00:00.000Z",
    coveragePoint: "2026-09-22T12:53:51.460Z",      // 覆盖点 = 最新 +1 秒，一致
    now: "2026-09-23T05:25:00.000Z",                // 9/23 13:25 HK，落后 16 小时
  }), true);
});

// 安静的时候（没有新邮件）也会走一次"强制收信 + 重扫"。这是**故意的**：
// 覆盖点就是上次那封 +1 秒，安静和"缓存卡住"在时间上长得一模一样。
// 代价只是几秒钟（同步完就返回），而漏邮件的代价是整天的邮件都不见了。
test("shouldRetryEmptyRead：没有新邮件（最新那封就压在覆盖点上）→ 照样收一次信", () => {
  assert.equal(shouldRetryEmptyRead({
    count: 0,
    newestSeenMailAt: "2026-09-23T05:47:37.601Z",
    since: "2026-09-22T12:00:00.000Z",
    coveragePoint: "2026-09-23T05:47:38.601Z",
    now: "2026-09-23T06:00:00.000Z",
  }), true);
});

// 2026-09-23 13:47：覆盖点 04:39:52.269Z，见到的最新邮件 04:39:51.269Z —— 就差 1 秒，
// 而那 19 封（含用户刚发的回信）确实还没进缓存。所以这条判据**不留容差**。
test("shouldRetryEmptyRead：比覆盖点差 1 秒也算没同步完（那 1 秒是我们自己加的）", () => {
  assert.equal(shouldRetryEmptyRead({
    count: 18,
    newestSeenMailAt: "2026-09-23T04:39:51.269Z",
    since: "2026-09-22T12:00:00.000Z",
    coveragePoint: "2026-09-23T04:39:52.269Z",
    now: "2026-09-23T05:47:41.000Z",
  }), true);
});

test("shouldRetryEmptyRead：见到的最新邮件就在窗口内 → 是真的没新邮件，不重试", () => {
  assert.equal(shouldRetryEmptyRead({ count: 0, newestSeenMailAt: "2026-09-21T06:00:00Z", since: "2026-09-21T00:00:00Z", now: "2026-09-21T06:30:00Z" }), false);
});

test("shouldRetryEmptyRead：连最新邮件时间都没有（更像没同步完）→ 重试", () => {
  assert.equal(shouldRetryEmptyRead({ count: 0, newestSeenMailAt: null, since: "2026-09-21T00:00:00Z" }), true);
  assert.equal(shouldRetryEmptyRead({ count: 0, newestSeenMailAt: "不是时间", since: "2026-09-21T00:00:00Z" }), true);
});
test("shouldRetryEmptyRead：缓存倒退（见到的最新邮件比上次覆盖点还旧）→ 即使读到几封也要重试", () => {
  // 2026-09-23 真实场景：上次已覆盖到 9/22 21:19，这次只看到 20:53 → 没同步完
  assert.equal(shouldRetryEmptyRead({ count: 4, newestSeenMailAt: "2026-09-22T12:53:50Z", since: "2026-09-22T12:00:00Z", coveragePoint: "2026-09-22T13:19:47Z", now: "2026-09-22T13:30:00Z" }), true);
  // 正常推进（这次看到的比上次新）→ 不重试
  assert.equal(shouldRetryEmptyRead({ count: 4, newestSeenMailAt: "2026-09-23T05:00:00Z", since: "2026-09-22T12:00:00Z", coveragePoint: "2026-09-22T13:19:47Z", now: "2026-09-23T05:01:00Z" }), false);
});

// ---- 强制收信之后还是没更新的邮件：是"缓存坏了"还是"今天真的没邮件"？ ----
// 两者数据上几乎一样（缓存冻结时连 Items.Count 都冻住：9/22 21:20 与 9/23 13:25
// 都是"共 1895 封、最新 9/22 20:53"），所以不能凭"看起来旧"就报警 —— 只有正面证据才报警。

test("staleVerdict：安静的收件箱（收信后确实没有新邮件）→ 只陈述事实，不报警", () => {
  const v = staleVerdict({
    newestSeenMailAt: "2026-09-20T12:00:00Z",   // 一整天没人写信
    prevSeenMailAt: "2026-09-20T12:00:00Z",     // 和上次看到的一模一样
    coveragePoint: "2026-09-20T12:00:01Z",
    since: "2026-09-19T12:00:00Z",
    syncOk: true,
    now: "2026-09-20T20:00:00Z",
  });
  assert.equal(v.level, "info");
  assert.equal(v.why, "quiet-after-sync");
  assert.equal(v.lagHours, 8);
});

test("staleVerdict：强制收信失败/超时 → 报警（我们确知它没同步成）", () => {
  const v = staleVerdict({ newestSeenMailAt: "2026-09-22T12:53:50Z", syncOk: false, now: "2026-09-23T05:25:00Z" });
  assert.equal(v.level, "warn");
  assert.equal(v.why, "sync-failed");
});

test("staleVerdict：收件箱倒退（比上次处理过的还旧）→ 报警", () => {
  const v = staleVerdict({
    newestSeenMailAt: "2026-09-22T12:53:50Z", prevSeenMailAt: "2026-09-22T13:19:47Z",
    syncOk: true, now: "2026-09-22T13:30:00Z",
  });
  assert.equal(v.level, "warn");
  assert.equal(v.why, "went-backwards");
});

test("staleVerdict：连最新邮件时间都没有 → 报警", () => {
  assert.equal(staleVerdict({ newestSeenMailAt: null, syncOk: true }).level, "warn");
});

test("日报渲染：安静时给事实提示，报警时给⚠️横幅（两者不同）", () => {
  const quiet = buildDigest([], { since: "2026-09-19T12:00:00Z", until: "2026-09-20T20:00:00Z", staleInfo: "这次收信后没有更新的邮件；收件箱里最新一封是 2026-09-20 12:00 UTC（约 8 小时前）。" });
  assert.match(quiet.markdown, /ℹ️ 这次收信后没有更新的邮件/);
  assert.ok(!quiet.markdown.includes("邮件可能没读全"), "安静不该报警");
  const bad = buildDigest([], { since: "2026-09-22T12:00:00Z", until: "2026-09-23T05:25:00Z", staleNotice: "强制收信没成功，可能还有邮件没读进来（收件箱里最新一封：2026-09-22 12:53 UTC（约 16 小时前））。" });
  assert.match(bad.markdown, /⚠️ \*\*邮件可能没读全\*\*/);
  assert.ok(!/ℹ️ 这次收信后/.test(bad.markdown), "报警时不该同时出现事实提示");
});

test("nextWindowStart：缓存没同步完时绝不把窗口拉回去（只前进不后退）", () => {
  const since = "2026-09-23T04:39:52.269Z";
  assert.equal(nextWindowStart({ since, newestSeenMailAt: "2026-09-23T05:47:37.601Z" }), "2026-09-23T05:47:38.601Z");
  assert.equal(nextWindowStart({ since, newestSeenMailAt: "2026-09-22T20:53:00.000Z" }), since, "见到的最新邮件比覆盖点旧时，保持覆盖点不动");
});