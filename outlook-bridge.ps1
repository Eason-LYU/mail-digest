# Outlook COM 桥接：为 Node 日报脚本提供"读收件箱 / 发邮件"能力
#
# 为什么要这个：PolyU 租户禁止用户自行同意第三方应用，Microsoft Graph 那条路走不通。
# 经典版 Outlook 自己持有登录态（与 Windows 里的学校工作账号打通），
# 通过 COM 驱动它读写邮件，完全绕开"应用授权"机制，不需要管理员同意。
#
# 模式（三选一）：
#   -Check                                              只报告 Outlook 配置/账号/收件箱状态
#   -Dump <json路径> [-Hours N] [-Max N]                把最近 N 小时的收件箱邮件写成 JSON
#   -Send -To <地址> -Subject <主题> -HtmlFile <html>   用 Outlook 发一封 HTML 邮件
#
# 可选参数（两个都不传 = 与以前完全一致，用 Outlook 自己的默认值）：
#   -Account <smtp地址>  读哪个邮箱的收件箱（按 $ns.Accounts 的 SmtpAddress 匹配，大小写不敏感）
#   -From    <smtp地址>  -Send 时用哪个账户发（找不到只警告，仍然照常发送）
#
# 退出码: 0 成功 | 2 Outlook 尚未配置好 | 3 其他错误（含 -Account 指定的账户不存在）
[CmdletBinding()]
param(
  [switch]$Check,
  [string]$Dump,
  [double]$Hours = 24,
  [int]$Max = 300,
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

# ---------- -Dump：导出邮件为 JSON ----------
if ($Dump) {
  $cutoff = (Get-Date).AddHours(-$Hours)
  $outPath = [System.IO.Path]::GetFullPath($Dump)

  try {
    $inbox = Open-InboxFolder
  } catch {
    Fail 2 "无法打开收件箱：$($_.Exception.Message)"
  }

  $items = $inbox.Items
  # 尽力按时间倒序（但下面的循环不依赖它是否生效）
  try { $items.Sort('[ReceivedTime]', $true) } catch { }

  $list = New-Object System.Collections.Generic.List[object]
  $total = $items.Count
  $scanned = 0
  $newestSeen = $null
  $miss = 0
  $maxScan = 800        # 排序不可靠时的兜底：最多扫这么多条
  $missLimit = 80       # 连续这么多条都早于窗口，才认为后面更早、可以停

  for ($i = 1; $i -le $total; $i++) {
    if ($list.Count -ge $Max) { break }
    if ($scanned -ge $maxScan) { break }
    $it = $items.Item($i)
    $scanned++
    $rt = $it.ReceivedTime
    if (-not $newestSeen -or $rt -gt $newestSeen) { $newestSeen = $rt }

    if ($rt -lt $cutoff) {
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

    $list.Add([pscustomobject]@{
      id               = [string]$it.EntryID
      conversationId   = [string]$it.ConversationID
      subject          = [string]$it.Subject
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
  }

  $json = $list | ConvertTo-Json -Depth 6
  if ($list.Count -eq 0) { $json = '[]' }
  # 必须写成 UTF-8 无 BOM，否则 Node 的 JSON.parse 会因为 BOM 报错
  [System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  if ($newestSeen) { $newestTxt = $newestSeen.ToString('yyyy-MM-dd HH:mm') } else { $newestTxt = '(空)' }
  Write-Output "DUMPED|$outPath|count=$($list.Count)|scanned=$scanned|total=$total|cutoff=$($cutoff.ToString('yyyy-MM-dd HH:mm'))|newestSeen=$newestTxt"

  # 侧写一份元数据给 Node 用（避免去解析日志行）。
  # newestSeenMailAt 是"本次真正读到的最新邮件时间"，Node 靠它决定窗口怎么推进——
  # 若这次一封都没读到，Node 就不会推进窗口，从而避免"缓存没同步完 → 邮件被永久跳过"。
  $metaPath = Join-Path (Split-Path -Parent $outPath) 'inbox-meta.json'
  $newestIso = $null
  if ($newestSeen) { $newestIso = $newestSeen.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
  $meta = [pscustomobject]@{
    count       = $list.Count
    scanned     = $scanned
    total       = $total
    cutoff      = $cutoff.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    newestSeen  = $newestIso
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
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

Fail 3 "没有指定模式：请用 -Check / -Dump / -Send"
