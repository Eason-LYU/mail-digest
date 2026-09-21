# 失败提醒：在桌面留一个显眼的文件 + 弹一个会自动消失的提示框
#
# 为什么两层：弹窗只有你正坐在电脑前才看得到；桌面文件即使你几小时后回来也能发现。
# 成功运行时由 Node 侧调用 -Mode clear 自动清掉这些提醒文件，不会越积越多。
param(
  [ValidateSet('warn', 'clear')] [string]$Mode = 'warn',
  [string]$TextFile,
  [int]$Seconds = 60
)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 取真实桌面路径（可能被 OneDrive 重定向，不能直接拼 %USERPROFILE%\Desktop）
$desktop = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -Name Desktop).Desktop
if (-not $desktop -or -not (Test-Path $desktop)) { $desktop = [Environment]::GetFolderPath('Desktop') }
if (-not $desktop -or -not (Test-Path $desktop)) {
  Write-Output "ERROR|找不到桌面路径"
  exit 3
}

if ($Mode -eq 'clear') {
  # 注意：不要用 -Filter 传中文通配符——PowerShell 5.1 的文件系统 -Filter 对非 ASCII 匹配不可靠
  # （实测会漏掉中文文件名，导致"清不掉"）。这里改成枚举后在 PowerShell 里比较。
  $n = 0
  Get-ChildItem -Path $desktop -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*邮件日报*失败*.txt' } |
    ForEach-Object {
      $target = $_.FullName
      Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $target)) { $n++ }
    }
  Write-Output "CLEARED|$desktop|removed=$n"
  exit 0
}

if (-not $TextFile -or -not (Test-Path $TextFile)) {
  Write-Output "ERROR|没有提供内容文件"
  exit 3
}

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$stamp = Get-Date -Format 'yyyy-MM-dd HHmm'
$dest = Join-Path $desktop ("邮件日报失败 " + $stamp + ".txt")

# 写桌面文件——**必须验证是否真的写成功**。
# 教训：之前这里不检查就打印 "WROTE"，结果在受限环境里写入被静默拦掉，
# 却仍然报告成功，等于谎报。现在写不进去就退回项目 logs 目录，并如实报告位置。
$where = $null
try {
  [System.IO.File]::WriteAllText($dest, $text, (New-Object System.Text.UTF8Encoding($true)))
} catch { }
if (Test-Path -LiteralPath $dest) {
  $where = $dest
  Write-Output "WROTE|$dest"
} else {
  $fallback = Join-Path (Split-Path -Parent $TextFile) ("邮件日报失败 " + $stamp + ".txt")
  try {
    [System.IO.File]::WriteAllText($fallback, $text, (New-Object System.Text.UTF8Encoding($true)))
  } catch { }
  if (Test-Path -LiteralPath $fallback) {
    $where = $fallback
    Write-Output "FALLBACK|$fallback"
  } else {
    $where = $TextFile
    Write-Output "ERROR|提醒文件写入失败，仅弹窗"
  }
}

# 弹窗：超时自动关闭，不需要你点（0x30 = 警告图标）
$msg = $text + "`r`n`r`n提醒文件位置：`r`n" + $where
if ($msg.Length -gt 700) { $msg = $msg.Substring(0, 700) + " ..." }
try {
  $sh = New-Object -ComObject WScript.Shell
  [void]$sh.Popup($msg, $Seconds, '邮件日报运行失败', 0x30)
  Write-Output "POPUP|shown"
} catch {
  Write-Output "POPUP|failed: $($_.Exception.Message)"
}
exit 0
