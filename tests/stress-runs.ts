import { spawn } from "bun";

console.log("=== Multi-Run Consecutive Flakiness Stress Test ===");
const TOTAL_RUNS = 10;
let passes = 0;
let fails = 0;
const runDurations: number[] = [];

for (let i = 1; i <= TOTAL_RUNS; i++) {
  const start = performance.now();
  const proc = spawn(["bun", "test"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const duration = performance.now() - start;
  runDurations.push(duration);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const summaryLine = stdout.split("\n").filter(l => l.includes("pass") || l.includes("fail") || l.includes("Ran")).join(" | ");

  if (exitCode === 0) {
    passes++;
    console.log(`[PASS] Run ${i}/${TOTAL_RUNS} in ${duration.toFixed(0)}ms: ${summaryLine}`);
  } else {
    fails++;
    console.error(`[FAIL] Run ${i}/${TOTAL_RUNS} exited with code ${exitCode} in ${duration.toFixed(0)}ms:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }
}

const avgDuration = runDurations.reduce((a, b) => a + b, 0) / TOTAL_RUNS;
const minDuration = Math.min(...runDurations);
const maxDuration = Math.max(...runDurations);

console.log("\n=== Stress Run Results ===");
console.log(`Total Runs: ${TOTAL_RUNS}`);
console.log(`Passes: ${passes}`);
console.log(`Fails: ${fails}`);
console.log(`Avg Duration: ${avgDuration.toFixed(0)}ms (Min: ${minDuration.toFixed(0)}ms, Max: ${maxDuration.toFixed(0)}ms)`);

if (fails > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
