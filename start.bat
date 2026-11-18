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

REM Always run the TypeScript source by default. A compiled binary goes stale
REM the moment source changes; never prefer one implicitly. Use --exe only when
REM you deliberately want the last compiled build.
if "%~1"=="--exe" (
  shift
  if exist "bin\lattice.exe" (
    bin\lattice.exe %*
  ) else (
    echo No compiled binary found. Run "bun run build" first.
  )
) else (
  bun run src/index.ts %*
)
pause
