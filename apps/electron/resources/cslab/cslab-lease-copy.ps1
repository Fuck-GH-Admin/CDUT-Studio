# CSLab 独占读租约流式拷贝（Windows）
#
# 作用：用 .NET FileStream 以 FileShare.Read 打开源文件，等价于
#       CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, ...)，
#       显式排除写入与删除共享位；随后边读边写本地暂存文件并实时计算 SHA-256。
#
# 输出：stdout 单行 JSON —— {"ok":true,"sha256":"...","bytes":123}
#       失败：{"ok":false,"error":"..."} 并 exit 1
#
# 红线：目标必须是本地路径（非 UNC），避免把暂存盘放到网络盘上。

param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$payload) {
  [Console]::Out.Write(($payload | ConvertTo-Json -Compress -Depth 3))
}

try {
  if ($Destination.StartsWith('\\')) {
    Write-Result @{ ok = $false; error = 'destination-not-local' }
    exit 1
  }

  $sourceStream = [System.IO.File]::Open(
    $Source,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )

  $targetStream = [System.IO.File]::Create($Destination)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $crypto = New-Object System.Security.Cryptography.CryptoStream(
    $targetStream,
    $sha,
    [System.Security.Cryptography.CryptoStreamMode]::Write
  )

  $buffer = New-Object byte[] 1048576
  $total = [long]0
  while (($read = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $crypto.Write($buffer, 0, $read)
    $total += $read
  }

  # FlushFinalBlock 会同时把目标 FileStream 落盘（OS 缓冲），随后逐个释放句柄。
  $crypto.FlushFinalBlock()
  $crypto.Dispose()
  $targetStream.Dispose()
  $sourceStream.Dispose()

  $hex = -join ($sha.Hash | ForEach-Object { $_.ToString('x2') })
  $sha.Dispose()

  Write-Result @{ ok = $true; sha256 = $hex; bytes = $total }
  exit 0
}
catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
