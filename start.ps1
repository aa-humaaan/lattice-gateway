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

if (Test-Path "bin\lattice.exe") {
  & "bin\lattice.exe"
} else {
  bun run src/index.ts
}
