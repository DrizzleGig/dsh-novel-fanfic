param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Failure([string]$Message) {
  @{ ok = $false; error = $Message } | ConvertTo-Json -Compress
  exit 1
}

try {
  Add-Type -AssemblyName System.Drawing | Out-Null
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Write-Failure "file not found: $Path" }
  if ($W -le 0 -or $H -le 0) { Write-Failure 'width/height must be positive' }
  $image = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Path).Path)
  try {
    if ($X -lt 0 -or $Y -lt 0 -or ($X + $W) -gt $image.Width -or ($Y + $H) -gt $image.Height) {
      Write-Failure 'crop rectangle out of bounds'
    }
    $bmp = New-Object System.Drawing.Bitmap $W, $H
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $dest = New-Object System.Drawing.Rectangle 0, 0, $W, $H
        $src = New-Object System.Drawing.Rectangle $X, $Y, $W, $H
        $g.DrawImage($image, $dest, $src, [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $g.Dispose() }
      $dir = Split-Path -Parent $Out
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
  } finally { $image.Dispose() }
  @{ ok = $true; width = $W; height = $H; out = $Out } | ConvertTo-Json -Compress
} catch {
  Write-Failure ([string]$_.Exception.Message)
}
