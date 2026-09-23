<a id="中文"></a>

# mail-digest · 每天一封中文邮件日报

[English](#english) | [中文](#中文)

[![test](https://github.com/Eason-LYU/mail-digest/actions/workflows/test.yml/badge.svg)](https://github.com/Eason-LYU/mail-digest/actions/workflows/test.yml)

把**学校/工作邮箱**的收件箱，每天定时整理成一封**中文日报**发到你的**私人邮箱**：谁发的、要不要处理、
要不要翻译、有哪些待办和截止日——一封看完，不用再翻收件箱。它还能反过来听你的话：回复一句
「作业1 做完了」「新增 10/5 交报告」，下次运行就更新待办台账。

**English** — A Windows-only tool that turns your Outlook inbox into **one daily Chinese digest**
delivered to another mailbox: it ranks what actually needs action, translates it, extracts to-dos with
due dates, keeps an "important reminders" list until you acknowledge it by e-mail, and accepts
plain-language e-mail commands (`作业1 搞定了`, `新增 10/5 交报告`) to update its ledger.

> **只能在 Windows 上跑**：读信发信走经典版 Outlook 的 COM 接口；原因见 [兼容性](#兼容性--compatibility)。
> **English** — Windows only: mail I/O goes through classic Outlook COM; see [compatibility](#兼容性--compatibility).

## 60 秒上手 · Quick start

| # | 中文 | English |
|---|---|---|
| 1 | 装 **Node.js ≥ 22**（<https://nodejs.org>）；也可把 `node.exe` 放进 `runtime\`，脚本会优先用它 | Install **Node.js ≥ 22**; or drop `node.exe` into `runtime\` and the launchers will prefer it |
| 2 | 打开**经典版 Outlook**，登录你要整理的那个邮箱（不是网页版，也不是"新版 Outlook"） | Open **classic Outlook** and sign in to the mailbox you want digested |
| 3 | 双击 **`setup.cmd`**，按提示回答几个问题（有中文/英文说明） | Double-click **`setup.cmd`** and answer a few bilingual prompts |
| 4 | 完成。向导会顺手检查通道、空跑一次，并问你要不要注册每天 20:00 的定时任务 | Done. The wizard checks the channel, does a dry run, and offers to register the daily task |

以后再想改任何设置，**重新双击 `setup.cmd`** 就行。
**English** — To change anything later, double-click `setup.cmd` again; re-running it is always safe.

> 📄 **下载了压缩包、还没看 README？先打开包里的 `START-HERE.txt`** —— 那是一份中英双语的
> 60 秒指引（四步、配置说明、常见故障对照表），不用联网也能看。
> **English** — Just downloaded the ZIP? Open **`START-HERE.txt`** first: a bilingual 60-second
> guide (four steps, configuration notes, troubleshooting table) that works offline.

## 它长什么样 · What the digest looks like

```markdown
# 📬 邮件日报 · 2026/09/21

> 统计窗口：09/20 20:00 → 09/21 20:00（香港时间）
> 新邮件 11 · 需你行动 1 · 值得一看 3 · 未读 4 · 含附件 1 · 另保留 1 封待你处理的重要邮件

## 📌 待办台账（含往日未完成，共 4 条）
- **9/24（还有 3 天）** · 交 AAE2004 作业 1
- **9/28（还有 7 天）** · APAS1

## 🔴 需要你行动（2）
- **1.** **Assignment 3 must be submitted by Friday**
  - 译：作业 3 必须在周五前提交
  - 👉 **要做什么：9/26 前把作业 3 上传到 Moodle**
  - 发件人：Prof. Chan · 09/21 10:12 · 未读 · 📎有附件
  - 为何重要：明确的截止日期 + 需要你提交（匹配度 9）
  - 摘要：请通过 Moodle 提交，迟交每天扣 10%。
- **2.** **Library book due reminder**
  - 译：图书馆图书到期提醒
  - 发件人：Library · 09/18 09:00 · 🔁 待你处理（3 天前）
  - 摘要：有 1 本书将于 9/25 到期，请续借或归还。

## 🟡 值得一看（3）
## ⚪ 其余邮件（共 96 封，已按来源归并为 55 条）
```

**English** — Same layout and section names every day. Item 2 is **not** new today: it was ranked action
on 09/18, so it keeps reappearing with the `🔁 待你处理（N 天前）` marker until you reply with the
acknowledgement word. Red list = needs action (translation, why-it-matters, what-to-do); purple list =
the ledger with deadline countdowns; then watch-list and a compacted "everything else" section.

## 它做了什么 · What it does

- **重要性交给模型，决定留在代码**：不是关键词匹配，而是让模型读邮件本身判断"这封要不要我动手"
  （action / watch / info）并给出理由与行动摘要；窗口推进、日期校验、去重、排序、过期全部是确定性代码。
  *English: the LLM reads intent; deterministic code makes every decision (window advance, date
  validation, dedupe, ordering, expiry). Rules only back up and filter (group notices, recruiting,
  invitations are auto-downgraded).*
- **待办是跨天的**：9/15 收到的「9/25 前完成选课确认」，在 9/18 的日报里依然看得到；逾期自动归档，
  无截止日的 15 天后收走。日报因此是"待办清单"，不是"今天的快照"。
  *English: to-dos span days; overdue ones archive themselves, undated ones expire after 15 days.*
- **重要邮件一直保留**：判为 action 的邮件每天继续出现，直到你**回信说「收到/已读/搞定了」**。
  它**不看"已读标记"**——收件箱里几百封没点开的邮件让那个信号毫无意义。
  *English: it deliberately ignores the read/unread flag and trusts only your explicit reply.*
- **两份清单分得很清**：「重要提醒」回一句收到就销；「待办台账」里的任务**只有你说做完了才销**。
  *English: acknowledging an e-mail never touches your to-do ledger — only you close a task.*
- **不会漏邮件**：窗口标准化到前一天 20:00，跑晚了就延伸到最新那封；关机两天才补跑会从上次覆盖处补起。
  宁可多带一段，也绝不漏邮件。*English: the window is standardized to 20:00 and stretches to the
  newest message; a missed day is caught up from the last watermark — over-covering beats skipping.*

## 配置 · Configuration

所有设置都在根目录的 **`config.json`** 里，**每个字段都可选，留空就用默认值**。该文件**已在 `.gitignore` 中**
（仓库里带的是 `config.example.json`，第一次运行由向导生成）。
**English** — Everything lives in a root-level **`config.json`**; every field is optional and empty means
default. It is **git-ignored**; the repo ships `config.example.json` and the wizard creates the real one.

| 字段 Field | 中文 | English |
|---|---|---|
| `mainMailbox` | **主邮箱**：被读取的那个（学校/工作），必须在经典版 Outlook 里已登录。留空 = Outlook 默认打开的那个账号 | **Primary mailbox** being read; must be signed in inside classic Outlook. Empty = whatever account Outlook opens by default |
| `digestTo` | **备用邮箱**：日报发到这里（你的私人邮箱） | **Delivery mailbox** where the daily digest is sent |
| `commandFrom` | **白名单**：允许用邮件发待办指令的地址（逗号分隔）。留空 = 只允许 `digestTo` | **Whitelist** of addresses allowed to send to-do commands. Empty = only `digestTo` |
| `translateProvider` | **翻译渠道**：`auto` \| `deepseek` \| `google` \| `none` | **Translation channel**: `auto` \| `deepseek` \| `google` \| `none` |
| `translateTarget` | 翻译目标语言，例如 `zh-CN`（默认） | Translation target, e.g. `zh-CN` (default) |
| `dailyHour` | 每天几点跑，24 小时制（默认 `20` = 20:00） | Hour of the daily run, 24h clock (default `20`) |

`auto` = 有 DeepSeek 密钥就用 DeepSeek，否则退回 Google 免费接口；`none` = 完全不外发邮件内容。
**English** — `auto` uses DeepSeek when a key exists, otherwise the free Google channel; `none` sends
no mail content anywhere.

配置的优先级是 **环境变量 > `config.json` > `config.example.json` > 代码默认值**，所以临时试验不用改文件：
`MAIL_TO`、`MAIL_MAIN`、`MAIL_COMMAND_FROM`、`MAIL_TRANSLATE`、`MAIL_TRANSLATE_TARGET`、`MAIL_DAILY_HOUR`。

还有两个只管"读不到邮件"这件事的开关：
**`MAIL_STALE_HOURS`**（默认 6）收件箱里最新邮件落后超过这么多小时就强制收一次信；
**`MAIL_SYNC=0`** 禁止程序触发"发送/接收"（等于手动按 F9）——不想让它碰你的发件箱就设这个，
代价是退回"等 60 秒后重读"。
**English** — Precedence is **env vars > `config.json` > `config.example.json` > code defaults**, so a
one-off experiment needs no file edit: `MAIL_TO`, `MAIL_MAIN`, `MAIL_COMMAND_FROM`, `MAIL_TRANSLATE`,
`MAIL_TRANSLATE_TARGET`, `MAIL_DAILY_HOUR`. Two switches cover the "can't read mail" case:
**`MAIL_STALE_HOURS`** (default 6) forces a send/receive when the newest visible mail is older than
that, and **`MAIL_SYNC=0`** forbids the program from triggering send/receive at all (it then waits
60 s and re-reads instead).

## 配置向导 · The setup wizard

双击 **`setup.cmd`**（内部跑 `tools/setup.mjs`），它会用中英双语依次问你：

1. **主邮箱 / main mailbox**（可留空）
2. **备用邮箱 / digest recipient**（必填）
3. **白名单 / whitelist**（默认 = 备用邮箱）
4. **翻译渠道 / translation channel**（可选填 DeepSeek API key）
5. **每天几点 / daily hour**

然后写入 `config.json`，并把 API key 存进 **`.state\secrets.json`** —— **永远不会写进 `config.json`**。
最后它还会问你要不要**检查 Outlook 通道**、**空跑一次**、**注册定时任务**（默认前两项）。
随时可以重跑，重复运行会把现有配置当作默认值，直接回车即可保留。

想在命令行里看当前生效的配置：`node tools\setup.mjs --show`（只显示，不改任何东西）；
`--no-probe` 可跳过探测 Outlook 账户那一步。

**English** — `setup.cmd` (which runs `tools/setup.mjs`) asks the five questions above bilingually,
writes `config.json`, and stores the API key in **`.state\secrets.json`** — never in `config.json`.
It then offers to check the Outlook channel, do a dry run, and register the scheduled task (the first
two are the default). Re-running it any time is safe: your current config becomes the defaults, so
pressing Enter keeps a value. `node tools\setup.mjs --show` prints the active configuration without
changing anything, and `--no-probe` skips the Outlook account probe.

**DeepSeek 密钥是可选的**：不填也能用（走免费的 Google 翻译渠道），只是日报里**不会出现「👉 要做什么」行动摘要**
——那段只有 LLM 能生成。**English** — The DeepSeek key is optional: without it the tool still
translates over the free Google channel, but cannot produce the "what to do" action summary.

## 启动脚本 · Launcher scripts

全部是双击即用的 `.cmd`，不需要命令行。**English** — All launchers are double-click `.cmd` files;
no terminal needed.

| 脚本 / Script | 中文 | English |
|---|---|---|
| `setup.cmd` | 配置向导：写 `config.json`、存密钥、可选自检 | Setup wizard: writes `config.json`, stores the key, optionally self-checks |
| `dry-run.cmd` | 空跑：真读邮件、生成日报存档，**不发信、不改状态** | Dry run: reads mail, archives the digest, sends nothing, changes no state |
| `send-test-digest.cmd` | 真发一封（最近 24 小时），验证整条链路 | Sends one real digest (last 24h) to verify the whole chain |
| `run-now.cmd` | 立刻按计划任务的正式路径跑一次，并显示日志尾部 | Runs the production path now and shows the task log tail |
| `check-outlook.cmd` | 只检查 Outlook 通道（账号、收件箱、最近几封） | Checks the Outlook channel only: account, inbox size, recent mail |
| `manage-todos.cmd` | 待办台账管理器：列出未完成项，输入编号标完成，`a` 手动新增 | To-do ledger manager: list, mark done by number, add with `a` |
| `restore-ledger.cmd` | 从 `.state\backups\` 的自动备份还原台账 | Restores the ledger from an automatic backup |
| `set-deepseek-key.cmd` | 填 DeepSeek 密钥（存 `.state\secrets.json`）并真调一次 API 验证 | Stores the DeepSeek key and verifies it with a real API call |
| `test-ack-clears-reminder.cmd` | 自测：加一条假提醒 → 发日报 → 你回「已读」→ 确认被销掉 | Self-test: fake reminder → digest → reply "read" → confirm it clears |
| `test-failure-alert.cmd` | 自测失败提醒（桌面警告文件 + 弹窗，5 秒自动关） | Self-tests the failure alert: desktop warning file + popup |
| `open-classic-outlook.cmd` | 打开**经典版** Outlook（不是新版网页应用） | Launches **classic** Outlook (not the new web app) |
| `install-task.cmd` | 注册每天的计划任务（默认 20:00）：`install-task.cmd -Time 07:30` / `-Uninstall` | Registers the daily task (default 20:00); `-Time 07:30` / `-Uninstall` |

## 用邮件管理待办 · To-do commands by e-mail

从白名单邮箱发一封邮件给主邮箱即可；**推荐直接回复收到的日报**。
**English** — Send from a whitelisted address to the primary mailbox; replying to the digest works best.

| 你写 / You write | 效果 / Effect |
|---|---|
| `收到` / `已读` / `搞定了`（整封只有这一句） | 把「重要提醒」全部销掉（台账任务不受影响）— clears all reminders; ledger untouched |
| `诈骗那封提醒已读` | 只销那一条提醒 — clears that one reminder |
| `把那个 service 的从黄标改成红标` | 把今天「值得一看」里的某封**升级成重要邮件**，此后每天提醒你直到你说已读 — promotes a "watch" mail to an important reminder |
| `作业1 做完了` | 台账里那条标完成 — marks that ledger item done |
| `新增 10月5日前交 FYP 报告` | 新增一条带截止日的待办 — adds a to-do with a due date |
| `DELTA 改到 9月30日` | 改截止日 — changes a due date |
| `AMA as1 改回 10月23日` | 把改过的日期改回来（日报里会直接给出这句话）— undoes a due-date change |

**「加一个」和「改期」是两件事。** 说 `加一个…` / `新增…` 时永远只新增一条，
**绝不会**去改已有待办的日期；只有明确说 `改期/推迟/改到/换成/提前到` 才会改日期。
改日期时日报会写成 `🔁 改期：AMA as1　10/23 → 11/01`，把旧日期一起显示出来，并在下面给出
「改错了？回信写『↩️ AMA as1 改回 10/23』即可撤销」。
**English** — "Add one" and "reschedule" are different operations: phrases like *add / new*
only ever create a new to-do and never overwrite an existing due date; only explicit
*reschedule / postpone / move to* wording changes a date. Every date change is printed as
`old → new` with a ready-to-copy undo line.

安全上有两道闸：**发件人必须在白名单里** + **主题必须含标记词**（`待办/todo/task/任务/ddl/邮件日报`…），
所以别人给你发信改不了你的台账。纯回执（"收到"这种）由代码直接处理，不调用模型。
**English** — Two gates: the sender must be whitelisted **and** the subject must contain a marker word
(`待办/todo/task/任务/ddl/邮件日报`, reply subjects included). Plain acknowledgements are handled by
code directly, without an LLM call.

## 命令行开关 · Flags

```powershell
node main-outlook.mjs --dry-run --hours 24      # 空跑：只读、只存档、不发信、不改状态
node main-outlook.mjs --check                   # 只检查 Outlook 通道
node main-outlook.mjs --fixture fixtures/sample-messages.json   # 用样例邮件离线试渲染
node main-outlook.mjs --hours 3                 # 手动指定窗口（显式给 --hours 时不做去重）
node main-outlook.mjs --ranking rules           # 不用 LLM，纯本地规则分档
node main-outlook.mjs --no-translate            # 完全不外发邮件内容（也不翻译）
node main-outlook.mjs --pending-days 60         # 重要提醒最多保留多少天（默认 30）
node main-outlook.mjs --undated-days 30         # 没有截止日的待办保留多少天（默认 15）
node main-outlook.mjs --no-dedupe               # 强制重报（忽略"已报告过"名单）
```

| 开关 / Flag | 中文 | English |
|---|---|---|
| `--to <addr>` | 本次改收件人 | Override the recipient for this run |
| `--max <n>` | 最多读多少封（默认 300） | Max messages read (default 300) |
| `--send-empty` | 即使没有新邮件也发 | Send even with no new mail |
| `--no-action-summary` | 不生成「要做什么」 | Skip the action summary |
| `--no-carry-over` | 不把往日重要邮件带出来 | Don't carry past action mail forward |
| `--no-command-mails` | 本次不处理指令邮件 | Ignore command e-mails this run |

退出码：`0` 成功 · `2` Outlook 未配置好 · `3` 其他失败。**English** — Exit codes: 0 OK, 2 Outlook
unusable, 3 other failure.

## 数据流 · Data flow

```
   主邮箱 (经典版 Outlook)                    备用邮箱 (你的私人邮箱)
   primary mailbox (classic Outlook)         delivery mailbox
        │                                          ▲
        │ ① 读取统计窗口内的邮件                    │ ⑤ 一封中文日报
        ▼                                          │   one Chinese digest
   ┌──────────────────────────────────────────────────────┐
   │ ② 分档  action / watch / info   (lib/rank.mjs)         │
   │ ③ 翻译成中文 + 生成「👉 要做什么」 (lib/enrich.mjs)     │
   │ ④ 累积待办台账 + 保留重要提醒   (lib/todos.mjs)         │
   └──────────────────────────────────────────────────────┘
        ▲
        │ 你回信：「收到」「作业1 搞定了」「新增 10/5 交报告」
        │ your replies become ledger updates (whitelist + subject marker)
```

## 兼容性 · Compatibility

### 操作系统 / Operating system

**目前只能跑在 Windows 上**，而且需要**桌面版 Outlook**。两个硬依赖：
① 读信/发信走 Outlook COM（`outlook-bridge.ps1`），这是 Windows + Office 独有的接口；
② 定时任务用 schtasks + wscript 隐藏窗口。
**English** — Windows-only, and it needs desktop Outlook: (1) mail I/O uses Outlook COM, a Windows +
Office-only interface; (2) scheduling uses `schtasks` with a `wscript` hidden window.

跑不了 macOS 的原因不是"懒得适配"，而是**没有等价物**：macOS 版 Outlook 不提供能读全量收件箱 +
代表你发信的自动化接口。好消息是**分层是干净的**：除了 `outlook-bridge.ps1` 和几个 `.cmd`，
其余（分档、翻译、台账、窗口、日报渲染、指令解析、测试）都是纯 Node.js、**与平台无关**——
**要移植到 macOS，只需要替换"读邮件/发邮件"这一个桥接层，其它代码原样复用**。
**English** — macOS would mean replacing only that one bridge layer; everything else is portable
Node.js and stays as is.

### 别的邮箱服务 / Other mail providers

**间接可以用**：只要那家邮箱能通过**经典版 Outlook**收（Gmail、QQ/163、Exchange、IMAP 都行），
这个工具就能整理它——它读的是 Outlook 里的账户，不关心后端是谁。
**不能直接用**的：纯网页版邮箱、没有 IMAP 的小众服务，那种情况需要换适配层。
**English** — Works **indirectly** with any provider reachable through classic Outlook (Gmail, QQ/163,
Exchange, IMAP). Web-only mailboxes would need a different bridge.

### "只给一个邮箱地址就能通解"存在吗 / Why "just give an address and it works" doesn't exist

不太存在，原因是**读信必须你本人授权**，而各家授权方式完全不同：
**English** — No: reading mail always needs per-provider authorization, and each provider does it
differently.

| 路线 / Route | 现实情况 / Reality |
|---|---|
| Microsoft Graph（官方 API） | 最正统，但**必须管理员同意**；学校/公司租户基本禁了用户自助授权 — official, but needs **admin consent**, blocked on most school/work tenants |
| IMAP / SMTP | **最通用**：邮箱地址 + 应用专用密码；代价是各家开关位置不同、企业邮箱常禁用 — most general, but needs an app password and is often disabled |
| Outlook 桌面 COM（本项目 / this project） | 不用密码、不用授权，直接借你已登录的 Outlook；代价是**必须 Windows + 桌面版 Outlook** — no password, no consent, but Windows + desktop Outlook only |
| 各家专有 API / Vendor APIs | Gmail API、Resend 之类，一个服务一套代码 — one integration per service |

本项目选 COM 是因为**在学校租户下 Graph 被管理员挡住了，而 COM 不需要任何人批准**。
**English** — COM was chosen because Graph is blocked by admin policy on locked-down university
tenants, while COM needs nobody's approval.

## 已知限制 · Known limitations

- 电脑必须开机且**已登录**（计划任务用交互式令牌，注销状态不跑）；关机就等下次开机补跑。
  *English: the PC must be on and signed in; a missed run is caught up later.*
- 首次运行时 Outlook 本地缓存可能还没同步完，会读到 0 封——**不会丢邮件**，下次仍会覆盖那段区间。
  *English: a cold OST cache can yield 0 messages; nothing is lost, the window covers it next time.*
- Outlook 发信时若弹出"某程序正代表你发送邮件"，要点允许，否则会卡住。
  *English: click Allow on the Outlook "a program is sending mail" prompt, or the run hangs.*
- 只读**收件箱**（不含子文件夹）；附件只提示"有附件"，不下载。
  *English: inbox only, no subfolders; attachments are flagged but never downloaded.*
- 没有 DeepSeek 密钥时仍能翻译（Google 渠道），但**没有「👉 要做什么」行动摘要**。
  *English: without a DeepSeek key you still get translations, but no action summary.*
- 状态文件都在 `.state\`，里面有你的邮件内容，**已在 `.gitignore` 里，不要提交**。
  *English: `.state\` holds your mail content and is git-ignored — never commit it.*

## 主要文件 · Layout

| 文件 / File | 作用 / Purpose |
|---|---|
| `main-outlook.mjs` | 主流程：读邮件 → 分档 → 翻译 → 待办 → 渲染 → 发送 |
| `outlook-bridge.ps1` | PowerShell 桥接：`-Check` 查通道 / `-Dump` 导出邮件 JSON / `-Send` 发信 |
| `setup.cmd` · `tools\setup.mjs` | 首次配置向导（写 `config.json` + `.state\secrets.json`）；`--show` 只看当前配置 |
| `config.example.json` | 模板配置（含中英双语字段说明），`config.json` 缺失时作为兜底 |
| `lib\config.mjs` | 配置读取：环境变量 > `config.json` > `config.example.json` > 默认值 |
| `lib\classify.mjs` · `lib\rank.mjs` | 本地兜底规则 / 把"哪封重要"交给 LLM |
| `lib\window.mjs` | 统计窗口：标准化到 20:00 + 不漏邮件 |
| `lib\todos.mjs` · `lib\pending.mjs` | 待办台账（归并去重、日期校验、过期归档）/「重要提醒」清单 |
| `lib\commands.mjs` | 待办指令邮件解析（白名单 / 去引用 / 回执识别） |
| `lib\statefile.mjs` · `lib\reported.mjs` | 写前备份 + 原子写 / 已报告名单（窗口重叠不重复刷屏） |
| `lib\translate.mjs` · `lib\digest.mjs` | 翻译 + 行动摘要（带缓存与降级）/ 日报渲染（HTML + Markdown） |
| `install-task.ps1` | 注册 / 卸载计划任务 |
| `test\run.mjs` | 跑全部回归测试（145 项，全离线） |

## 设计取舍 · Design trade-offs

详细的工程笔记（为什么这么写、踩过哪些坑、怎么验证的）见 [`docs/design-notes.md`](docs/design-notes.md)。
**English** — Engineering notes live in [`docs/design-notes.md`](docs/design-notes.md) (Chinese).

- **LLM 只做"判断"，代码做"决定"**：窗口推进、日期校验、去重、排序、过期全是确定性代码并带测试；
  模型返回的东西一律二次校验，宁可不动也不乱改。*English: the model interprets, code decides.*
- **防漏优先于防重复**：读本地缓存可能读到 0 封，所以"覆盖点"只随真正读到的最新邮件前进。
  *English: never-skip beats never-repeat.*
- **状态文件写前必留备份**：误删/误写都能用 `restore-ledger.cmd` 一键还原（这是真事故换来的）。
  *English: backups before every write, for real reasons.*
- **`.cmd` 必须纯 ASCII、`.ps1` 必须带 UTF-8 BOM**：有测试守卫，因为两者都真实炸过。
  *English: encoding rules are test-guarded.*

## 测试 · Tests

```powershell
node test\run.mjs      # 145 项，全离线，不读 Outlook、不发信
```

**English** — 145 checks, fully offline: no Outlook access, no mail sent.

## 许可 · License

MIT，见 [LICENSE](LICENSE)。 **English** — MIT, see [LICENSE](LICENSE).

---

## English

A Windows-only tool that turns your Outlook inbox into **one daily Chinese digest** delivered to another
mailbox: it ranks what actually needs action, translates, extracts to-dos with due dates, keeps an
"important reminders" list until you acknowledge it by replying `收到`/`已读`, and accepts plain-language
e-mail commands (`作业1 搞定了`, `新增 10/5 交报告`) to update the ledger. Every section above has its
English text directly under the Chinese one — this block is just the condensed version.

It reads and sends mail through **classic Outlook for Windows via COM** — the only route that needs no
admin consent on locked-down university tenants (Microsoft Graph is blocked there, and the Office client
cannot request Graph tokens). Everything except that one bridge layer is plain cross-platform Node.js,
and the whole suite (145 tests) runs offline.

**Quick start:** install Node.js ≥ 22 → sign in to the mailbox inside classic Outlook → double-click
`setup.cmd` and answer the wizard (main mailbox, digest recipient, whitelist, translation channel +
optional DeepSeek key, daily hour) → done. The wizard writes `config.json` (git-ignored; every field
optional) and keeps the API key in `.state\secrets.json`; without a key you still get free Google
translation, but not the "what to do" action summary. Re-run `setup.cmd` any time.

**Everyday use:** `dry-run.cmd` (read + archive, never sends), `send-test-digest.cmd` (one real digest),
`run-now.cmd` (the production path now), `check-outlook.cmd` (diagnose the channel), `manage-todos.cmd`
(edit the ledger by hand), `restore-ledger.cmd` (restore from backup), `install-task.cmd` (daily task at
`dailyHour`, default 20:00; `-Time 07:30`, `-Uninstall`). Full table above. MIT licensed.
