/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun, listExecutionRunEvents } from "@/lib/db/execution-runs"
import {
  finishDirectChatExecutionRun,
  projectDirectChatCaptureEvent,
  projectDirectChatSdkMessage,
  recoverStaleDirectChatExecutionRuns,
  startDirectChatExecutionRun,
} from "./direct-chat-run"

describe("direct chat execution run", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("creates one canonical run and journals tool lifecycle through the existing producer", async () => {
    const input = {
      sessionId: "session-1",
      runId: "run:session-1:1",
      projectId: "project-1",
      workspaceRoot: "/workspace",
      startedAt: 1_000,
    }

    await startDirectChatExecutionRun(input)
    await startDirectChatExecutionRun(input)
    await projectDirectChatCaptureEvent("session-1", {
      type: "tool-call",
      id: "tool-1",
      toolName: "Read",
      input: { file_path: "/workspace/src/index.ts" },
    })
    await projectDirectChatCaptureEvent("session-1", {
      type: "tool-result",
      id: "tool-1",
      toolName: "Read",
      result: "private file content must not be journaled",
    })
    await finishDirectChatExecutionRun("session-1", "completed", 2_000)

    const run = await getDb().executionRuns.get(input.runId)
    expect(run).toMatchObject({
      id: input.runId,
      kind: "agent-turn",
      sourceId: input.runId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      title: "Chat run",
      status: "completed",
    })
    const events = await listExecutionRunEvents(input.runId)
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "step.added",
      "step.started",
      "tool.started",
      "tool.completed",
      "step.completed",
      "run.completed",
    ])
    expect(JSON.stringify(events)).not.toContain("private file content")
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(1)
  })

  it("marks stale non-terminal direct chat runs as recovery required", async () => {
    await createExecutionRun({
      id: "run:stale",
      kind: "agent-turn",
      sourceId: "run:stale",
      sessionId: "session-stale",
      title: "Chat run",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await createExecutionRun({
      id: "run:done",
      kind: "agent-turn",
      sourceId: "run:done",
      sessionId: "session-done",
      title: "Chat run",
      status: "completed",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
    })

    await expect(recoverStaleDirectChatExecutionRuns(5_000)).resolves.toBe(1)
    await expect(getDb().executionRuns.get("run:stale")).resolves.toMatchObject({
      status: "recovery_required",
    })
    await expect(getDb().executionRuns.get("run:done")).resolves.toMatchObject({
      status: "completed",
    })
  })

  it("projects SDK tool snapshots once and records compaction without content", async () => {
    await startDirectChatExecutionRun({
      sessionId: "session-sdk",
      runId: "run:session-sdk:1",
      startedAt: 1,
    })
    const assistant = {
      type: "assistant" as const,
      message: {
        id: "message-1",
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "tool-sdk", name: "Bash", input: { command: "pwd" } },
        ],
      },
      parent_tool_use_id: null,
      uuid: "message-1",
      session_id: "sdk-1",
    }
    await projectDirectChatSdkMessage("session-sdk", assistant, 2)
    await projectDirectChatSdkMessage("session-sdk", assistant, 3)
    await projectDirectChatSdkMessage(
      "session-sdk",
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-sdk",
              content: "secret output",
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "message-2",
        session_id: "sdk-1",
      },
      4
    )
    await projectDirectChatSdkMessage(
      "session-sdk",
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 100, post_tokens: 20 },
        uuid: "compact-1",
        session_id: "sdk-1",
      },
      5
    )

    const events = await listExecutionRunEvents("run:session-sdk:1")
    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1)
    expect(events.some((event) => event.type === "milestone.created")).toBe(true)
    expect(JSON.stringify(events)).not.toContain("secret output")
  })
})
