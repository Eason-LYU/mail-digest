// 统计窗口的推进逻辑（纯函数，可测试）
//
// 两件事必须同时成立：
//
// 1) **窗口要标准化**：每天的报告覆盖「前一天 20:00 → 本次运行」。
//    日程任务是每天 20:00 跑，所以正常就是「前一天 20:00 → 今天 20:00」这 24 小时；
//    如果这次跑晚了（比如 20:30 才跑），窗口**一直延伸到最新那封邮件**，不会只到 20:00 就截断。
//
// 2) **一封邮件都不许漏**：桥接层读的是 Outlook 本地缓存（OST）。如果运行那一刻缓存还没同步完
//    （刚开机、Outlook 正在首次同步），就会"读到 0 封"。这种情况下**绝不能**把覆盖点推进到"现在"，
//    否则那批其实已到达、只是还没同步的邮件就永久跳过了。
//
// 所以维护一个"覆盖点"（watermark）：它只会随**真正读到的最新邮件**前进，
// 读到 0 封时原地不动。窗口起点 = 标准起点 与 覆盖点 之间的**安全取值**（见 computeSince 注释）。

/** 香港时间当天（或某天）的 anchorHour 点：+08:00 无夏令时，直接按固定偏移算 */
function anchorOf(now, anchorHour = 20) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const hh = String(anchorHour).padStart(2, "0");
  return new Date(Date.parse(`${day}T${hh}:00:00+08:00`));
}

/**
 * 标准窗口起点 = （香港时间"今天"的 20:00）− 24 小时。
 * 例：本次运行在 9/21 20:00 或 9/21 20:30 → 起点都是 9/20 20:00；
 *     本次运行在 9/21 09:00（提前手动跑）→ 起点仍是 9/20 20:00。
 */
export function standardWindowStart(now = new Date(), { anchorHour = 20 } = {}) {
  return new Date(anchorOf(now, anchorHour).getTime() - 24 * 3600 * 1000);
}

const DAY = 24 * 3600 * 1000;

/**
 * 决定本次要读的起点。
 *
 * @param {object} p
 * @param {string|null} p.windowStart    上次记录的"覆盖点"（读到的最新邮件 +1 秒；0 封时不推进）
 * @param {string|null} p.lastSeenMailAt 上次真正读到的最新邮件时间（兜底用）
 * @param {string|null} p.lastRunAt      上次运行时间（兜底用）
 * @param {number} p.hours               默认回溯小时数（没有历史/超过上限时用）
 * @param {number} p.floorDays           最多回溯天数（防止一次补出一个月）
 * @param {boolean} p.explicitHours      命令行是否显式给了 --hours（给了就以它为准）
 * @param {number} p.anchorHour          锚点小时（默认 20 = 晚上 8 点）
 * @param {Date} p.now
 */
export function computeSince({
  windowStart, lastSeenMailAt, lastRunAt, hours = 24, floorDays = 7,
  explicitHours = false, anchorHour = 20, now = new Date(),
} = {}) {
  const floor = new Date(now.getTime() - floorDays * DAY);
  const byHours = new Date(now.getTime() - hours * 3600 * 1000);

  if (explicitHours) { const s = standardWindowStart(now, { anchorHour }); return { since: byHours, labelStart: byHours, why: "--hours 显式指定", standard: s }; }

  const standard = standardWindowStart(now, { anchorHour });   // 前一天 20:00

  // 覆盖点：优先用 windowStart（已经实现"0 封不推进"），其次是"上次见到的最新邮件 +1 秒"，最后是上次运行时间
  let mark = null;
  for (const [iso, plus1s] of [[windowStart, false], [lastSeenMailAt, true], [lastRunAt, false]]) {
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    mark = plus1s ? new Date(d.getTime() + 1000) : d;
    break;
  }

  if (!mark) return { since: standard, labelStart: standard, why: "无历史记录，用标准窗口（前一天 20:00 起）", standard };

  if (mark < floor) {
    // 记录太旧：从"回溯上限"补起，既不会漏掉这一段，也不会一次补出一个月
    return { since: floor, labelStart: floor, why: `历史记录超过 ${floorDays} 天上限，从上限补起`, standard };
  }

  // 起点取"标准窗口起点"和"已覆盖点"里**更早**的那个：
  //   - 覆盖点在标准起点之后（今天手动跑过）→ 用标准起点（要的就是标准那一天）
  //   - 覆盖点在标准起点之前（那天没读到邮件/关机）→ 用覆盖点（宁可多带一段，也绝不漏）
  // 由此产生的少量重叠，由 lib/reported.mjs 的"已报告名单"过滤掉，不会重复刷屏。
  const since = mark < standard ? mark : standard;

  // 显示用的窗口起点：差得不多（2 小时内）就按标准 20:00 显示，读起来才是稳定的"那一天"；
  // 差得多说明真的补了一段（关机/长期没邮件），这时如实显示真实起点，免得报告里的邮件
  // 落在标题窗口之外，看着莫名其妙。
  const labelStart = standard.getTime() - since.getTime() <= 2 * 3600 * 1000 ? standard : since;

  const why = since.getTime() === standard.getTime()
    ? `标准窗口（前一天 ${String(anchorHour).padStart(2, "0")}:00 起）`
    : labelStart.getTime() === standard.getTime()
      ? `标准窗口（前一天 ${String(anchorHour).padStart(2, "0")}:00 起；为确保不漏，实际从 ${since.toISOString()} 起读）`
      : `上次只覆盖到 ${since.toISOString()}（中间有整天没跑过），从那里补起，避免漏邮件`;

  return { since, labelStart, why, standard };
}

/**
 * 本次运行之后，下次的"覆盖点"应该是什么。
 * - 读到了邮件 → 推进到"最新那封 + 1 秒"（避免重复读同一封）
 * - 一封都没读到 → **保持不变**（这样缓存没同步完也不会漏邮件）
 */
export function nextWindowStart({ since, newestSeenMailAt }) {
  if (newestSeenMailAt) {
    const d = new Date(newestSeenMailAt);
    // 绝不倒退：缓存没同步完时，见到的最新邮件可能比已覆盖点还旧，
    // 照它推进会把窗口拉回去、重复报旧邮件（2026-09-23 差点发生）。
    if (!Number.isNaN(d.getTime())) {
      const floor = Date.parse(since || "");
      const next = d.getTime() + 1000;
      return new Date(Number.isNaN(floor) ? next : Math.max(next, floor)).toISOString();
    }
  }
  return new Date(since).toISOString();
}

/**
 * 读到 0 封邮件时，要不要等一下重读？
 *
 * 为什么需要：Outlook 读的是**本地缓存**。20:00 触发时 Outlook 常常还没启动
 * （脚本会把它拉起来），这时缓存可能只同步到几小时前 —— 于是"取到 0 封"。
 * 2026-09-22 真实发生：收件箱总数一天涨了 130 多封，脚本却报"今天没有新邮件"。
 *
 * 判据故意保守：**只有一封都没读到**才重试（正常情况下不会多花时间），
 * 而且不判断"该不该有新邮件"——那是猜；重读一次是纯收益。
 */
export function shouldRetryEmptyRead({ count = 0, newestSeenMailAt = null, since = null, coveragePoint = null, now = null, maxLagHours = 6 } = {}) {
  // 【最硬的信号】缓存"倒退"：这次见到的最新邮件，**没有超过上次已经覆盖到的位置**
  // → 收件箱在系统眼里倒退了，只可能是本地缓存没同步完。
  // 2026-09-23 13:47 实测：上次覆盖到 04:39:52.269Z，这次见到的最新邮件是 04:39:51.269Z
  // —— 就差这 1 秒，而那 19 封（含用户刚发的回信）确实还没进缓存。
  // 所以这里**故意不留容差**：安静的时候确实会多跑一次同步，但漏一封邮件的代价大得多。
  // （2026-09-23 13:25 就是反例：缓存只同步到前一天 20:53，却报了"0 封新邮件"。）
  const tc = Date.parse(coveragePoint || "");
  const tn = Date.parse(newestSeenMailAt || "");
  if (Number.isNaN(tn)) return true;              // 连"见到的最新邮件"都没有 → 更像没同步完
  if (!Number.isNaN(tc) && tn < tc) return true;
  // 【第二条线】收件箱里最新邮件落后"现在"太久：邮件每天都在来，缓存不可能半天不动。
  // 这条能抓住"覆盖点本身也在缓存后面"的情况（13:25 那种：覆盖点=20:53，缓存=20:53，
  // 看起来一致，其实整个收件箱都停在 16 小时前）。
  const tw = Date.parse(now || "") || Date.now();
  if (tw - tn > maxLagHours * 3600 * 1000) return true;
  if (count > 0) return false;                    // 读到了、又不陈旧，就不用重试
  if (!since) return true;                        // 没有窗口起点（很少见）也值得重读一次
  return false;
}