import assert from "node:assert/strict"
import test from "node:test"
import { startGatewayProcess } from "./gateway-process.mjs"

const childOptions = (script, extra = {}) => ({
  binaryPath: process.execPath,
  args: ["-e", script],
  startupTimeoutMs: 2_000,
  shutdownTimeoutMs: 100,
  ...extra,
})

for (const stream of ["stdout", "stderr"]) {
  test(`observes split readiness on ${stream} and closes idempotently`, async (t) => {
    const gateway = await startGatewayProcess(
      childOptions(`
      process.${stream}.write("12:00:00 [INFO] LLM gateway listening on port ");
      setTimeout(() => process.${stream}.write("Some(43210)\\n"), 10);
      setInterval(() => {}, 1000);
    `)
    )
    t.after(gateway.close)
    assert.equal(gateway.gatewayPort, 43210)
    assert.match(gateway.logs[stream], /Some\(43210\)/)
    await Promise.all([gateway.close(), gateway.close()])
    await gateway.close()
  })
}

test("reports spawn errors promptly without retaining startup timers", async () => {
  await assert.rejects(
    startGatewayProcess({
      binaryPath: "/nonexistent/cognia-conformance-server",
      startupTimeoutMs: 30_000,
    }),
    /failed to spawn.*ENOENT/
  )
})

test("reports early exit with captured stderr", async () => {
  await assert.rejects(
    startGatewayProcess(
      childOptions(`
    process.stderr.write("synthetic startup failure");
    process.exitCode = 7;
  `)
    ),
    /exited early \(7\)[\s\S]*synthetic startup failure/
  )
})

test("reports a signal exit without waiting for the startup deadline", async () => {
  await assert.rejects(
    startGatewayProcess(
      childOptions(`
    process.kill(process.pid, "SIGTERM");
  `)
    ),
    /exited early \(SIGTERM\)/
  )
})

test("startup timeout kills the child and retains its diagnostics", async () => {
  let pid
  await assert.rejects(
    startGatewayProcess(
      childOptions(
        `
    process.on("SIGINT", () => {});
    process.stderr.write("pid=" + process.pid);
    setInterval(() => {}, 1000);
  `,
        { startupTimeoutMs: 300 }
      )
    ),
    (error) => {
      assert.match(error.message, /gateway port not observed in time/)
      pid = Number(error.message.match(/pid=(\d+)/)?.[1])
      assert.ok(pid > 0)
      return true
    }
  )
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
})

test("close escalates when a ready child ignores SIGINT", async (t) => {
  const gateway = await startGatewayProcess(
    childOptions(`
    process.on("SIGINT", () => {});
    process.stderr.write("pid=" + process.pid + "\\nLLM gateway listening on port Some(43210)");
    setInterval(() => {}, 1000);
  `)
  )
  t.after(gateway.close)
  const pid = Number(gateway.logs.stderr.match(/pid=(\d+)/)[1])
  await gateway.close()
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
})
