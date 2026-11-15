import { spawn } from "bun";

console.log("=== Concurrency Stress Test: 4 Parallel Full Test Suites ===");

const PARALLEL_JOBS = 4;
const startTime = performance.now();

const promises = Array.from({ length: PARALLEL_JOBS }, async (_, idx) => {
  const jobId = idx + 1;
  const start = performance.now();
  console.log(`[START] Parallel worker #${jobId} launched`);
  
  const proc = spawn(["bun", "test"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const duration = performance.now() - start;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode === 0) {
    console.log(`[PASS] Parallel worker #${jobId} finished cleanly in ${duration.toFixed(0)}ms`);
    return { id: jobId, success: true, duration };
  } else {
    console.error(`[FAIL] Parallel worker #${jobId} exited with code ${exitCode} in ${duration.toFixed(0)}ms:\n${stderr || stdout}`);
    return { id: jobId, success: false, duration, error: stderr || stdout };
  }
});

const results = await Promise.all(promises);
const totalTime = performance.now() - startTime;

console.log(`\n=== Tier-Split Concurrency Test ===`);
const tierJobs = [
  { name: "tier1-feature", path: "tests/e2e/tier1-feature" },
  { name: "tier2-boundary", path: "tests/e2e/tier2-boundary" },
  { name: "tier3-combination", path: "tests/e2e/tier3-combination" },
  { name: "tier4-scenarios", path: "tests/e2e/tier4-scenarios" },
];

const tierPromises = tierJobs.map(async (job) => {
  const start = performance.now();
  const proc = spawn(["bun", "test", job.path], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const duration = performance.now() - start;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode === 0) {
    console.log(`[PASS] Tier worker ${job.name} finished cleanly in ${duration.toFixed(0)}ms`);
    return { name: job.name, success: true, duration };
  } else {
    console.error(`[FAIL] Tier worker ${job.name} failed with code ${exitCode}:\n${stderr || stdout}`);
    return { name: job.name, success: false, duration };
  }
});

const tierResults = await Promise.all(tierPromises);

console.log("\n=== Concurrency Results Summary ===");
const parallelSuccess = results.every(r => r.success);
const tierSuccess = tierResults.every(r => r.success);
console.log(`4 Parallel Suites: ${parallelSuccess ? "ALL PASSED" : "FAILED"} (Wall time: ${totalTime.toFixed(0)}ms)`);
console.log(`Tier-Split Suites: ${tierSuccess ? "ALL PASSED" : "FAILED"}`);

if (!parallelSuccess || !tierSuccess) {
  process.exit(1);
} else {
  process.exit(0);
}
