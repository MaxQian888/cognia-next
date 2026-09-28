import { cursorSessionSource } from "./cursor"
import { clineSessionSource } from "./cline"
import { copilotCliSessionSource } from "./copilot-cli"
import { qwenCodeSessionSource } from "./qwen-code"

const mockStoreCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  transport: { call: (...args: unknown[]) => mockStoreCall(...args) },
}))

import {
  createPortableAgentSessionSource,
  parsePortableAgentArtifact,
  type PortableSourceConfig,
} from "./portable-agent-source"

const config: PortableSourceConfig = {
  id: "test-agent",
  displayName: "Test Agent",
  verifiedVersion: "1.0.0",
  acceptedExtensions: [".json", ".jsonl", ".md"],
  roots: () => [],
  pathHints: ["/.test-agent/"],
  defaultTitle: "Test session",
  markdown: true,
}

const fs = {
  exists: async () => false,
  readDir: async () => [],
  stat: async () => ({ size: 0, isFile: true }),
  readTextFile: async () => "",
}

describe("portable external-agent artifacts", () => {
  it("preserves tools, lineage, lifecycle, tasks, checkpoints, history, and diagnostics", async () => {
    const content = JSON.stringify({
      sessionId: "child",
      parentSessionId: "root",
      kind: "subagent",
      status: "failed",
      background: true,
      cwd: "/work",
      messages: [
        { id: "u1", role: "user", content: "fix it" },
        {
          id: "a1",
          role: "assistant",
          content: "working",
          toolCalls: [{ id: "call-1", name: "shell", input: { command: "pwd" } }],
        },
        { type: "tool_result", callId: "call-1", output: "ok" },
        { type: "checkpoint", id: "cp-1", turnId: "a1" },
        { type: "rewind", id: "rw-1", summary: "rewound" },
        {
          type: "background_job",
          id: "task-1",
          status: "running",
          dependencies: ["task-0"],
        },
        { type: "future_event", apiKey: "secret", detail: "kept" },
      ],
    })
    const parsed = parsePortableAgentArtifact(config, content, "/tmp/child.json")
    expect(parsed[0]).toMatchObject({
      originalSessionId: "child",
      parentNativeSessionId: "root",
      relationKind: "background",
      lifecycle: { status: "failed", background: true },
    })
    const tool = parsed[0].messages[1].parts[1] as Record<string, unknown>
    expect(tool).toMatchObject({ type: "tool-shell", state: "output-available", output: "ok" })

    const source = createPortableAgentSessionSource(config)
    const input = {
      fs,
      home: "",
      pickedFiles: [
        {
          name: "root.json",
          path: "/tmp/root.json",
          content: JSON.stringify({
            sessionId: "root",
            messages: [{ role: "user", content: "root prompt" }],
          }),
        },
        { name: "child.json", path: "/tmp/child.json", content },
      ],
    }
    const list = await source.listSessions(input)
    expect(list).toHaveLength(1)
    const graph = await source.parseGraph!(list[0].ref, input)
    expect(graph.nodes).toHaveLength(2)
    const child = graph.nodes.find((node) => node.conversation.session.id.endsWith(":child"))!
    expect(child.session.tasks?.[0]).toMatchObject({
      taskId: "task-1",
      background: true,
      dependencies: ["task-0"],
    })
    expect(child.session.checkpoints?.[0].checkpointId).toBe("cp-1")
    expect(child.session.history?.[0].kind).toBe("rewind")
    expect(JSON.stringify(child.session.recordedEvents)).not.toContain("secret")
    expect(child.loss.losses).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "events.future_event" })])
    )
  })

  it("marks Markdown exports as lossy instead of inventing structured events", async () => {
    const source = createPortableAgentSessionSource(config)
    const input = {
      fs,
      home: "",
      pickedFiles: [
        {
          name: "chat.md",
          path: "/tmp/chat.md",
          content: "## User\nhello\n\n## Assistant\nworld",
        },
      ],
    }
    const list = await source.listSessions(input)
    const graph = await source.parseGraph!(list[0].ref, input)
    expect(graph.nodes[0].session.turns).toHaveLength(2)
    expect(graph.nodes[0].loss.losses).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "markdown", kind: "summarized" })])
    )
  })

  it("keeps valid JSONL records and reports a truncated tail", () => {
    const parsed = parsePortableAgentArtifact(
      config,
      '{"role":"user","content":"kept"}\n{"role":"assistant"',
      "/tmp/session/events.jsonl"
    )
    expect(parsed[0].originalSessionId).toBe("session")
    expect(parsed[0].messages).toHaveLength(1)
    expect(parsed[0].losses).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "jsonl", kind: "dropped" })])
    )
  })

  it("merges manifest and message artifacts from one legacy task directory", async () => {
    const source = createPortableAgentSessionSource(config)
    const input = {
      fs,
      home: "",
      pickedFiles: [
        {
          name: "manifest.json",
          path: "/tmp/task-42/manifest.json",
          content: JSON.stringify({ title: "Task 42", status: "completed", cwd: "/repo" }),
        },
        {
          name: "messages.json",
          path: "/tmp/task-42/messages.json",
          content: JSON.stringify([{ id: "u1", role: "user", content: "hello" }]),
        },
      ],
    }
    const list = await source.listSessions(input)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      title: "Task 42",
      messageCount: 1,
      cwd: "/repo",
      lifecycleStatus: "completed",
    })
  })

  it("keeps locator-stable message ids when several artifacts omit upstream ids", async () => {
    const source = createPortableAgentSessionSource(config)
    const input = {
      fs,
      home: "",
      pickedFiles: [
        {
          name: "messages.json",
          path: "/tmp/task-42/messages.json",
          content: JSON.stringify([{ role: "user", content: "first artifact" }]),
        },
        {
          name: "events.json",
          path: "/tmp/task-42/events.json",
          content: JSON.stringify([{ role: "assistant", content: "second artifact" }]),
        },
      ],
    }

    const list = await source.listSessions(input)
    expect(list).toHaveLength(1)
    const graph = await source.parseGraph!(list[0].ref, input)
    const messages = graph.nodes[0].conversation.messages
    expect(messages).toHaveLength(2)
    expect(new Set(messages.map((message) => message.id)).size).toBe(2)
  })
  it.each([
    cursorSessionSource,
    clineSessionSource,
    copilotCliSessionSource,
    qwenCodeSessionSource,
  ])("uses the shared portable export path for $id without losing child state", async (source) => {
    const input = {
      fs,
      home: "",
      pickedFiles: [
        {
          name: "sessions.json",
          path: "/tmp/sessions.json",
          content: JSON.stringify({
            sessions: [
              {
                sessionId: "root",
                createdAt: 1,
                messages: [{ id: "root-message", role: "user", content: "root" }],
              },
              {
                sessionId: "child",
                parentSessionId: "root",
                kind: "branch",
                status: "interrupted",
                createdAt: 2,
                messages: [
                  { id: "child-message", role: "assistant", content: "child" },
                  { type: "checkpoint", id: "saved" },
                  { type: "rollback", id: "restore", summary: "rollback recorded" },
                  { type: "background_job", id: "job", dependencies: ["prior"], status: "failed" },
                  { type: "future", apiKey: "must-not-escape", detail: "kept" },
                ],
              },
            ],
          }),
        },
      ],
    }
    const listed = await source.listSessions(input)
    expect(listed).toHaveLength(1)
    const graph = await source.parseGraph!(listed[0].ref, input)
    expect(graph.nodes.map((node) => node.session.header.runtimeBinding?.nativeSessionId)).toEqual([
      "root",
      "child",
    ])
    const child = graph.nodes[1]
    expect(child.session.header.lineage?.kind).toBe("branch")
    expect(child.session.header.lifecycle?.status).toBe("interrupted")
    expect(child.session.checkpoints?.[0].checkpointId).toBe("saved")
    expect(child.session.history?.[0].kind).toBe("rollback")
    expect(child.session.tasks?.[0]).toMatchObject({
      taskId: "job",
      dependencies: ["prior"],
      status: "failed",
    })
    expect(JSON.stringify(child.session.recordedEvents)).not.toContain("must-not-escape")
    expect(child.loss.losses.some((loss) => loss.path === "events.future")).toBe(true)
  })

  it("shares one read and merged index across concurrent refs while a fresh input sees changes", async () => {
    let content = JSON.stringify({
      sessions: [
        { sessionId: "root", createdAt: 1, messages: [{ role: "user", content: "original" }] },
        { sessionId: "second", createdAt: 2, messages: [{ role: "user", content: "second" }] },
        {
          sessionId: "child",
          parentSessionId: "root",
          createdAt: 3,
          messages: [{ role: "assistant", content: "child" }],
        },
      ],
    })
    const readTextFile = jest.fn(async () => content)
    const input = {
      home: "",
      fs: {
        ...fs,
        readDirEntries: async () => [{ name: "sessions.json", isFile: true }],
        readTextFile,
      },
    }
    const source = createPortableAgentSessionSource({ ...config, roots: () => ["/fixture"] })
    const [first, duplicate] = await Promise.all([
      source.listSessions(input),
      source.listSessions(input),
    ])
    expect(first).toEqual(duplicate)
    await Promise.all(first.map((summary) => source.parseGraph!(summary.ref, input)))
    await source.parseSession(first[0].ref, input)
    expect(readTextFile).toHaveBeenCalledTimes(1)

    content = JSON.stringify({
      sessionId: "root",
      createdAt: 1,
      messages: [{ role: "user", content: "updated" }],
    })
    const freshInput = { ...input }
    const updated = await source.listSessions(freshInput)
    expect(updated).toHaveLength(1)
    expect(updated[0].title).toBe("updated")
    const graph = await source.parseGraph!(updated[0].ref, freshInput)
    expect(graph.nodes).toHaveLength(1)
    expect(readTextFile).toHaveBeenCalledTimes(2)
  })

  it("evicts a failed native store pass so the same input retries successfully", async () => {
    mockStoreCall.mockReset()
    mockStoreCall.mockRejectedValueOnce(new Error("database locked"))
    mockStoreCall.mockResolvedValueOnce([
      {
        sessionId: "retried",
        createdAt: 1,
        messages: [{ role: "user", content: "retry succeeded" }],
      },
    ])
    const source = createPortableAgentSessionSource({ ...config, storeSource: "cursor" })
    const input = { fs, home: "/fixture" }
    await expect(source.listSessions(input)).rejects.toThrow("database locked")
    const listed = await source.listSessions(input)
    expect(listed[0].ref.originalSessionId).toBe("retried")
    const graph = await source.parseGraph!(listed[0].ref, input)
    expect(graph.nodes[0].conversation.messages[0].parts).toEqual([
      { type: "text", text: "retry succeeded", state: "done" },
    ])
    expect(mockStoreCall).toHaveBeenCalledTimes(2)
  })

  it("preserves child source order, terminates cycles, and keeps the missing-ref fallback", async () => {
    const source = createPortableAgentSessionSource(config)
    const input = {
      fs,
      home: "",
      pickedFiles: [
        {
          name: "sessions.json",
          path: "/tmp/sessions.json",
          content: JSON.stringify({
            sessions: [
              { sessionId: "root", createdAt: 1, messages: [{ role: "user", content: "root" }] },
              {
                sessionId: "z-child",
                parentSessionId: "root",
                createdAt: 1,
                messages: [{ role: "assistant", content: "first" }],
              },
              {
                sessionId: "a-child",
                parentSessionId: "root",
                createdAt: 1,
                messages: [{ role: "assistant", content: "second" }],
              },
              {
                sessionId: "cycle-a",
                parentSessionId: "cycle-b",
                createdAt: 1,
                messages: [{ role: "user", content: "a" }],
              },
              {
                sessionId: "cycle-b",
                parentSessionId: "cycle-a",
                createdAt: 1,
                messages: [{ role: "assistant", content: "b" }],
              },
            ],
          }),
        },
      ],
    }
    const root = await source.parseSession(
      { sourceId: config.id, originalSessionId: "root", locator: "root" },
      input
    )
    expect(
      root.nested?.map((child) => child.session.importRuntimeBinding?.nativeSessionId)
    ).toEqual(["z-child", "a-child"])
    const cycle = await source.parseSession(
      { sourceId: config.id, originalSessionId: "cycle-a", locator: "cycle-a" },
      input
    )
    expect(cycle.nested?.[0].nested?.[0].session.importRuntimeBinding?.nativeSessionId).toBe(
      "cycle-a"
    )
    expect(cycle.nested?.[0].nested?.[0].nested).toBeUndefined()
    const missing = await source.parseGraph!(
      { sourceId: config.id, originalSessionId: "missing", locator: "missing" },
      input
    )
    expect(missing.nodes).toHaveLength(1)
    expect(missing.nodes[0].conversation.messages).toEqual([])
    expect(missing.nodes[0].conversation.session.importRuntimeBinding?.nativeSessionId).toBe(
      "missing"
    )
  })
})
