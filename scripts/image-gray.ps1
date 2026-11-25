param(
  [Parameter(Mandatory = $true)]
  [string]$Path,
  [int]$MaxWidth = 240,
  [int]$MaxHeight = 360
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

  $image = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Path).Path)
  try {
    $scale = [Math]::Min(1.0, [Math]::Min($MaxWidth / [double]$image.Width, $MaxHeight / [double]$image.Height))
    $w = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
    $h = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($image, 0, 0, $w, $h)
      } finally { $g.Dispose() }

      $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
      $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      try {
        $stride = $data.Stride
        $bytes = New-Object byte[] ($stride * $h)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
      } finally { $bmp.UnlockBits($data) }

      $gray = New-Object byte[] ($w * $h)
      for ($y = 0; $y -lt $h; $y++) {
        $row = $y * $stride
        $outRow = $y * $w
        for ($x = 0; $x -lt $w; $x++) {
          $i = $row + $x * 3
          $b = [double]$bytes[$i]
          $gch = [double]$bytes[$i + 1]
          $r = [double]$bytes[$i + 2]
          $gray[$outRow + $x] = [byte][Math]::Round(0.299 * $r + 0.587 * $gch + 0.114 * $b)
        }
      }

      @{
        ok = $true
        width = $w
        height = $h
        originalWidth = $image.Width
        originalHeight = $image.Height
        scale = $scale
        gray = [Convert]::ToBase64String($gray)
      } | ConvertTo-Json -Compress
    } finally { $bmp.Dispose() }
  } finally { $image.Dispose() }
} catch {
  Write-Failure ([string]$_.Exception.Message)
}
