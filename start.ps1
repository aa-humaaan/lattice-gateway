Set-Location -Path $PSScriptRoot
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "         Project Lattice Gateway Launcher               " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Starting Project Lattice on port 4000..." -ForegroundColor Green
Write-Host "Admin Panel:     http://127.0.0.1:4000/admin" -ForegroundColor Yellow
Write-Host "OpenAI Endpoint: http://127.0.0.1:4000/v1" -ForegroundColor Yellow
Write-Host "Stop with:       Ctrl+C" -ForegroundColor Gray
Write-Host ""

# Never kill processes holding port 4000. If the port is busy, Lattice
# reports it and exits; choose another port with: .\lattice.exe --port 4001

# Always run the TypeScript source by default. A compiled binary goes stale
# the moment source changes; never prefer one implicitly. Use -Exe only when
# you deliberately want the last compiled build.
if ($args -contains '--exe') {
  $exeArgs = @($args | Where-Object { $_ -ne '--exe' })
  if (Test-Path "bin\lattice.exe") {
    & ".\bin\lattice.exe" @exeArgs
  } else {
    Write-Host "No compiled binary found. Run 'bun run build' first." -ForegroundColor Red
  }
} else {
  bun run src/index.ts @args
}
