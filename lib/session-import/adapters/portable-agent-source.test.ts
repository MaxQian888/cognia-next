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
})
