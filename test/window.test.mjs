// 统计窗口测试：**标准化到 20:00 锚点** + **一封都不许漏**
//
// 用户的规则："当天邮件整理的时间标准化为前一天晚上 8 点到整理邮件（正常是到当天晚上 8 点这 24 小时），
// 如果报告出得晚了，比如 8:30 才出，那就一直到最新的。"
//
// 同时必须守住旧底线：桥接层读的是 Outlook 本地缓存，缓存没同步完时会"读到 0 封"，
// 那种情况下**绝不能**把覆盖点推到"现在"，否则那批邮件永久跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDigest } from "../lib/digest.mjs";
import { ROOT } from "../lib/config.mjs";
import { computeSince, nextWindowStart, standardWindowStart, shouldRetryEmptyRead, shouldRecheckAfterSync, shouldHoldWindow, staleVerdict, shouldCatchUp } from "../lib/window.mjs";

const HK = (s) => new Date(s);
const iso = (d) => d.toISOString();

// ---------- 登录补跑门禁（2026-10-23 事故：19:22 登录发一封，20:00 又发一封）----------
test("shouldCatchUp：白天登录（还没到 20:00）→ 不补，交给 20:00 那次", () => {
  const now = HK("2026-10-23T19:22:00+08:00");
  // 今天早上手动跑过
  assert.equal(shouldCatchUp({ lastRunAt: iso(HK("2026-10-23T09:44:00+08:00")), now }), false);
  // 昨天 20:00 正常发过，今天还没发
  assert.equal(shouldCatchUp({ lastRunAt: iso(HK("2026-10-22T20:00:30+08:00")), now }), false);
});

test("shouldCatchUp：20:00 那趟确实没跑（关机/注销）→ 登录后补", () => {
  const now = HK("2026-10-23T21:30:00+08:00");
  assert.equal(shouldCatchUp({ lastRunAt: iso(HK("2026-10-22T20:00:30+08:00")), now }), true);
  // 隔了一天没开机，早上登录也要补
  const morning = HK("2026-10-24T09:10:00+08:00");
  assert.equal(shouldCatchUp({ lastRunAt: iso(HK("2026-10-22T20:00:30+08:00")), now: morning }), true);
});

test("shouldCatchUp：20:00 刚发过又登录 → 不补", () => {
  const now = HK("2026-10-23T20:40:00+08:00");
  assert.equal(shouldCatchUp({ lastRunAt: iso(HK("2026-10-23T20:00:05+08:00")), now }), false);
});

test("shouldCatchUp：没有记录 / 记录损坏 → 宁可补一次", () => {
  const now = HK("2026-10-23T19:22:00+08:00");
  assert.equal(shouldCatchUp({ lastRunAt: null, now }), true);
  assert.equal(shouldCatchUp({ lastRunAt: "not-a-date", now }), true);
});

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

// ---- 2026-10-02：补一段的**理由**必须说实话 ----
// 真实数据：10/01 20:00 正常跑过（lastRunAt = 2026-10-01T12:00:16.079Z），只是覆盖点停在
// 10/01 09:59（= 2026-10-01T01:59:23.333Z，那之后收件箱确实没有更新的邮件）。旧文案却断言
// "中间有整天没跑过" —— 看日志的人会以为任务漏跑了，于是去查计划任务，白忙一场。

test("computeSince：上次运行跑过、只是没有新邮件 → 理由不许说「整天没跑过」（10/02 真实数据）", () => {
  const w = computeSince({
    windowStart: "2026-10-01T01:59:23.333Z",        // 覆盖点停在 10/01 09:59
    lastSeenMailAt: "2026-10-01T01:59:22.333Z",
    lastRunAt: "2026-10-01T12:00:16.079Z",          // 10/01 20:00 那次正常运行
    now: HK("2026-10-02T10:49:11+08:00"),
  });
  assert.equal(iso(w.since), "2026-10-01T01:59:23.333Z", "保守取值不变：仍从覆盖点补起");
  assert.ok(!/整天没跑过/.test(w.why), `理由在说谎（明明是正常运行过的）：${w.why}`);
  assert.match(w.why, /没有更新的邮件/, "要说清真正的原因：那次运行之后收件箱没有更新");
  assert.match(w.why, /避免漏邮件/, "保守取值的用意仍要写明白");
});

test("computeSince：真的整天没跑（上次运行早于标准起点）→ 保留「整天没跑过」这个理由", () => {
  const w = computeSince({
    windowStart: "2026-09-19T11:00:01.000Z",
    lastRunAt: "2026-09-18T12:00:00.000Z",          // 上一次运行远早于标准起点
    now: HK("2026-09-21T20:05:00+08:00"),
  });
  assert.equal(iso(w.since), "2026-09-19T11:00:01.000Z");
  assert.match(w.why, /整天没跑过/, "真的漏跑了就得照实说");
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

// ---- 2026-09-28 事故：同步"秒回"却什么都没下载 ----
// 真实数据：14:43 那次 -Sync 只花了 3 秒就报"完成"，收件箱总数 1851、最新邮件 9/26 17:17
// 都没变 —— 而服务器上从 12:38 起已经有 11 封。缓存冻结的位置**恰好等于覆盖点**（就差
// 程序自己加的 1 秒），所以"倒退/早于窗口起点/同步失败"三条线全都判不出来，
// 日报于是发了"无新邮件"。下面这批用例就是那次误报的补丁。

test("staleVerdict：桥接层报告没连上 Exchange → 报警，理由比笼统的 sync-failed 具体", () => {
  const v = staleVerdict({
    newestSeenMailAt: "2026-09-26T09:17:14.200Z",
    prevSeenMailAt: "2026-09-26T09:17:14.200Z",   // 和上次一模一样（缓存冻结）
    since: "2026-09-26T09:17:15.200Z",            // 就差那 1 秒 → 原来这判断不出来
    syncOk: false,
    syncWhy: "not-connected",
    now: "2026-09-28T06:43:00Z",
  });
  assert.equal(v.level, "warn");
  assert.equal(v.why, "not-connected");
  assert.equal(v.lagHours, 45, "缓存落后 45 小时这件事必须能算出来");
});

test("staleVerdict：同步超时 → 报警理由是 sync-timeout", () => {
  const v = staleVerdict({
    newestSeenMailAt: "2026-09-26T09:17:14.200Z", syncOk: false,
    syncWhy: "sync-timeout", now: "2026-09-28T06:43:00Z",
  });
  assert.equal(v.level, "warn");
  assert.equal(v.why, "sync-timeout");
});

test("shouldRecheckAfterSync：同步 3 秒就'完成'且缓存纹丝不动 → 再等一会儿重读", () => {
  const meta = { total: 1851, newestSeen: "2026-09-26T09:17:14.200Z" };
  assert.equal(shouldRecheckAfterSync({ before: meta, after: { ...meta }, syncWhy: null, elapsedMs: 3100 }), true);
});

test("shouldRecheckAfterSync：同步花了正常时间 → 认为它真干了活，不再等", () => {
  const meta = { total: 1851, newestSeen: "2026-09-26T09:17:14.200Z" };
  assert.equal(shouldRecheckAfterSync({ before: meta, after: { ...meta }, syncWhy: null, elapsedMs: 12500 }), false);
});

test("shouldRecheckAfterSync：缓存变了（总数或最新邮件）→ 已经读到东西，不再等", () => {
  const before = { total: 1851, newestSeen: "2026-09-26T09:17:14.200Z" };
  assert.equal(shouldRecheckAfterSync({ before, after: { total: 1862, newestSeen: before.newestSeen }, syncWhy: null, elapsedMs: 3000 }), false);
  assert.equal(shouldRecheckAfterSync({ before, after: { total: before.total, newestSeen: "2026-09-28T06:38:02.206Z" }, syncWhy: null, elapsedMs: 3000 }), false);
});

test("shouldRecheckAfterSync：同步本身报错 → 不靠干等解决（日报里报警就够了）", () => {
  const meta = { total: 1851, newestSeen: "2026-09-26T09:17:14.200Z" };
  assert.equal(shouldRecheckAfterSync({ before: meta, after: { ...meta }, syncWhy: "not-connected", elapsedMs: 3000 }), false);
  assert.equal(shouldRecheckAfterSync({ before: meta, after: { ...meta }, syncWhy: "sync-timeout", elapsedMs: 3000 }), false);
});

test("shouldRecheckAfterSync：没有耗时数据 → 不凭空多等", () => {
  const meta = { total: 1851, newestSeen: "2026-09-26T09:17:14.200Z" };
  assert.equal(shouldRecheckAfterSync({ before: meta, after: { ...meta }, syncWhy: null, elapsedMs: null }), false);
  assert.equal(shouldRecheckAfterSync({ before: null, after: null, syncWhy: null, elapsedMs: 100 }), true, "两个 meta 都缺 → 没有证据表明缓存动过，仍值得再等一次");
});

// ---- 2026-09-29 事故：一封都没读到，但缓存里明明有窗口内的邮件 ----
// 真实数据：9/29 09:01 那次，窗口起点 2026-09-28T10:03:13Z，缓存最新邮件 2026-09-28T12:03:34Z
//（= 用户 20:03 那封指令回信）—— 落在窗口内却"取到 0 封"（桥接层把单元素列表写成了裸对象）。
// 当时覆盖点被推进到 12:03:35Z（就是那封**没读到**的邮件 +1 秒），只因为当晚 20:00 的标准窗口
// 起点（12:00:00Z）更早才没把指令丢掉。下面这条守卫就是防这个。

test("shouldHoldWindow：没读到任何邮件、缓存最新邮件却在窗口内 → 冻结覆盖点", () => {
  assert.equal(shouldHoldWindow({
    takenCount: 0,
    newestSeenMailAt: "2026-09-28T12:03:34.536Z",   // 用户那封指令回信
    since: "2026-09-28T10:03:13.177Z",              // 本次窗口起点
  }), true);
});

test("shouldHoldWindow：正常读到邮件 → 不冻结", () => {
  assert.equal(shouldHoldWindow({
    takenCount: 3, newestSeenMailAt: "2026-09-28T12:03:34.536Z", since: "2026-09-28T10:03:13.177Z",
  }), false);
});

test("shouldHoldWindow：真的没有新邮件（缓存最新邮件早于窗口起点）→ 不冻结", () => {
  assert.equal(shouldHoldWindow({
    takenCount: 0, newestSeenMailAt: "2026-09-28T09:00:00.000Z", since: "2026-09-28T10:03:13.177Z",
  }), false);
});

test("shouldHoldWindow：缺数据 → 不冻结（宁可少一层保护，也不要卡住窗口推进）", () => {
  assert.equal(shouldHoldWindow({ takenCount: 0, newestSeenMailAt: null, since: "2026-09-28T10:03:13.177Z" }), false);
  assert.equal(shouldHoldWindow({ takenCount: 0, newestSeenMailAt: "2026-09-28T12:03:34.536Z", since: null }), false);
});

// ---- 2026-10-02 事故：二次重读**读到了新邮件**，日报却还写"这次收信后没有更新的邮件" ----
// 真实运行（10:49 手动跑）：第一次读 = 0 封（缓存停在 10/01 09:59），强制收信空转 2 秒，
// 等 20 秒后二次重读 → 读到 8 封（最新 10/02 02:36Z）。可那之后程序仍然进了"没同步完"的
// 分支，于是拿**刚读到的新邮件时间**写下："这次收信后没有更新的邮件；收件箱里最新一封是
// 2026-10-02 02:36 UTC（约 0 小时前）" —— 日报顶上这句和正文里 7 封新邮件直接打架。
// 2026-09-29 12:00 也一模一样（二次重读读到 14 封，照样写了这句）。
//
// 根因：判定「收件箱没同步完」用的是**二次重读之前**的 meta，二次重读更新了 meta 却没重判。

test("二次重读读到新邮件后：那次'没同步完'的判定必须翻案（10/02 真实数据）", () => {
  const coveragePoint = "2026-10-01T01:59:23.333Z";   // 上次覆盖点（= 10/01 09:59）
  const since = "2026-10-01T01:59:23.333Z";           // 本次窗口起点
  const now = "2026-10-02T02:50:02.569Z";             // 二次重读完成那一刻
  const staleArgs = (count, newestSeen) => ({ count, newestSeenMailAt: newestSeen, since, coveragePoint, now });

  // 二次重读之前：0 封、缓存停在 10/01 09:59（落后 25 小时）→ 判定"没同步完"，重读是对的
  assert.equal(shouldRetryEmptyRead(staleArgs(0, "2026-10-01T01:59:22.333Z")), true);
  // 二次重读之后：8 封、最新 10/02 02:36（就在 14 分钟前）→ 缓存已经同步完，必须翻案
  assert.equal(shouldRetryEmptyRead(staleArgs(8, "2026-10-02T02:36:01.602Z")), false,
    "二次重读读到了新邮件，就不能再说'收件箱没同步完'");

  // 翻案之后再走 staleVerdict：这次是"确实有新邮件"，绝不能给出要写进日报的提示
  const v = staleVerdict({
    newestSeenMailAt: "2026-10-02T02:36:01.602Z",
    prevSeenMailAt: "2026-10-01T01:59:22.333Z",
    since, syncOk: true, now,
  });
  assert.equal(v.level, "info", "安静判定本身不报警");
  assert.equal(v.lagHours, 0);
  // 说明为什么这条 info 在"二次重读读到东西"之后**不能**再用：它的措辞就是"没有更新的邮件"，
  // 而这次明明读到了 8 封。所以守卫必须挡在 staleVerdict 之前，而不是只改措辞。
});

test("结构守卫：二次重读之后必须先重判'没同步完'，再决定要不要写提示", () => {
  const src = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  const recheckAt = src.indexOf("二次重读完成");
  assert.ok(recheckAt > 0, "没找到二次重读的日志，测试本身失效了");
  const reJudgeAt = src.indexOf("shouldRetryEmptyRead(staleArgs(meta1))", recheckAt);
  const verdictAt = src.indexOf("staleVerdict({", recheckAt);
  assert.ok(reJudgeAt > 0, "二次重读之后必须重新判一次 shouldRetryEmptyRead，否则会拿新邮件时间写'没有更新的邮件'");
  assert.ok(verdictAt > 0, "没找到 staleVerdict 调用，测试本身失效了");
  assert.ok(reJudgeAt < verdictAt, "重判必须发生在 staleVerdict 之前（先翻案，再决定措辞）");
  assert.match(src, /rechecked && !shouldRetryEmptyRead\(staleArgs\(meta1\)\)/,
    "重判必须和'二次重读真的发生过'绑定（没重读时行为保持不变）");
});

// ---- 2026-10-09 事故：本地缓存"有洞"（一天里中段缺了一批邮件） ----
// 真实数据：10:22 那次收件箱 1905 封 → 20:00 那次 1906 封（当天实际来了 15 封，却只多出 1 封）
// → 21:05 变成 1920 封（+14，正好是那 14 封回来了）。缺的 14 封 = 10/09 09:06–14:40，
// 其中 13:35 正是用户那封「删去待办10」的指令邮件 —— 程序从没见过它，指令自然没执行。
// 为什么老判断全都放行：newestSeen 是 19:11（一小时前，很新鲜）、总数也没倒退，
// 而"中段空洞"这两条信号都挡不住。新的正面证据：桥接层用 PR_CONTENT_COUNT（服务器说有多少条）
// 与本地 Items.Count 相比，差多少就是洞。

test("shouldRetryEmptyRead：本地比服务器少 N 封 → 必须重试（最新那封再新鲜也没用）", () => {
  const base = {
    count: 7, newestSeenMailAt: "2026-10-09T11:11:26.224Z",   // 19:11 HKT，一小时前，看着很正常
    since: "2026-10-08T12:00:00.000Z", coveragePoint: "2026-10-08T12:00:00.000Z",
    now: "2026-10-09T12:00:10.000Z",
  };
  assert.equal(shouldRetryEmptyRead({ ...base, contentGap: 14 }), true, "有洞就必须收信重读");
  assert.equal(shouldRetryEmptyRead({ ...base, contentGap: 0 }), false, "没洞时行为完全照旧（不多跑一次同步）");
});

test("staleVerdict：本地缓存有洞 → warn，理由说清少了多少封，而不是那句'没有更新的邮件'", () => {
  const v = staleVerdict({
    newestSeenMailAt: "2026-10-09T11:11:26.224Z", prevSeenMailAt: "2026-10-09T02:18:19.804Z",
    since: "2026-10-08T12:00:00.000Z", coveragePoint: "2026-10-08T12:00:00.000Z",
    syncOk: true, now: "2026-10-09T12:00:10.000Z", contentGap: 14,
  });
  assert.equal(v.level, "warn");
  assert.equal(v.why, "cache-incomplete");
  assert.equal(v.contentGap, 14);
  assert.equal(staleVerdict({
    newestSeenMailAt: "2026-10-09T11:11:26.224Z", since: "2026-10-08T12:00:00.000Z",
    syncOk: true, now: "2026-10-09T12:00:10.000Z", contentGap: 0,
  }).level, "info", "没洞时仍是那条不吓人的事实提示");
});

test("结构守卫：桥接层要报出'本地几封 / 服务器几封'，主流程要把它当证据用", () => {
  const bridge = fs.readFileSync(path.join(ROOT, "outlook-bridge.ps1"), "utf8");
  const main = fs.readFileSync(path.join(ROOT, "main-outlook.mjs"), "utf8");
  assert.match(bridge, /0x36020003/, "桥接层必须读服务器侧的 PR_CONTENT_COUNT（否则中段空洞看不见）");
  assert.match(bridge, /contentGap/, "差值要写进 meta，Node 侧才用得上");
  assert.match(bridge, /gap=\$contentGap/, "每次 DUMPED 都打印本地/服务器两个数，便于事后取证");
  assert.match(main, /contentGap: Number\(m\?\.contentGap \|\| 0\)/, "staleArgs 必须把差值带进判断");
  assert.match(main, /contentGap: Number\(meta1\?\.contentGap \|\| 0\)/, "staleVerdict 也要拿到差值");
  assert.match(main, /cache-incomplete/, "报警措辞要有这一档");
});