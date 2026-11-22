$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mediaDir = Join-Path $root "media"
$outFile = Join-Path $root "media-manifest.json"
$extensions = @(".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov")

$files = if (Test-Path $mediaDir) {
  Get-ChildItem -Path $mediaDir -Recurse -File |
    Where-Object { $extensions -contains $_.Extension.ToLower() } |
    Sort-Object FullName |
    ForEach-Object {
      $rel = $_.FullName.Substring($root.Length + 1) -replace "\\", "/"
      $parts = $rel -split "/"
      [PSCustomObject]@{
        path   = $rel
        folder = if ($parts.Count -gt 2) { $parts[1] } else { "" }
        name   = $_.Name
        sizeMB = [math]::Round($_.Length / 1MB, 2)
      }
    }
} else { @() }

[PSCustomObject]@{
  generatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
  count       = @($files).Count
  items       = @($files)
} | ConvertTo-Json -Depth 4 | Set-Content -Path $outFile -Encoding UTF8

Write-Host "Updated media-manifest.json with $(@($files).Count) items."
