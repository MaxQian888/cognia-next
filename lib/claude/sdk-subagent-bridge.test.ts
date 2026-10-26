/**
 * @jest-environment jsdom
 */

import { applySdkSubagentBridge, __resetSdkSubagentBridge } from "./sdk-subagent-bridge"
import { requestCancelSubagentRun } from "./agents/subagent-cancel-registry"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SDKTaskStartedMessage } from "@cognia/agent-config-types"

const SID = "chat-1"

function node(taskId: string) {
  return useSubagentRuntimeStore.getState().subAgents[taskId]
}

function started(over: Partial<SDKTaskStartedMessage> = {}): SDKTaskStartedMessage {
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
  }
}

beforeEach(() => {
  useSubagentRuntimeStore.getState().clearRuntime()
  __resetSdkSubagentBridge()
})

describe("applySdkSubagentBridge — lifecycle", () => {
  it("does not let a colliding task id from another session replace the current run", () => {
    applySdkSubagentBridge(started({ run_id: "run-001" }), SID)
    applySdkSubagentBridge(started({ run_id: "run-002" }), "other-chat")
    expect(node("T1")!.context?.sessionId).toBe(SID)
  })

  it("settles a stopped task notification as cancelled and removes cancellation", () => {
    applySdkSubagentBridge(started(), SID, { stopTask: jest.fn() })
    applySdkSubagentBridge(
      { ...started(), subtype: "task_notification", status: "stopped" } as never,
      SID
    )
    expect(node("T1")!.status).toBe("cancelled")
    expect(requestCancelSubagentRun("T1")).toBe(false)
  })

  it("starts a fresh run on resume and ignores late lifecycle events from the older run", () => {
    applySdkSubagentBridge(started({ run_id: "run-001" }), SID)
    applySdkSubagentBridge(
      {
        ...started({ run_id: "run-001" }),
        subtype: "task_updated",
        patch: { status: "completed" },
      } as never,
      SID
    )
    applySdkSubagentBridge(started({ run_id: "run-002" }), SID)
    expect(node("T1")!.status).toBe("running")
    applySdkSubagentBridge(
      {
        ...started({ run_id: "run-001" }),
        subtype: "task_updated",
        patch: { status: "failed" },
      } as never,
      SID
    )
    expect(node("T1")!.status).toBe("running")
    applySdkSubagentBridge(
      {
        ...started({ run_id: "run-002" }),
        subtype: "task_notification",
        status: "completed",
      } as never,
      SID
    )
    expect(node("T1")!.status).toBe("completed")
  })

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

  it("registers SDK-native tasks with the existing cancellation entry point", async () => {
    const stopTask = jest.fn().mockResolvedValue(undefined)
    applySdkSubagentBridge(started(), SID, { stopTask })

    expect(requestCancelSubagentRun("T1", "stop")).toBe(true)
    await Promise.resolve()
    expect(stopTask).toHaveBeenCalledWith("T1")
  })

  it("unregisters SDK-native cancellation when the task settles", () => {
    applySdkSubagentBridge(started(), SID, { stopTask: jest.fn() })
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

    expect(requestCancelSubagentRun("T1")).toBe(false)
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

  it("logs the last tool and bumps tool-use count on task_progress (gap9)", () => {
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
    expect(n.toolUses).toBe(3) // honest raw count
    expect(n.progress).toBe(0) // gap9: pseudo-percentage no longer set (seed only)
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

  it("leaves a running subagent unchanged on a non-terminal task_updated", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      {
        type: "system",
        subtype: "task_updated",
        task_id: "T1",
        patch: { status: "running" },
        uuid: "u",
        session_id: "sdk",
      } as never,
      SID
    )
    expect(node("T1")!.status).toBe("running")
  })

  it("falls back to description for the task when prompt is absent", () => {
    applySdkSubagentBridge(started({ prompt: undefined }), SID)
    expect(node("T1")!.task).toBe("Research X")
  })

  it("task_progress without last_tool_name/usage is a no-op on logs and progress", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      {
        type: "system",
        subtype: "task_progress",
        task_id: "T1",
        description: "d",
        uuid: "u",
        session_id: "sdk",
      } as never,
      SID
    )
    const n = node("T1")!
    expect(n.logs).toHaveLength(0)
    expect(n.progress).toBe(0)
  })
})

describe("applySdkSubagentBridge — rich logs via parent_tool_use_id", () => {
  it("drops a late child frame correlated with an older run after resume", () => {
    applySdkSubagentBridge(started({ run_id: "run-001" }), SID)
    applySdkSubagentBridge(started({ run_id: "run-002", tool_use_id: "tu-resumed" }), SID)
    applySdkSubagentBridge(
      {
        type: "assistant",
        agent_id: "T1",
        parent_tool_use_id: "tu1",
        uuid: "late",
        session_id: "sdk",
        message: {
          id: "late",
          role: "assistant",
          content: [{ type: "text", text: "stale output" }],
        },
      } as never,
      SID
    )
    expect(node("T1")!.logs).toHaveLength(0)
  })

  it("routes child frames by their authoritative agent_id without a parent tool pointer", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      {
        type: "assistant",
        agent_id: "T1",
        parent_tool_use_id: null,
        uuid: "u",
        session_id: "sdk",
        message: { id: "m", role: "assistant", content: [{ type: "text", text: "direct child" }] },
      } as never,
      SID
    )
    expect(node("T1")!.logs.some((l) => l.message === "direct child")).toBe(true)
  })

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

  it("projects tool_use → tool_result into the node's toolCalls (running → error)", () => {
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
          content: [{ type: "tool_use", id: "call-1", name: "Grep", input: { q: "z" } }],
        },
      } as never,
      SID
    )
    let n = node("T1")!
    expect(n.toolCalls).toHaveLength(1)
    expect(n.toolCalls![0]).toMatchObject({ name: "Grep", state: "running" })

    applySdkSubagentBridge(
      {
        type: "user",
        parent_tool_use_id: "tu1",
        uuid: "u",
        session_id: "sdk",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "out", is_error: true }],
        },
      } as never,
      SID
    )
    n = node("T1")!
    expect(n.toolCalls).toHaveLength(1)
    expect(n.toolCalls![0]).toMatchObject({ name: "Grep", state: "error", isError: true })
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

describe("applySdkSubagentBridge — nested task correlation", () => {
  it("uses parent_task_id when no spawning tool frame was forwarded", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      started({ task_id: "T2", tool_use_id: undefined, parent_task_id: "T1" }),
      SID
    )
    expect(node("T2")!.parentSubagentId).toBe("T1")
    expect(node("T2")!.depth).toBe(2)
  })

  it("treats an unknown explicit parent as a root instead of inferring another parent", () => {
    applySdkSubagentBridge(started(), SID)
    spawnBlockInsideT1("nested")
    applySdkSubagentBridge(
      started({ task_id: "T2", tool_use_id: "nested", parent_task_id: "unknown" }),
      SID
    )
    expect(node("T2")!.parentSubagentId).toBeUndefined()
  })

  /** Stream T1's child frame containing a spawning `tool_use` block. */
  function spawnBlockInsideT1(blockId: string) {
    applySdkSubagentBridge(
      {
        type: "assistant",
        parent_tool_use_id: "tu1",
        uuid: "u",
        session_id: "sdk",
        message: {
          id: "m",
          role: "assistant",
          content: [{ type: "tool_use", id: blockId, name: "Task", input: { prompt: "deeper" } }],
        },
      } as never,
      SID
    )
  }

  it("hangs a nested task off the task whose child frame contained its spawning tool_use", () => {
    applySdkSubagentBridge(started(), SID) // T1, depth 1
    spawnBlockInsideT1("tu-nested")
    applySdkSubagentBridge(
      started({ task_id: "T2", tool_use_id: "tu-nested", subagent_type: "helper" }),
      SID
    )
    const child = node("T2")!
    expect(child.depth).toBe(2)
    expect(child.parentSubagentId).toBe("T1")
    expect(child.parentAgentId).toBe("T1")
    expect(child.context?.sessionId).toBe(SID)
    // The parent stays a depth-1 chat-session child.
    expect(node("T1")!.depth).toBe(1)
  })

  it("chains depth for a grandchild (nested task spawning its own task)", () => {
    applySdkSubagentBridge(started(), SID) // T1
    spawnBlockInsideT1("tu-nested")
    applySdkSubagentBridge(
      started({ task_id: "T2", tool_use_id: "tu-nested", subagent_type: "helper" }),
      SID
    )
    // T2's forwarded child frame carries ITS spawning block for T3.
    applySdkSubagentBridge(
      {
        type: "assistant",
        parent_tool_use_id: "tu-nested",
        uuid: "u",
        session_id: "sdk",
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-grand", name: "Task", input: {} }],
        },
      } as never,
      SID
    )
    applySdkSubagentBridge(
      started({ task_id: "T3", tool_use_id: "tu-grand", subagent_type: "digger" }),
      SID
    )
    const grand = node("T3")!
    expect(grand.depth).toBe(3)
    expect(grand.parentSubagentId).toBe("T2")
  })

  it("keeps a task at depth 1 when its spawning tool_use was never seen inside a task", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      started({ task_id: "T2", tool_use_id: "tu-top-level", subagent_type: "helper" }),
      SID
    )
    const sibling = node("T2")!
    expect(sibling.depth).toBe(1)
    expect(sibling.parentSubagentId).toBeUndefined()
    expect(sibling.parentAgentId).toBe(SID)
  })

  it("keeps a task at depth 1 when task_started carries no tool_use_id at all", () => {
    applySdkSubagentBridge(started(), SID)
    spawnBlockInsideT1("tu-nested")
    applySdkSubagentBridge(
      started({ task_id: "T2", tool_use_id: undefined, subagent_type: "helper" }),
      SID
    )
    expect(node("T2")!.depth).toBe(1)
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

  it("swallows a throw raised while inspecting the event", () => {
    const hostile = {
      get type(): string {
        throw new Error("boom")
      },
    }
    expect(() => applySdkSubagentBridge(hostile as never, SID)).not.toThrow()
  })

  it("ignores a forwarded child frame whose content is not an array", () => {
    applySdkSubagentBridge(started(), SID)
    applySdkSubagentBridge(
      {
        type: "user",
        parent_tool_use_id: "tu1",
        uuid: "u",
        session_id: "sdk",
        message: { role: "user", content: "plain string" },
      } as never,
      SID
    )
    expect(node("T1")!.logs).toHaveLength(0)
  })
})
