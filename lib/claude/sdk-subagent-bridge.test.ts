/**
 * @jest-environment jsdom
 */

import { applySdkSubagentBridge, __resetSdkSubagentBridge } from "./sdk-subagent-bridge"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

const SID = "chat-1"

function node(taskId: string) {
  return useSubagentRuntimeStore.getState().subAgents[taskId]
}

function started(over: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "task_started",
    task_id: "T1",
    tool_use_id: "tu1",
    description: "Research X",
    subagent_type: "researcher",
    prompt: "go",
    uuid: "u",
    session_id: "sdk",
    ...over,
  } as never
}

beforeEach(() => {
  useSubagentRuntimeStore.getState().clearRuntime()
  __resetSdkSubagentBridge()
})

describe("applySdkSubagentBridge — lifecycle", () => {
  it("creates a running subagent on task_started attached to the session", () => {
    applySdkSubagentBridge(started(), SID)
    const n = node("T1")!
    expect(n).toBeTruthy()
    expect(n.name).toBe("researcher")
    expect(n.status).toBe("running")
    expect(n.depth).toBe(1)
    expect(n.context?.sessionId).toBe(SID)
    expect(n.task).toBe("go")
  })

  it("ignores ambient/housekeeping task_started (skip_transcript or no subagent_type)", () => {
    applySdkSubagentBridge(
      started({ task_id: "T2", subagent_type: undefined, skip_transcript: true }),
      SID
    )
    applySdkSubagentBridge(
      started({ task_id: "T3", subagent_type: undefined, task_type: "local_workflow" }),
      SID
    )
    expect(node("T2")).toBeUndefined()
    expect(node("T3")).toBeUndefined()
  })

  it("does not duplicate a node when task_started repeats", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(started(), SID)
    expect(Object.keys(useSubagentRuntimeStore.getState().subAgents)).toEqual(["T1"])
  })

  it("logs the last tool and advances progress on task_progress", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      {
        type: "system",
        subtype: "task_progress",
        task_id: "T1",
        description: "d",
        subagent_type: "researcher",
        last_tool_name: "Read",
        usage: { total_tokens: 10, tool_uses: 3, duration_ms: 5 },
        uuid: "u",
        session_id: "sdk",
      } as never,
      SID
    )
    const n = node("T1")!
    expect(n.logs.some((l) => l.message.includes("Read"))).toBe(true)
    expect(n.progress).toBe(30) // 3 tool_uses * 10
  })

  it("completes the subagent on task_updated status completed", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      {
        type: "system",
        subtype: "task_updated",
        task_id: "T1",
        patch: { status: "completed" },
        uuid: "u",
        session_id: "sdk",
      } as never,
      SID
    )
    const n = node("T1")!
    expect(n.status).toBe("completed")
    expect(n.progress).toBe(100)
  })

  it("maps failed/killed task_updated to terminal statuses", () => {
    for (const [patchStatus, expected] of [
      ["failed", "failed"],
      ["killed", "cancelled"],
    ] as const) {
      useSubagentRuntimeStore.getState().clearRuntime()
      __resetSdkSubagentBridge()
      applySdkSubagentBridge(started(), SID)
      applySdkSubagentBridge(
        {
          type: "system",
          subtype: "task_updated",
          task_id: "T1",
          patch: { status: patchStatus, error: "x" },
          uuid: "u",
          session_id: "sdk",
        } as never,
        SID
      )
      expect(node("T1")!.status).toBe(expected)
    }
  })

  it("ignores task_progress/task_updated for an unknown task", () => {
    applySdkSubagentBridge(
      {
        type: "system",
        subtype: "task_updated",
        task_id: "ghost",
        patch: { status: "completed" },
        uuid: "u",
        session_id: "sdk",
      } as never,
      SID
    )
    expect(node("ghost")).toBeUndefined()
  })
})

describe("applySdkSubagentBridge — rich logs via parent_tool_use_id", () => {
  it("appends text + tool logs from forwarded subagent frames", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      {
        type: "assistant",
        parent_tool_use_id: "tu1",
        uuid: "u",
        session_id: "sdk",
        message: {
          id: "m",
          role: "assistant",
          content: [
            { type: "text", text: "thinking..." },
            { type: "tool_use", id: "x", name: "Grep", input: { q: "z" } },
          ],
        },
      } as never,
      SID
    )
    const n = node("T1")!
    expect(n.logs.some((l) => l.message === "thinking...")).toBe(true)
    expect(n.logs.some((l) => l.message === "Grep")).toBe(true)
  })

  it("logs tool_result blocks from forwarded subagent user frames", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      {
        type: "user",
        parent_tool_use_id: "tu1",
        uuid: "u",
        session_id: "sdk",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "out", is_error: true }],
        },
      } as never,
      SID
    )
    const n = node("T1")!
    const entry = n.logs.find((l) => l.message === "tool_result")
    expect(entry).toBeTruthy()
    expect(entry!.level).toBe("error")
  })

  it("ignores parent_tool_use_id frames with no known task (dispatch_agent path)", () => {
    applySdkSubagentBridge(
      {
        type: "assistant",
        parent_tool_use_id: "unknown",
        uuid: "u",
        session_id: "sdk",
        message: { id: "m", role: "assistant", content: [{ type: "text", text: "x" }] },
      } as never,
      SID
    )
    expect(Object.keys(useSubagentRuntimeStore.getState().subAgents)).toHaveLength(0)
  })
})

describe("applySdkSubagentBridge — robustness", () => {
  it("never throws on malformed input", () => {
    expect(() => applySdkSubagentBridge({ type: "result" } as never, SID)).not.toThrow()
    expect(() => applySdkSubagentBridge(null as never, SID)).not.toThrow()
    expect(() =>
      applySdkSubagentBridge({ type: "system", subtype: "other" } as never, SID)
    ).not.toThrow()
  })
})
