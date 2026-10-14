# Outlook COM 桥接：为 Node 日报脚本提供"读收件箱 / 发邮件"能力
#
# 为什么要这个：PolyU 租户禁止用户自行同意第三方应用，Microsoft Graph 那条路走不通。
# 经典版 Outlook 自己持有登录态（与 Windows 里的学校工作账号打通），
# 通过 COM 驱动它读写邮件，完全绕开"应用授权"机制，不需要管理员同意。
#
# 模式（三选一）：
#   -Check                                              只报告 Outlook 配置/账号/收件箱状态
#   -Dump <json路径> [-Hours N] [-Max N] [-ExtraFolders "重要,垃圾邮件"]
#                                                       把最近 N 小时的邮件写成 JSON
#                                                       （收件箱，外加 -ExtraFolders 里同名的子文件夹）
#   -Send -To <地址> -Subject <主题> -HtmlFile <html>   用 Outlook 发一封 HTML 邮件
#
# 可选参数（都不传 = 与以前完全一致，用 Outlook 自己的默认值）：
#   -Account <smtp地址>  读哪个邮箱的收件箱（按 $ns.Accounts 的 SmtpAddress 匹配，大小写不敏感）
#   -From    <smtp地址>  -Send 时用哪个账户发（找不到只警告，仍然照常发送）
#   -ExtraFolders <名字,逗号分隔>   -Dump 时**除收件箱外一起导出**的文件夹（默认「重要,垃圾邮件」）。
#       为什么需要：学校（Exchange）的规则会把**外部来信**分到「重要」这类文件夹里，
#       而用户从手机回的指令邮件正是外部来信 —— 只读收件箱就永远看不到它（真实事故：扫到 0 封）。
#       这些文件夹里窗口内的邮件只是**追加**进同一个 dump，每封多一个 folder 字段；
#       哪封进日报正文由 Node 侧按 folder 判断（垃圾邮件不会混进日报）。
#       找不到的文件夹静默跳过（只写一行 stdout），绝不能让整次导出失败。
#
# 退出码: 0 成功 | 2 Outlook 尚未配置好 | 3 其他错误（含 -Account 指定的账户不存在）
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Sync,
  [string]$Dump,
  [double]$Hours = 24,
  [int]$Max = 300,
  [string]$ExtraFolders = '重要,垃圾邮件',
  [switch]$Send,
  [string]$To,
  [string]$Subject,
  [string]$HtmlFile,
  [string]$Account,
  [string]$From
)

$ErrorActionPreference = 'Stop'

# 让本脚本写到 stdout 的字节也是 UTF-8。
# 否则中文会按控制台代码页（GBK）写出，混进 Node 写的 UTF-8 日志里变成乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Fail([int]$code, [string]$msg) {
  Write-Output "ERROR|$msg"
  exit $code
}

# ---------- 连接 Outlook（带冷启动重试）----------
# Outlook 首次启动（尤其首次建本地副本时）可能要 1-2 分钟，
# 而 COM 激活本身有约 2 分钟超时，会报 0x80080005 CO_E_SERVER_EXEC_FAILURE。
# 所以：先直接试，失败就确保 OUTLOOK.EXE 进程在跑，等一会儿再附着。
$OutlookExe = 'C:\Program Files\Microsoft Office\Root\Office16\OUTLOOK.EXE'

# 注意：这个函数里绝对不能用 Write-Output 打诊断信息！
# 那些输出会混进返回值，调用方会拿到 [字符串, COM对象] 数组而不是 COM 对象，
# 曾经因此报 "[System.String] does not contain a method named 'GetNamespace'"。
# 诊断信息统一收集到 $script:ConnectLog，连接结束后再打印。
$script:ConnectLog = New-Object System.Collections.Generic.List[string]

function Connect-Outlook {
  param([int]$Attempts = 3, [int]$WaitSeconds = 30)
  $lastErr = $null
  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      $app = New-Object -ComObject Outlook.Application
      $script:ConnectLog.Add("COM|第 $i 次尝试连接成功")
      return $app
    } catch {
      $lastErr = $_.Exception.Message
      $script:ConnectLog.Add("COM|第 $i 次尝试失败：$lastErr")
    }
    if ($i -lt $Attempts) {
      $running = Get-Process OUTLOOK -ErrorAction SilentlyContinue
      if (-not $running) {
        if (Test-Path $OutlookExe) {
          $script:ConnectLog.Add("COM|Outlook 未在运行，先作为进程启动，等 $WaitSeconds 秒后重试…")
          try { Start-Process -FilePath $OutlookExe -WindowStyle Minimized } catch {
            $script:ConnectLog.Add("COM|启动 OUTLOOK.EXE 失败：$($_.Exception.Message)")
          }
        } else {
          $script:ConnectLog.Add("COM|找不到 $OutlookExe")
        }
      } else {
        $script:ConnectLog.Add("COM|Outlook 已在运行（PID=$($running[0].Id)），等 $WaitSeconds 秒后重试…")
      }
      Start-Sleep -Seconds $WaitSeconds
    }
  }
  throw "无法连接 Outlook（已尝试 $Attempts 次）：$lastErr"
}

try {
  $ol = Connect-Outlook
} catch {
  Fail 2 $_.Exception.Message
}
foreach ($m in $script:ConnectLog) { Write-Output $m }
$script:ConnectLog.Clear()

try {
  $ns = $ol.GetNamespace('MAPI')
} catch {
  Fail 2 "无法获取 MAPI 命名空间：$($_.Exception.Message)"
}

# ---------- 账号解析：明确"读哪个邮箱 / 用哪个账号发" ----------
# 背景：$ns.GetDefaultFolder(6) 读的永远是 Outlook 的"默认存储"，多账号时未必是你要的那个；
# 发信也是 Outlook 自己挑默认发件账户。所以加两个可选参数把它变显式；
# 两个都不传时，下面的 $ReadAcct / $SendAcct 都为空，行为与改动前完全一致。
#
# 注意：Find-Account 返回的是 COM 对象，**绝对不能在里面 Write-Output**（见上面 Connect-Outlook 的教训），
# 否则调用方拿到的是 [字符串, COM对象] 数组；诊断信息统一收集到 $script:AccountLog，由主流程打印。
$script:AccountLog = New-Object System.Collections.Generic.List[string]
$script:ReadAcct = $null
$script:SendAcct = $null

# 按 SMTP 地址找账户（大小写不敏感）：命中就写进 $script:FoundAcct，找不到写 $null。
# 故意不"返回"这个 COM 对象——COM 对象过一遍管道有可能被 PowerShell 枚举/解包，
# 直接赋值到 script 作用域最稳（这个文件已经因为返回值被污染踩过一次坑）。
$script:FoundAcct = $null
function Find-Account([string]$smtp) {
  $script:FoundAcct = $null
  if ([string]::IsNullOrWhiteSpace($smtp)) { return }
  $want = $smtp.Trim().ToLowerInvariant()
  foreach ($a in @($ns.Accounts)) {
    $addr = ''
    try { $addr = [string]$a.SmtpAddress } catch { }
    if ($addr -and $addr.Trim().ToLowerInvariant() -eq $want) { $script:FoundAcct = $a; return }
  }
}

# 列出当前 Outlook 里真实存在的账户（报错时告诉用户"到底有哪些能用"）
function Get-AccountNameList {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($a in @($ns.Accounts)) {
    $dn = ''; $addr = ''
    try { $dn = [string]$a.DisplayName } catch { }
    try { $addr = [string]$a.SmtpAddress } catch { }
    if ($addr) {
      if ($dn) { $out.Add("$dn <$addr>") } else { $out.Add($addr) }
    } elseif ($dn) {
      $out.Add($dn)
    }
  }
  return $out
}

# 打开"读信要用的收件箱"：
#   -Account 指定 → 那个账户自己的 DeliveryStore 里的收件箱（关键：不能用 $ns.GetDefaultFolder）
#   未指定       → 与改动前完全一致：Outlook 默认存储的收件箱
function Open-InboxFolder {
  if ($null -ne $script:ReadAcct) {
    return $script:ReadAcct.DeliveryStore.GetDefaultFolder(6)
  }
  return $ns.GetDefaultFolder(6)
}

# 在**正在读的那个存储**里按名字找一个子文件夹（-Dump 的 -ExtraFolders 用）。
# 为什么不用 $ns.GetDefaultFolder：那个 API 永远指向 Outlook 的"默认存储"，
# -Account 指定了别的邮箱时会跑去另一个邮箱里找（Open-InboxFolder 上面已解释过这个坑）。
# 这里改成从**已经打开的那个收件箱**出发：先看它的父级（Exchange 下就是"信息存储顶层"，
# 收件箱 / 垃圾邮件 / 规则自动分拣建的文件夹都在这一层），再看存储根目录（有些账户多一层）。
# 都没有就把 $script:FoundFolder 留成 $null，由调用方静默跳过。
# 注意：和 Find-Account 一样，命中的 COM 对象只写进 $script:FoundFolder，**不从函数里 return**
#（COM 对象过一遍管道有可能被 PowerShell 枚举/解包，这个文件已经因为返回值被污染踩过一次坑）。
$script:FoundFolder = $null
function Find-StoreSubFolder($inboxFolder, [string]$name) {
  $script:FoundFolder = $null
  if (-not $name) { return }

  $roots = New-Object System.Collections.Generic.List[object]
  try { if ($inboxFolder.Parent) { $roots.Add($inboxFolder.Parent) } } catch { }
  try { $r = $inboxFolder.Store.GetRootFolder(); if ($r) { $roots.Add($r) } } catch { }

  foreach ($root in $roots) {
    try {
      foreach ($f in @($root.Folders)) {
        $fn = ''
        try { $fn = [string]$f.Name } catch { }
        # 字符串 -eq 是大小写不敏感的，和 Outlook 自己找文件夹的行为一致
        if ($fn -and $fn.Trim() -eq $name.Trim()) { $script:FoundFolder = $f; return }
      }
    } catch { }
  }
}

# -Account：地址写错要立刻报错退出（退出码 3），并列出真实存在的账户
$ReadLabel = '(default)'
if ($Account) {
  Find-Account $Account
  $script:ReadAcct = $script:FoundAcct
  if ($null -eq $script:ReadAcct) {
    $names = @(Get-AccountNameList)
    if ($names.Count -gt 0) { $namesTxt = $names -join ' | ' } else { $namesTxt = '(无 / none)' }
    Fail 3 "找不到账户 $Account / account not found: $Account ；现有账户 / available accounts: $namesTxt"
  }
  $ReadLabel = [string]$script:ReadAcct.SmtpAddress
  if (-not $ReadLabel) { $ReadLabel = $Account }
  $script:AccountLog.Add("MAILBOX|读信邮箱 / reading mailbox: $ReadLabel")
}

# -From：找不到**不**报错，只警告并回退到 Outlook 默认发件账户（发信不能因为一个笔误就发不出去）
$SendLabel = '(default)'
if ($From) {
  Find-Account $From
  $script:SendAcct = $script:FoundAcct
  if ($null -ne $script:SendAcct) {
    $SendLabel = [string]$script:SendAcct.SmtpAddress
    if (-not $SendLabel) { $SendLabel = $From }
  } else {
    $script:AccountLog.Add("WARN|找不到账户 $From / account not found: $From ；改用 Outlook 默认发件账户 / falling back to the default sending account")
  }
}
foreach ($m in $script:AccountLog) { Write-Output $m }
$script:AccountLog.Clear()

# ---------- -Check：报告状态 ----------
if ($Check) {
  Write-Output "OK|Outlook COM 已连接"
  try {
    $accounts = @($ns.Accounts)
    Write-Output "ACCOUNTS|$($accounts.Count)"
    foreach ($a in $accounts) {
      Write-Output "ACCOUNT|$($a.DisplayName)|$($a.SmtpAddress)|$($a.AccountType)"
    }
  } catch {
    Write-Output "ACCOUNTS|读取失败：$($_.Exception.Message)"
  }

  # 明确报告"这次到底读哪个邮箱、用哪个账号发"——多账号时最容易搞错的就是这个
  Write-Output "TARGET|read=$ReadLabel|send=$SendLabel"

  try {
    $inbox = Open-InboxFolder
    $totalItems = $inbox.Items.Count
    Write-Output "INBOX|$($inbox.Name)|total=$totalItems|unread=$($inbox.UnReadItemCount)"

    # 集合的"原生顺序"——先看一眼第 1 条到底是新的还是旧的，
    # 用来判断 Items.Sort 是否真的生效（曾经因为排序没生效导致"扫 1 条就断定没有新邮件"）。
    $probe = $inbox.Items
    for ($i = 1; $i -le [Math]::Min(3, $totalItems); $i++) {
      $it = $probe.Item($i)
      Write-Output "FIRST|$($it.ReceivedTime.ToString('yyyy-MM-dd HH:mm'))|$($it.SenderName)|$($it.Subject)"
    }

    # 不依赖排序：扫前 300 条，找出真正最新的一封
    $maxScan = [Math]::Min(300, $totalItems)
    $newest = $null; $newestSender = ''; $newestSubject = ''
    for ($i = 1; $i -le $maxScan; $i++) {
      $it = $probe.Item($i)
      $rt = $it.ReceivedTime
      if (-not $newest -or $rt -gt $newest) { $newest = $rt; $newestSender = $it.SenderName; $newestSubject = $it.Subject }
    }
    Write-Output "SCANNED|$maxScan|total=$totalItems"
    if ($newest) {
      Write-Output "NEWEST|$($newest.ToString('yyyy-MM-dd HH:mm'))|$newestSender|$newestSubject"
    } else {
      Write-Output "NEWEST|(收件箱为空)"
    }
  } catch {
    Fail 2 "无法读取收件箱（可能还没配置邮件账号）：$($_.Exception.Message)"
  }
  exit 0
}

# ---------- 取发件人 SMTP 地址（Exchange 内部发件人常是 X500 DN）----------
function Get-SenderAddress($item) {
  $addr = $null
  try { $addr = $item.SenderEmailAddress } catch { }
  if ([string]::IsNullOrWhiteSpace($addr)) { return '' }
  if ($addr -like '/O=*' -or $addr -like '/o=*') {
    try {
      $ex = $item.Sender.GetExchangeUser()
      if ($ex -and $ex.PrimarySmtpAddress) { return $ex.PrimarySmtpAddress }
    } catch { }
  }
  return $addr
}

# ---------- 扫一个文件夹（-Dump 用）----------
# 把某个文件夹里**窗口内**的邮件追加进 $List，每封带上 folder 字段（标明来自哪个文件夹）。
# 注意：函数体内**绝不能 Write-Output**——输出会混进返回值，调用方就拿不到统计对象了
#（Connect-Outlook 那次 "[System.String] does not contain a method named 'GetNamespace'" 就是这么来的）。
# 所以统计只通过返回的 hashtable 交给调用方，要打印的行由调用方自己写。
function Add-WindowMail {
  param($Folder, [string]$Label, $List, $Cutoff, [int]$Max)

  $items = $Folder.Items
  # 尽力按时间倒序（但下面的循环不依赖它是否生效）
  try { $items.Sort('[ReceivedTime]', $true) } catch { }

  $total = $items.Count
  $scanned = 0
  $added = 0
  $newest = $null
  $miss = 0
  $maxScan = 800        # 排序不可靠时的兜底：最多扫这么多条
  $missLimit = 80       # 连续这么多条都早于窗口，才认为后面更早、可以停

  for ($i = 1; $i -le $total; $i++) {
    # 注意 -Max 是**每个文件夹各自**的上限（原来是"整个 dump"的全局计数）：
    # 收件箱把名额占满时，附加文件夹（指令邮件恰恰在那里）不能因此一封都读不到——
    # 那正是这次要修的问题。
    if ($added -ge $Max) { break }
    if ($scanned -ge $maxScan) { break }
    $it = $items.Item($i)
    $scanned++
    $rt = $it.ReceivedTime
    if (-not $newest -or $rt -gt $newest) { $newest = $rt }

    if ($rt -lt $Cutoff) {
      # 不要"遇到第一条旧的就直接 break"——万一排序没生效，那样会漏掉整箱新邮件。
      # 改成容忍连续 missLimit 条，仍然在正常排序下能很快停下。
      $miss++
      if ($miss -ge $missLimit) { break }
      continue
    }
    $miss = 0

    $preview = ''
    try {
      $body = [string]$it.Body
      if ($body.Length -gt 1200) { $body = $body.Substring(0, 1200) }   # 多留一点正文，便于提取截止日期
      $preview = ($body -replace '\s+', ' ').Trim()
    } catch { }

    $tos = @()
    try {
      foreach ($r in $it.Recipients) {
        $tos += [pscustomobject]@{ emailAddress = [pscustomobject]@{ address = [string]$r.Name } }
      }
    } catch { }

    $imp = 'normal'
    switch ([int]$it.Importance) { 0 { $imp = 'low' } 2 { $imp = 'high' } }

    $flag = 'notFlagged'
    if ([int]$it.FlagStatus -eq 2) { $flag = 'flagged' }

    $List.Add([pscustomobject]@{
      id               = [string]$it.EntryID
      conversationId   = [string]$it.ConversationID
      subject          = [string]$it.Subject
      # 这封是从哪个文件夹读出来的（收件箱写「收件箱」，附加文件夹写它自己的名字）。
      # Node 侧靠它分开使用：日报正文只认收件箱，指令邮件的识别看全部。
      folder           = $Label
      from             = [pscustomobject]@{
        emailAddress = [pscustomobject]@{
          name    = [string]$it.SenderName
          address = (Get-SenderAddress $it)
        }
      }
      toRecipients     = $tos
      receivedDateTime = $rt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      isRead           = -not [bool]$it.UnRead
      importance       = $imp
      hasAttachments   = [bool]($it.Attachments.Count -gt 0)
      bodyPreview      = $preview
      webLink          = ''
      categories       = @()
      flag             = [pscustomobject]@{ flagStatus = $flag }
    })
    $added++
  }

  return @{ total = $total; scanned = $scanned; added = $added; newest = $newest }
}

# ---------- -Dump：导出邮件为 JSON ----------
if ($Dump) {
  $cutoff = (Get-Date).AddHours(-$Hours)
  $outPath = [System.IO.Path]::GetFullPath($Dump)

  try {
    $inbox = Open-InboxFolder
  } catch {
    Fail 2 "无法打开收件箱：$($_.Exception.Message)"
  }

  $list = New-Object System.Collections.Generic.List[object]

  # 收件箱：folder 固定写「收件箱」——Node 侧靠这个字段决定"哪些进日报正文"（只有收件箱进）。
  try {
    $inboxStat = Add-WindowMail -Folder $inbox -Label '收件箱' -List $list -Cutoff $cutoff -Max $Max
  } catch {
    Fail 2 "读取收件箱失败：$($_.Exception.Message)"
  }
  $total = [int]$inboxStat.total
  $scanned = [int]$inboxStat.scanned
  $newestSeen = $inboxStat.newest

  # ---------- 「本地缓存有洞」的正面证据（2026-10-09 事故后加的） ----------
  # 事故：20:00 那次运行时，收件箱里 10/09 09:06–14:40 的 14 封邮件凭空不在（Outlook 正在重同步：
  # 新的先下来、中间那段还没补回来），但 newestSeen 依然是 19:11（很新鲜）——于是所有"缓存同步完了吗"
  # 的判断全部通过，日报少了 7 封新邮件，用户 13:35 那封指令邮件也没被执行（拖到第二天）。
  # 判据（正面证据，不靠猜）：**服务器说这个文件夹有多少条**（PR_CONTENT_COUNT）比本地缓存多多少。
  # ⚠️ 只在收件箱上比（日报/窗口推进都只认收件箱）；属性拿不到时一律当 0 ——
  # 宁可不报警，也绝不凭猜测喊狼来了。
  $contentCount = $null
  try {
    $cc = $inbox.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x36020003')
    if ($null -ne $cc) { $contentCount = [int]$cc }
  } catch { }
  $contentGap = 0
  if ($null -ne $contentCount -and $contentCount -gt $total) { $contentGap = $contentCount - $total }

  # ---------- 附加文件夹：指令邮件可能被规则分到「重要 / 垃圾邮件」里 ----------
  # 真实事故：用户从手机回信下指令，PolyU(Exchange) 的规则把这类**外部来信**分进「重要」，
  # 只读收件箱的程序于是"扫到 0 封"，指令邮件永远执行不了。
  # 这里把 -ExtraFolders 里名字命中的子文件夹中、**窗口内**（沿用同一个 -Hours 过滤逻辑）的邮件
  # **追加**进同一个 dump，每封带上 folder 字段；日报正文该列谁由 Node 侧按 folder 判断
  #（所以「垃圾邮件」里的东西不会混进日报正文）。
  $extraNames = @()
  if ($ExtraFolders) {
    $extraNames = @($ExtraFolders -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
  $extraSeen = New-Object System.Collections.Generic.List[string]   # 处理过的名字（同名写两遍不必扫两遍）
  $extraAdded = 0
  foreach ($name in $extraNames) {
    if ($extraSeen -contains $name) { continue }
    $extraSeen.Add($name)
    # 找不到就**静默跳过**（只写一行说明）：有的人根本没有「重要」文件夹，这不是错误，
    # 绝不能因此让整次导出失败 —— 那会连收件箱的日报一起弄没了。
    try { Find-StoreSubFolder $inbox $name } catch { }
    if ($null -eq $script:FoundFolder) {
      Write-Output "SKIPFOLDER|$name|当前存储里没有这个文件夹，已跳过 / folder not found, skipped"
      continue
    }
    $st = $null
    try { $st = Add-WindowMail -Folder $script:FoundFolder -Label $name -List $list -Cutoff $cutoff -Max $Max }
    catch {
      # 附加文件夹读失败同样不能拖垮整次导出（收件箱那部分已经拿到手了）
      Write-Output "EXTRAFOLDER|$name|读取失败已跳过：$($_.Exception.Message)"
      continue
    }
    $extraAdded += [int]$st.added
    Write-Output "EXTRAFOLDER|$name|added=$($st.added)|scanned=$($st.scanned)|total=$($st.total)"
  }

  # 必须**强制**序列化成 JSON 数组。原来的 `$list | ConvertTo-Json -Depth 6` 在列表
  # **只有 1 项**时会写出一个裸对象而不是 [ {...} ]，Node 侧按"非数组 → 取 .value → 空"读，
  # 于是"窗口里恰好只有 1 封新邮件"被报成"无新邮件"，那封邮件被静默丢掉
  # （2026-09-29 真实事故：早上那次窗口里只有用户的一封指令回信，桥接层 count=1 导出了它，
  #  Node 却读到 0 封，指令拖到当晚 20:00 才执行。历史日志里 count=1 出现过 8 次）。
  # 用 -InputObject + 列表才会稳定写出 [ ... ]；注意 @($list) 在 PowerShell 5.1 下会抛
  # ArgumentException（"Argument types do not match"），所以不要那样写。
  if ($list.Count -eq 0) { $json = '[]' }
  else { $json = ConvertTo-Json -InputObject $list -Depth 6 }
  # 必须写成 UTF-8 无 BOM，否则 Node 的 JSON.parse 会因为 BOM 报错
  [System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  if ($newestSeen) { $newestTxt = $newestSeen.ToString('yyyy-MM-dd HH:mm') } else { $newestTxt = '(空)' }
  Write-Output "DUMPED|$outPath|count=$($list.Count)|scanned=$scanned|total=$total|cache=$total|server=$contentCount|gap=$contentGap|cutoff=$($cutoff.ToString('yyyy-MM-dd HH:mm'))|newestSeen=$newestTxt|extra=$extraAdded"

  # 侧写一份元数据给 Node 用（避免去解析日志行）。
  # newestSeenMailAt 是"本次真正读到的最新邮件时间"，Node 靠它决定窗口怎么推进——
  # 若这次一封都没读到，Node 就不会推进窗口，从而避免"缓存没同步完 → 邮件被永久跳过"。
  # ⚠️ 这里的 scanned / total / newestSeen 一律**只统计收件箱**（附加文件夹只贡献 count）：
  # 它们是"收件箱本地缓存同步到哪了"的依据，垃圾邮件常常比收件箱更新，
  # 混进来会让"缓存没同步完"的判断失真、把没收全的日报当成收全了。
  $metaPath = Join-Path (Split-Path -Parent $outPath) 'inbox-meta.json'
  $newestIso = $null
  if ($newestSeen) { $newestIso = $newestSeen.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
  $meta = [pscustomobject]@{
    count        = $list.Count
    scanned      = $scanned
    total        = $total
    contentCount = $contentCount
    contentGap   = $contentGap
    extraFolders = @($extraSeen)
    extraCount   = $extraAdded
    cutoff       = $cutoff.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    newestSeen   = $newestIso
    generatedAt  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  [System.IO.File]::WriteAllText($metaPath, ($meta | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "META|$metaPath"
  exit 0
}

# ---------- -Send：发送 HTML 邮件 ----------
if ($Send) {
  if (-not $To) { Fail 3 "-Send 需要 -To" }
  if (-not $Subject) { Fail 3 "-Send 需要 -Subject" }
  if (-not $HtmlFile -or -not (Test-Path $HtmlFile)) { Fail 3 "-Send 需要存在的 -HtmlFile" }

  try {
    $html = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($HtmlFile), [System.Text.Encoding]::UTF8)
    $mail = $ol.CreateItem(0)     # 0 = olMailItem
    # -From 指定了就用那个账户发（对象在解析阶段已按 SmtpAddress 匹配好）；
    # 没传或没找到 → 保持 Outlook 自己的默认发件账户，不影响下面照常发送。
    if ($null -ne $script:SendAcct) { $mail.SendUsingAccount = $script:SendAcct }
    $mail.To = $To
    $mail.Subject = $Subject
    $mail.HTMLBody = $html
    $mail.Send()
    Write-Output "SENT|$To|$Subject"
    exit 0
  } catch {
    Fail 3 "发送失败：$($_.Exception.Message)"
  }
}

# ---------- -Sync：等 Outlook 连上 Exchange，再强制收一次邮件 ----------
# 为什么要这个：-Dump 读的是 **Outlook 本地缓存**。Outlook 刚被拉起来（或离线了一阵），
# 缓存可能停在十几小时前 —— 于是"读不出邮件"，日报还会说"0 封新邮件"。
# 2026-09-23 13:25 真实发生：缓存只到前一天 20:53，当天一整天的邮件都还没进来。
#
# 为什么还要**先等连接**（2026-09-28 真实事故）：Outlook 冷启动时 COM 已经可用，但它到
# Exchange 的会话还没建立。这时 SyncObjects.Start() 会**立刻**返回"完成"（实测 3 秒），
# 实际什么都没下载 —— 缓存一动不动，日报于是报"0 封新邮件"，而服务器上躺着两天的新邮件
# （11 封，最新一封就在 2 小时前）。所以：先轮询 ExchangeConnectionMode 等到真正连上再收信；
# 连不上就**明确报错**（退出码 5），让 Node 侧把这次的"0 封"判成"可能没读全"，
# 而不是"今天真的没邮件"。
# 连接模式取值见 OlExchangeConnectionMode：
#   600 = olCachedConnectedDrizzle / 700 = olCachedConnectedFull / 800 = olOnline → 已连接
#   100 = olOffline / 200 = olCachedOffline / 300 = olDisconnected / 400 = olCachedDisconnected → 离线
#   0   = olNoExchange（这个账户不走 Exchange，比如 IMAP）→ 不用等
# 这里主动触发一次"发送/接收"，并等到同步结束（最多 120 秒）再让 -Dump 去读。
# 注意：和手动按 F9 一样，Outbox 里排队的邮件会被发出去（Drafts 里的草稿不会）。
if ($Sync) {
  try {
    $ns = $ol.GetNamespace('MAPI')

    # 等连接多久可以用环境变量调（默认 60 秒；Outlook 冷启动一般 5-30 秒就绪）
    $connectWait = 60
    try { if ($env:MAIL_SYNC_CONNECT_SECONDS) { $connectWait = [int]$env:MAIL_SYNC_CONNECT_SECONDS } } catch { }

    $mode = -1
    try { $mode = [int]$ns.ExchangeConnectionMode } catch { }
    if ($mode -ne 0) {
      $deadline = (Get-Date).AddSeconds($connectWait)
      $waited = 0
      while ($mode -notin @(600, 700, 800) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $waited += 2
        try { $mode = [int]$ns.ExchangeConnectionMode } catch { }
      }
      Write-Output "SYNC|connect|mode=$mode|waited=${waited}s"
      if ($mode -notin @(600, 700, 800)) {
        # 退出码 5：没连上 Exchange。这时候收信必然是空转，所以**不去收**，直接把
        # "这次没同步成"的事实交给 Node 侧（见 lib/window.mjs 的 staleVerdict / syncWhy）。
        Write-Output "SYNC|offline|${connectWait}s 内没连上 Exchange（连接模式 $mode），本次不强制收信"
        exit 5
      }
    } else {
      Write-Output "SYNC|connect|mode=0|非 Exchange 账户，跳过连接等待"
    }

    $groups = $null
    try { $groups = $ns.SyncObjects } catch { $groups = $null }
    if ($null -eq $groups -or $groups.Count -lt 1) {
      Write-Output "SYNC|nogroup|这个 Outlook 没有配置发送/接收组，跳过"
      exit 0
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    for ($i = 1; $i -le $groups.Count; $i++) {
      try { $groups.Item($i).Start() } catch { }
    }
    # olSyncStarted = 1；等到所有组都不在同步中，或用完 120 秒
    $deadline = (Get-Date).AddSeconds(120)
    $busy = $true
    while ($busy -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 700
      $busy = $false
      for ($i = 1; $i -le $groups.Count; $i++) {
        try { if ([int]$groups.Item($i).State -eq 1) { $busy = $true } } catch { }
      }
    }
    # 耗时也报出来：Node 侧用它区分"真下载了"和"空转秒回"
    # （见 lib/window.mjs 的 shouldRecheckAfterSync —— 空转是 2026-09-28 误报的根因）
    Write-Output "SYNC|elapsed|$([int]$sw.Elapsed.TotalSeconds)s"
    # 退出码 4：同步没跑完 —— Node 那边据此判定"这次收信不算成功"，会在日报里报警
    if ($busy) { Write-Output "SYNC|timeout|同步 120 秒仍未结束（继续用现有缓存）"; exit 4 }
    else { Write-Output "SYNC|done|已强制收信并等到同步结束" }
    exit 0
  } catch {
    Fail 3 "强制同步失败：$($_.Exception.Message)"
  }
}

Fail 3 "没有指定模式：请用 -Check / -Dump / -Send / -Sync"
