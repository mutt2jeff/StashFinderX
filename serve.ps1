# Tiny local web server for trying SnowScout web on this PC.
#   powershell -ExecutionPolicy Bypass -File serve.ps1
# then open http://localhost:8765 . Press Ctrl+C to stop.
# (Only for testing on this computer. Testers use the hosted copy.)
#
# -Dev also lets tests/build-bc.html and tests/build-ab.html build the BC and Alberta snow
# files locally (what the GitHub Action does online): it can fetch the provinces' source
# files and save data/bc-*.json and data/ab-*.json. tests/build-snotel.html saves
# data/snotel-latest.json (the map's snow colors) the same way.

param([int]$Port = 8765, [switch]$Dev)
$root = $PSScriptRoot
$bcSources = @{
  'stations' = 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=WHSE_WATER_MANAGEMENT.SSL_SNOW_ASWS_STNS_SP&outputFormat=application/json&srsName=EPSG:4326'
  'depth' = 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/SD.csv'
  'swe' = 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/SW.csv'
  'temp' = 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/TA.csv'
}
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'
  '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "SnowScout web running at http://localhost:$Port  (Ctrl+C to stop)"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($path -eq '' -or $path.EndsWith('/')) { $path += 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path))
    $res = $ctx.Response
    if ($env:SNOWSCOUT_SERVE_LOG) {
      Add-Content $env:SNOWSCOUT_SERVE_LOG "$(Get-Date -Format o) $($ctx.Request.HttpMethod) /$path sw=$($ctx.Request.Headers['Service-Worker'])"
    }
    if ($Dev -and $path -match '^_bc/(stations|depth|swe|temp)$') {
      # Dev only: fetch one of BC's source files (fixed list, nothing else).
      try {
        $bytes = (Invoke-WebRequest $bcSources[$Matches[1]] -UseBasicParsing -TimeoutSec 90).RawContentStream.ToArray()
        $res.ContentType = 'text/plain; charset=utf-8'
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } catch { $res.StatusCode = 502 }
    } elseif ($Dev -and ($path -eq '_ab/manifest' -or $path -match '^_ab/table/([A-Za-z0-9-]{1,20})$')) {
      # Dev only: fetch Alberta Rivers' station manifest or one station's 5-day file.
      $url = if ($path -eq '_ab/manifest') { 'https://rivers.alberta.ca/EnvironmentalDataService/ReadManifest' }
        else { "https://rivers.alberta.ca/apps/Basins/data/figures/river/abrivers/envdata/envdata_$($Matches[1])_table.json" }
      try {
        $bytes = (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 90).RawContentStream.ToArray()
        $res.ContentType = 'application/json; charset=utf-8'
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } catch { $res.StatusCode = 502 }
    } elseif ($Dev -and $ctx.Request.HttpMethod -eq 'PUT' -and $path -match '^data/((bc|ab|acis)-(stations|readings)|snotel-latest)\.json$') {
      # Dev only: save a built BC or Alberta file.
      New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
      $ms = New-Object IO.MemoryStream
      $ctx.Request.InputStream.CopyTo($ms)
      [IO.File]::WriteAllBytes((Join-Path $root $path), $ms.ToArray())
      $res.StatusCode = 204
    } elseif ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $bytes = [IO.File]::ReadAllBytes($file)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
    $res.Close()
  }
} finally {
  $listener.Stop()
}
