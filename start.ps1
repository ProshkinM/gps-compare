$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$ntpNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $ntpNode) { throw 'Install Node.js 22 or newer: https://nodejs.org/' }
Write-Host 'Open http://127.0.0.1:8765 in your browser. Stop: Ctrl+C.'
& $ntpNode (Join-Path $PSScriptRoot 'server.mjs')
