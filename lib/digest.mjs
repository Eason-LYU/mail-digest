// 日报渲染：生成 HTML（用于发邮件）+ Markdown（用于本地存档）
import { effectiveRank, oneLine } from "./classify.mjs";
import { dueLabel } from "./todos.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Hong_Kong", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
  } catch { return iso; }
}

/**
 * 要不要发这封日报。
 * 关键规则（用户要求）：**即使今天没有新邮件，只要台账里还有未完成待办，也要发**——
 * 因为截止日在不断逼近，"还剩几天"本身就是必须每天看到的信息。
 * 只有"没有新邮件 且 台账也没有未完成事项"时才跳过，避免纯噪音。
 */
export function shouldSend({ totalMails = 0, pendingTodos = 0, force = false } = {}) {
  return Boolean(force || totalMails > 0 || pendingTodos > 0);
}

export function buildDigest(messages, meta = {}) {
  const enriched = messages
    .map((m) => ({ ...m, _c: effectiveRank(m), _line: oneLine(m) }))
    .sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));

  const action = enriched.filter((m) => m._c.bucket === "action")
    .sort((a, b) => b._c.score - a._c.score);
  const watch = enriched.filter((m) => m._c.bucket === "watch");
  const info = enriched.filter((m) => m._c.bucket === "info");

  // 第二档只详细展开前 N 条，其余压成一行一条——否则真实邮箱里几十条群发通知会淹掉日报
  const WATCH_LIMIT = Number(meta.watchLimit ?? 12);
  const watchTop = watch.slice(0, WATCH_LIMIT);
  const watchMore = watch.slice(WATCH_LIMIT);

  const unread = enriched.filter((m) => !m.isRead).length;
  const withAttach = enriched.filter((m) => m.hasAttachments).length;
  const ignored = enriched.filter((m) => m._c.ignored).length;
  // 「待你处理」：不是今天新到的，而是进了清单、要一直保留到你回信说"收到/已读"的
  const carried = enriched.filter((m) => m.carryOver);
  const freshCount = enriched.length - carried.length;
  // 一律以"本次运行的时刻"为基准（meta.until），不用 Date.now()：
  // 否则跨零点重放同一批数据会算出不同的天数，也没法写稳定的测试。
  const runNow = Number.isNaN(Date.parse(meta.until)) ? Date.now() : Date.parse(meta.until);
  const carryMark = (m) => {
    const d = Math.max(0, Math.floor((runNow - new Date(m.receivedDateTime).getTime()) / 86400000));
    return d >= 1 ? `${d} 天前` : "今天";
  };
  const since = meta.since ? fmtTime(meta.since) : "—";
  const until = meta.until ? fmtTime(meta.until) : fmtTime(new Date().toISOString());

  const dateStr = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  // 距上次运行隔了多久——万一是"电脑关了好几天"，你看日报时能一眼发现
  let gapNote = "";
  if (meta.previousRun) {
    const gapH = (runNow - new Date(meta.previousRun).getTime()) / 3600000;
    if (gapH >= 36) gapNote = `（间隔 ${Math.round(gapH / 24)} 天，期间可能没开机）`;
    else if (gapH >= 2) gapNote = `（间隔 ${Math.round(gapH)} 小时）`;
  }
  // 主题在下面算（要看台账里最近的那个截止日）

  // ---------- 共用：单封邮件的两种渲染 ----------
  // 分档可能来自 LLM（m.rank，理由在 why 里）或本地规则（reasons 数组），两种都要能渲染
  const chips = (m) => {
    if (Array.isArray(m._c.reasons) && m._c.reasons.length) return m._c.reasons.slice(0, 4);
    if (m._c.why) return [m._c.why];
    return [];
  };

  const htmlItem = (m, rank) => `
    <div style="border-left:3px solid ${m._c.bucket === "action" ? "#e5484d" : m._c.bucket === "watch" ? "#f5a524" : "#d0d5dd"};padding:8px 0 8px 12px;margin:0 0 14px 0;">
      <div style="font:600 15px/1.4 'Microsoft YaHei',Segoe UI,sans-serif;color:#101828;">
        ${rank ? `<span style="color:#e5484d;">${rank}.</span> ` : ""}${esc(m.subject || "(无主题)")}
      </div>
      ${m.subjectZh ? `<div style="font:14px/1.5 'Microsoft YaHei',sans-serif;color:#475467;margin-top:2px;">译：${esc(m.subjectZh)}</div>` : ""}
      ${m.actionZh ? `<div style="background:#fffaeb;border-left:3px solid #f79009;padding:6px 8px;margin:7px 0 0 0;font:14px/1.5 'Microsoft YaHei',sans-serif;color:#93370d;"><b>👉 要做什么：</b>${esc(m.actionZh)}</div>` : ""}
      <div style="font:13px/1.5 'Microsoft YaHei',Segoe UI,sans-serif;color:#667085;margin-top:3px;">
        ${esc(m._c.senderName || m._c.sender)} · ${fmtTime(m.receivedDateTime)}
        ${m.isRead ? "" : ' · <span style="color:#1570ef;font-weight:600;">未读</span>'}
        ${m.hasAttachments ? " · 📎 有附件" : ""}
        ${m.carryOver ? ` · <span style="color:#b54708;font-weight:600;">🔁 待你处理（${carryMark(m)}）</span>` : ""}
        ${m.importance === "high" ? " · ‼️ 高重要性" : ""}
        ${m.flag?.flagStatus === "flagged" ? " · 🚩 已标旗" : ""}
      </div>
      ${chips(m).length ? `<div style="margin-top:5px;">${chips(m).map((c) =>
        `<span style="display:inline-block;background:#fef3f2;color:#b42318;border-radius:4px;padding:1px 6px;font:12px 'Microsoft YaHei',sans-serif;margin-right:4px;">${esc(c)}</span>`).join("")}
        <span style="color:#98a2b3;font:12px 'Microsoft YaHei',sans-serif;">匹配度 ${m._c.score}</span></div>` : ""}
      ${(m.lineZh || m._line) ? `<div style="font:13px/1.6 'Microsoft YaHei',Segoe UI,sans-serif;color:#344054;margin-top:6px;">${esc(m.lineZh || m._line)}</div>` : ""}
      ${(m.lineZh && m._line) ? `<div style="font:12px/1.6 'Microsoft YaHei',sans-serif;color:#98a2b3;margin-top:2px;">原文：${esc(m._line.slice(0, 110))}${m._line.length > 110 ? "…" : ""}</div>` : ""}
      ${m.webLink ? `<div style="margin-top:6px;"><a href="${esc(m.webLink)}" style="color:#1570ef;font:13px 'Microsoft YaHei',sans-serif;">在 Outlook 中打开 →</a></div>` : ""}
    </div>`;

  const mdItem = (m, rank) => [
    `- ${rank ? `**${rank}.** ` : ""}**${m.subject || "(无主题)"}**`,
    m.subjectZh ? `  - 译：${m.subjectZh}` : null,
    m.actionZh ? `  - 👉 **要做什么：${m.actionZh}**` : null,
    `  - 发件人：${m._c.senderName || m._c.sender} · ${fmtTime(m.receivedDateTime)}${m.isRead ? "" : " · 未读"}${m.hasAttachments ? " · 📎有附件" : ""}${m.carryOver ? ` · 🔁 待你处理（${carryMark(m)}）` : ""}`,
    chips(m).length ? `  - 为何重要：${chips(m).join(" / ")}（匹配度 ${m._c.score}）` : null,
    (m.lineZh || m._line) ? `  - 摘要：${m.lineZh || m._line}` : null,
    (m.lineZh && m._line) ? `  - 原文：${m._line.slice(0, 110)}` : null,
    m.webLink ? `  - 链接：${m.webLink}` : null,
  ].filter(Boolean).join("\n");

  // ---------- 待办指令邮件的处理结果（你发来的"做完了 / 新增 / 改期"）----------
  const cmd = meta.commands || null;
  const opText = (o) => {
    switch (o?.op) {
      case "done": return `✅ 完成：${o.title}`;
      case "add": return `➕ 新增：${o.title}${o.due ? `（${o.due} 到期）` : "（无截止日）"}`;
      case "set_due": return `🔁 改期：${o.title} → ${o.to ?? o.due ?? "(未指定)"}`;
      case "delete": return `🗑 删除：${o.title}`;
      case "handled": return `📭 已读/不用管：${o.title}`;
      default: return `· ${String(o?.op || "")}`;
    }
  };
  const cmdApplied = cmd?.applied || [];
  const cmdFailed = cmd?.failed || [];
  const cmdHtml = (cmdApplied.length || cmdFailed.length) ? `
  <div style="font:700 16px/1.4 'Microsoft YaHei',sans-serif;color:#027a48;margin:0 0 8px 0;">📮 已按你的邮件更新台账（${cmdApplied.length} 项）</div>
  <div style="font:13px/1.9 'Microsoft YaHei',sans-serif;color:#344054;">
    ${cmdApplied.map((o) => esc(opText(o))).join("<br>")}
    ${cmdFailed.length ? `<br><span style="color:#b42318;">未识别 ${cmdFailed.length} 项：${esc(cmdFailed.map((f) => `${f.ref || f.title || ""}（${f.reason}）`).join("；"))}</span>` : ""}
  </div>
  <div style="border-top:1px solid #eaecf0;margin:16px 0;"></div>` : "";

  const cmdMd = (cmdApplied.length || cmdFailed.length) ? [
    `## 📮 已按你的邮件更新台账（${cmdApplied.length} 项）`,
    "",
    ...cmdApplied.map((o) => `- ${opText(o)}`),
    ...(cmdFailed.length ? [`- ⚠️ 未识别 ${cmdFailed.length} 项：${cmdFailed.map((f) => `${f.ref || f.title || ""}（${f.reason}）`).join("；")}`] : []),
    "",
  ] : [];

  // ---------- 待办台账（含往日未完成的）----------
  const todos = meta.todos || null;
  const todoItems = todos?.shown || [];

  const todoHtmlBlock = todoItems.length ? `
  <div style="font:700 16px/1.4 'Microsoft YaHei',sans-serif;color:#5925dc;margin:0 0 10px 0;">📌 待办台账（含往日未完成，共 ${todos.total} 条）</div>
  ${todoItems.map((t, i) => {
    const overdue = t.daysLeft !== null && t.daysLeft !== undefined && t.daysLeft < 0;
    const soon = t.daysLeft !== null && t.daysLeft !== undefined && t.daysLeft >= 0 && t.daysLeft <= 3;
    const bar = overdue ? "#e5484d" : soon ? "#f79009" : "#7f56d9";
    const whenColor = overdue ? "#b42318" : soon ? "#b54708" : "#475467";
    return `<div style="border-left:3px solid ${bar};padding:5px 0 5px 12px;margin:0 0 10px 0;">
      <div style="font:600 14px/1.45 'Microsoft YaHei',sans-serif;color:#101828;">
        <span style="color:${whenColor};">[${i + 1}] ${esc(dueLabel(t))}</span> · ${esc(t.title)}
      </div>
      ${t.action ? `<div style="font:13px/1.5 'Microsoft YaHei',sans-serif;color:#475467;margin-top:2px;">${esc(t.action)}</div>` : ""}
      <div style="font:12px/1.5 'Microsoft YaHei',sans-serif;color:#98a2b3;margin-top:2px;">${esc(t.source || "")}${t.firstSeen ? " · 首次提醒 " + fmtTime(t.firstSeen) : ""}</div>
    </div>`;
  }).join("")}
  ${todos.hidden ? `<div style="font:12px/1.6 'Microsoft YaHei',sans-serif;color:#98a2b3;">另有 ${todos.hidden} 条未列出（本地 .state/todos.json 里可查）</div>` : ""}
  <div style="border-top:1px solid #eaecf0;margin:18px 0;"></div>
  ` : "";

  const todoMdBlock = todoItems.length ? [
    `## 📌 待办台账（含往日未完成，共 ${todos.total} 条）`,
    "",
    ...todoItems.map((t, i) =>
      `- **[${i + 1}]** **${dueLabel(t)}** · ${t.title}${t.action ? `\n  - ${t.action}` : ""}\n  - ${t.source || ""}${t.firstSeen ? " · 首次提醒 " + fmtTime(t.firstSeen) : ""}`),
    ...(todos.hidden ? [`- _另有 ${todos.hidden} 条未列出_`] : []),
    "",
  ] : [];

  // ---------- 其余邮件：线程归并后的压缩清单 ----------
  const compact = meta.compact || null;
  const compactItems = compact?.items || [];

  const compactHtml = compactItems.length ? `
  <div style="font:700 16px/1.4 'Microsoft YaHei',sans-serif;color:#475467;margin:18px 0 10px 0;">⚪ 其余邮件（共 ${compact.totalMails} 封，已按来源归并为 ${compact.totalItems} 条）</div>
  <div style="font:13px/1.9 'Microsoft YaHei',sans-serif;color:#475467;">
    ${compactItems.map((it) => (it.kind === "group"
      ? `· <b>${it.count} 封</b> ${esc(it.sender)} — ${esc(it.zh || it.subjects?.[0] || "")}`
      : `· ${esc(it.subject || "(无主题)")}${it.zh ? ` <span style="color:#667085;">（${esc(it.zh)}）</span>` : ""} <span style="color:#98a2b3;">— ${esc(it.sender)}</span>`
    )).join("<br>")}
    ${compact.hidden ? `<br><span style="color:#98a2b3;">另有 ${compact.hidden} 条未列出</span>` : ""}
  </div>` : "";

  const compactMd = compactItems.length ? [
    `## ⚪ 其余邮件（共 ${compact.totalMails} 封，已按来源归并为 ${compact.totalItems} 条）`,
    "",
    ...compactItems.map((it) => (it.kind === "group"
      ? `- **${it.count} 封** ${it.sender} — ${it.zh || it.subjects?.[0] || ""}`
      : `- ${it.subject || "(无主题)"}${it.zh ? `（${it.zh}）` : ""} — ${it.sender}`)),
    ...(compact.hidden ? [`- _另有 ${compact.hidden} 条未列出_`] : []),
    "",
  ] : [];

  // 主题：没有新邮件的日子改成「待办提醒」，并把最近的截止日写进主题行——一眼就能看到 DDL
  let subject;
  if (freshCount === 0 && carried.length === 0 && todoItems.length) {
    const nextDated = todoItems.find((t) => t.due);
    const tail = nextDated ? `最近 ${dueLabel(nextDated)}` : `${todoItems.length} 项待办`;
    subject = `📬 待办提醒 · ${dateStr} · 无新邮件 · ${tail}`;
  } else {
    const extra = carried.length ? `（含 ${carried.length} 封待你处理）` : "";
    subject = `📬 邮件日报 ${dateStr} · ${freshCount} 封新邮件${extra} · ${action.length} 项需行动`;
  }

  // 没有新邮件但有待办时，正文里说清楚这封的用途
  const noNewsHtml = (freshCount === 0 && carried.length === 0 && todoItems.length)
    ? `<div style="font:13px/1.6 'Microsoft YaHei',sans-serif;color:#5925dc;background:#f4f3ff;border-radius:6px;padding:8px 10px;margin:0 0 16px 0;">
        今天没有新邮件。这封只为提醒你下面这些<strong>仍未完成</strong>的事项——截止日一直在逼近。
      </div>`
    : "";
  const noNewsMd = (freshCount === 0 && carried.length === 0 && todoItems.length)
    ? ["> 今天没有新邮件。这封只为提醒下面仍未完成的事项（截止日一直在逼近）。", ""]
    : [];

  // ---------- HTML ----------
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f4f7;">
<div style="max-width:720px;margin:0 auto;padding:20px;background:#ffffff;font-family:'Microsoft YaHei',Segoe UI,sans-serif;color:#101828;">

  <div style="border-bottom:2px solid #101828;padding-bottom:10px;margin-bottom:18px;">
    <div style="font:700 20px/1.3 'Microsoft YaHei',sans-serif;">📬 邮件日报 · ${dateStr}</div>
    <div style="font:13px/1.6 'Microsoft YaHei',sans-serif;color:#475467;margin-top:4px;">
      统计窗口 ${since} → ${until}（香港时间）
    </div>
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
    <tr>
      ${[["新邮件", freshCount, "#101828"], ["需你行动", action.length, "#e5484d"], ["值得一看", watch.length, "#f5a524"], ["未读", unread, "#1570ef"], ["含附件", withAttach, "#475467"]]
        .map(([label, val, color]) => `<td style="text-align:center;padding:8px 4px;background:#f9fafb;border-radius:6px;">
          <div style="font:700 20px/1.2 'Microsoft YaHei',sans-serif;color:${color};">${val}</div>
          <div style="font:12px/1.4 'Microsoft YaHei',sans-serif;color:#667085;">${label}</div></td>`).join("")}
    </tr>
  </table>

  ${ignored ? `<div style="font:12px/1.6 'Microsoft YaHei',sans-serif;color:#98a2b3;margin:-12px 0 16px 0;">另有 ${ignored} 封活动邀请 / 招募 / 自动通知，已按你的要求归入末尾清单，不进行动区</div>` : ""}
  ${noNewsHtml}
  ${cmdHtml}
  ${todoHtmlBlock}
  <div style="font:700 16px/1.4 'Microsoft YaHei',sans-serif;color:#b42318;margin:0 0 10px 0;">🔴 需要你行动（${action.length}）</div>
  ${action.length ? action.map((m, i) => htmlItem(m, i + 1)).join("") : `<div style="color:#667085;font:13px 'Microsoft YaHei',sans-serif;margin-bottom:18px;">今天没有明显需要行动的邮件 🎉</div>`}

  ${watch.length ? `<div style="font:700 16px/1.4 'Microsoft YaHei',sans-serif;color:#b54708;margin:18px 0 10px 0;">🟡 值得一看（${watch.length}）</div>
  ${watchTop.map((m) => htmlItem(m, 0)).join("")}
  ${(watchMore.length && !compactItems.length) ? `<div style="font:13px/1.9 'Microsoft YaHei',sans-serif;color:#475467;border-top:1px dashed #eaecf0;padding-top:8px;">
    <span style="color:#98a2b3;">另有 ${watchMore.length} 条同类通知（只列标题）：</span><br>
    ${watchMore.map((m) => `· ${esc((m.subject || "(无主题)").slice(0, 70))} <span style="color:#98a2b3;">— ${esc(m._c.senderName || m._c.sender)}</span>`).join("<br>")}
  </div>` : ""}` : ""}

  ${(info.length && !compactItems.length) ? `<div style="font:700 16px/1.4 'Microsoft YaHei',sans-serif;color:#475467;margin:18px 0 10px 0;">⚪ 其余（${info.length}）</div>
  <div style="font:13px/1.9 'Microsoft YaHei',sans-serif;color:#475467;">
    ${info.map((m) => `· ${esc((m.subject || "(无主题)").slice(0, 70))} <span style="color:#98a2b3;">— ${esc(m._c.senderName || m._c.sender)}</span>`).join("<br>")}
  </div>` : ""}

  ${compactHtml}

  <div style="border-top:1px solid #eaecf0;margin-top:22px;padding-top:12px;font:12px/1.6 'Microsoft YaHei',sans-serif;color:#98a2b3;">
    ${meta.previousRun ? `上次运行：${fmtTime(meta.previousRun)}${gapNote} · ` : ""}由本机 mail-digest 脚本自动生成 · 本地存档：${esc(meta.archiveName || "")}
  </div>
</div></body></html>`;

  // ---------- Markdown ----------
  const markdown = [
    `# 📬 邮件日报 · ${dateStr}`,
    "",
    `> 统计窗口：${since} → ${until}（香港时间）`,
    `> 新邮件 ${freshCount} · 需你行动 ${action.length} · 值得一看 ${watch.length} · 未读 ${unread} · 含附件 ${withAttach}${carried.length ? ` · 另保留 ${carried.length} 封待你处理的重要邮件` : ""}${ignored ? ` · 已过滤邀请/招募 ${ignored}` : ""}`,
    "",
    ...noNewsMd,
    ...cmdMd,
    ...todoMdBlock,
    `## 🔴 需要你行动（${action.length}）`,
    "",
    action.length ? action.map((m, i) => mdItem(m, i + 1)).join("\n") : "_今天没有明显需要行动的邮件_",
    "",
  ];
  if (watch.length) {
    markdown.push(`## 🟡 值得一看（${watch.length}）`, "", watchTop.map((m) => mdItem(m, 0)).join("\n"), "");
    if (watchMore.length && !compactItems.length) {
      markdown.push(`<details><summary>另有 ${watchMore.length} 条同类通知（只列标题）</summary>`, "",
        watchMore.map((m) => `- ${m.subject || "(无主题)"} — ${m._c.senderName || m._c.sender}（${fmtTime(m.receivedDateTime)}）`).join("\n"),
        "", "</details>", "");
    }
  }
  if (info.length && !compactItems.length) {
    markdown.push(`## ⚪ 其余（${info.length}）`, "",
      info.map((m) => `- ${m.subject || "(无主题)"} — ${m._c.senderName || m._c.sender}（${fmtTime(m.receivedDateTime)}）`).join("\n"), "");
  }
  markdown.push(...compactMd);
  markdown.push("---", "",
    `_由本机 mail-digest 脚本自动生成 · 本地存档：${meta.archiveName || ""}${meta.previousRun ? ` · 上次运行 ${fmtTime(meta.previousRun)}${gapNote}` : ""}_`, "");

  return {
    subject, html, markdown: markdown.join("\n"),
    stats: { total: enriched.length, action: action.length, watch: watch.length, info: info.length, unread, withAttach },
    dateStr,
  };
}
