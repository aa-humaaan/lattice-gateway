@echo off
cd /d "%~dp0"
echo ========================================================
echo               Project Lattice Gateway Launcher
echo ========================================================
echo.
echo Starting Project Lattice on port 4000...
echo Admin Panel:     http://127.0.0.1:4000/admin
echo OpenAI Endpoint: http://127.0.0.1:4000/v1
echo Stop with: Ctrl+C
echo.

REM Never kill processes holding port 4000. If the port is busy, Lattice
REM reports it and exits; choose another port with: lattice.exe --port 4001

if exist "lattice.exe" (
  lattice.exe %*
) else if exist "bin\lattice.exe" (
  bin\lattice.exe %*
) else (
  bun run src/index.ts %*
)
pause
