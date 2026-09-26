import assert from "node:assert/strict"
import test from "node:test"

import {
  buildCondition,
  createMonitorTools,
  describeOutcome,
  MONITOR_TOOL_NAMES,
} from "./monitor.ts"
import { findTool, firstJson, firstText } from "../../../../test-support/tool-result.ts"
import type { CallableTool } from "../../../../test-support/tool-result.ts"

/** The params fields these tests read back from a recorded host call. */
interface RecordedParams {
  owner?: unknown
  requester?: unknown
  expiresAtMs?: number
}

function fakeHost(handlers: Record<string, (params: unknown) => unknown>) {
  const calls: { method: string; params: RecordedParams; options: unknown }[] = []
  return {
    calls,
    hostRpc: {
      async call(method: string, params: unknown, options?: unknown) {
        calls.push({ method, params: params as RecordedParams, options })
        const handler = handlers[method]
        if (!handler) throw new Error(`unexpected host_rpc method ${method}`)
        return handler(params)
      },
    },
  }
}

test("buildCondition maps every public condition shape onto the host protocol", () => {
  assert.deepEqual(buildCondition({ condition: "job_exit", shellId: "job-1" }), {
    ok: true,
    condition: { kind: "jobExit", jobId: "job-1" },
  })
  assert.deepEqual(
    buildCondition({ condition: "job_output", shellId: "job-1", pattern: "ready" }),
    {
      ok: true,
      condition: { kind: "jobOutput", jobId: "job-1", pattern: "ready" },
    }
  )
  assert.deepEqual(
    buildCondition(
      { condition: "shell", command: "test -f ready", cwd: "/repo", interval_ms: 2_000 },
      {
        resolveShell: () => ({
          shell: "/bin/sh",
          shellArgs: ["-c", "test -f ready"],
          env: { PATH: "/usr/bin" },
        }),
      }
    ),
    {
      ok: true,
      condition: {
        kind: "shellPredicate",
        command: "test -f ready",
        program: "/bin/sh",
        args: ["-c", "test -f ready"],
        cwd: "/repo",
        env: { PATH: "/usr/bin" },
        intervalMs: 2_000,
      },
    }
  )
  assert.deepEqual(
    buildCondition({ condition: "upstream", source: "scheduledTask", id: "run-1" }),
    {
      ok: true,
      condition: { kind: "upstream", source: "scheduledTask", id: "run-1" },
    }
  )
})

/** The rejection message of a buildCondition result that must have failed. */
function rejection(result: ReturnType<typeof buildCondition>): string {
  assert.equal(result.ok, false)
  return (result as { error: string }).error
}

test("buildCondition rejects incomplete or invalid conditions before host registration", () => {
  assert.match(rejection(buildCondition({ condition: "job_exit" })), /requires shellId/)
  assert.match(
    rejection(buildCondition({ condition: "job_output", shellId: "job-1", pattern: "[" })),
    /invalid pattern/
  )
  assert.match(rejection(buildCondition({ condition: "shell" })), /requires command/)
  assert.match(
    rejection(buildCondition({ condition: "upstream", source: "subagent" })),
    /requires id/
  )
})

test("Monitor returns a terminal outcome inline and preserves session ownership", async () => {
  const { hostRpc, calls } = fakeHost({
    "monitors.register": () => ({ id: "monitor-1", status: "waiting" }),
    "monitors.wait": () => ({
      id: "monitor-1",
      status: "fired",
      detail: "job job-1 exited with code 0",
    }),
  })
  const monitor = findTool(createMonitorTools({ hostRpc, sessionId: "session-1" }), "Monitor")

  const result = await monitor.handler(
    { condition: "job_exit", shellId: "job-1", timeout_ms: 1_000 },
    {}
  )

  assert.match(firstText(result), /condition met/)
  assert.match(firstText(result), /monitor-1/)
  assert.deepEqual(calls[0]!.params.owner, { kind: "session", sessionId: "session-1" })
  assert.equal(calls[1]!.method, "monitors.wait")
})

test("Monitor degrades a long wait into a durable watch at the blocking threshold", async () => {
  const { hostRpc, calls } = fakeHost({
    "monitors.register": () => ({ id: "monitor-async", status: "waiting" }),
    "monitors.wait": async () => {
      await new Promise((resolve) => setTimeout(resolve, 6))
      return { id: "monitor-async", status: "waiting" }
    },
  })
  const monitor = findTool(
    createMonitorTools({
      hostRpc,
      sessionId: "session-1",
      blockingThresholdMs: 5,
      waitChunkMs: 5,
    }),
    "Monitor"
  )

  const result = await monitor.handler(
    { condition: "upstream", source: "subagent", id: "task-1", timeout_ms: 60_000 },
    {}
  )

  assert.match(firstText(result), /background watch/)
  assert.match(firstText(result), /monitor-async/)
  assert.equal(calls[0]!.params.expiresAtMs! > Date.now(), true)
})

test("monitor_cancel and monitor_list are scoped to the owning session", async () => {
  const { hostRpc, calls } = fakeHost({
    "monitors.cancel": () => ({ id: "monitor-1", status: "cancelled" }),
    "monitors.list": () => ({ monitors: [{ id: "monitor-2", status: "waiting" }] }),
  })
  const tools = Object.fromEntries(
    createMonitorTools({ hostRpc, sessionId: "session-1" }).map((definition) => [
      definition.name,
      definition as unknown as CallableTool,
    ])
  ) as Record<string, CallableTool>

  const cancelled = await tools.monitor_cancel!.handler({ monitorId: "monitor-1" }, {})
  const listed = await tools.monitor_list!.handler({}, {})

  assert.match(firstText(cancelled), /cancelled/)
  assert.deepEqual(calls[0]!.params.requester, { kind: "session", sessionId: "session-1" })
  assert.deepEqual(calls[1]!.params.owner, { kind: "session", sessionId: "session-1" })
  assert.deepEqual(firstJson<{ monitors: unknown[] }>(listed).monitors, [
    { id: "monitor-2", status: "waiting" },
  ])
})

test("monitor definitions and outcome text stay stable", () => {
  assert.deepEqual(
    createMonitorTools({}).map((definition) => definition.name),
    [...MONITOR_TOOL_NAMES]
  )
  assert.equal(
    describeOutcome({ status: "cancelled", detail: "by user" }),
    "monitor cancelled — by user"
  )
  assert.equal(describeOutcome({ status: "waiting" }), "monitor is still waiting")
})
