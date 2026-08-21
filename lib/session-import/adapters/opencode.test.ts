import { opencodeSessionSource, opencodeToConversation, parseOpencodeExport } from "./opencode"
import { __setOpencodeReaderForTesting, type OpencodeSession } from "./opencode-db"
import type { SessionScanInput } from "../types"

const SESSION: OpencodeSession = {
  id: "oc-1",
  title: "Refactor module",
  cwd: "/repo",
  model: "claude-x",
  createdAt: 1000,
  updatedAt: 2000,
  messages: [
    { role: "user", createdAt: 1000, parts: [{ type: "text", text: "refactor please" }] },
    {
      role: "assistant",
      createdAt: 1500,
      parts: [
        { type: "reasoning", text: "planning" },
        {
          type: "tool",
          tool: "edit",
          callID: "t1",
          state: { status: "completed", input: { file: "a" }, output: "ok" },
        },
        { type: "step-start" },
      ],
    },
  ],
}

describe("opencodeToConversation", () => {
  it("maps normalized parts to canonical parts and drops structural markers", () => {
    const conv = opencodeToConversation(SESSION)
    expect(conv.session.id).toBe("import:opencode:oc-1")
    expect(conv.session.title).toBe("Refactor module")
    expect(conv.session.workingDir).toBe("/repo")
    expect(conv.messages).toHaveLength(2)
    const asstParts = conv.messages[1].parts as Array<Record<string, unknown>>
    expect(asstParts.map((p) => p.type)).toEqual(["reasoning", "tool-edit"])
    expect(asstParts[1].output).toBe("ok")
  })

  it("maps assistant tokens/cost/model into usage metadata (reasoning folds into output)", () => {
    const conv = opencodeToConversation({
      ...SESSION,
      messages: [
        {
          role: "assistant",
          createdAt: 1500,
          model: "claude-x",
          cost: 0.05,
          tokens: { input: 120, output: 60, reasoning: 40, cacheRead: 300, cacheWrite: 8 },
          parts: [{ type: "text", text: "done" }],
        },
      ],
    })
    const meta = conv.messages[0].metadata as { usage?: Record<string, number>; model?: string }
    expect(meta.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 100,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 8,
      totalCostUsd: 0.05,
    })
    expect(meta.model).toBe("claude-x")
  })

  it("keeps the real MIME type of file parts (OpenCode stores it as `mime`)", () => {
    const conv = opencodeToConversation({
      ...SESSION,
      messages: [
        {
          role: "user",
          createdAt: 1,
          parts: [
            { type: "file", mime: "image/png", url: "data:image/png;base64,AA", filename: "s.png" },
            { type: "file", mediaType: "text/plain", url: "file:///a.txt" },
          ],
        },
      ],
    })
    const parts = conv.messages[0].parts as Array<Record<string, unknown>>
    expect(parts[0].mediaType).toBe("image/png")
    expect(parts[1].mediaType).toBe("text/plain")
  })

  it("surfaces agent/retry/compaction markers instead of dropping them", () => {
    const conv = opencodeToConversation({
      ...SESSION,
      messages: [
        {
          role: "assistant",
          createdAt: 1,
          parts: [
            { type: "agent", name: "reviewer" },
            { type: "retry" },
            { type: "compaction" },
            { type: "unknown-future-type" },
          ],
        },
      ],
    })
    const parts = conv.messages[0].parts as Array<Record<string, unknown>>
    expect(parts.map((p) => p.text)).toEqual([
      "[delegated to agent: reviewer]",
      "[retry]",
      "[context compacted]",
    ])
  })

  it("surfaces patch/snapshot markers (previously dropped) but still drops step markers", () => {
    const conv = opencodeToConversation({
      ...SESSION,
      messages: [
        {
          role: "assistant",
          createdAt: 1,
          parts: [{ type: "patch", text: "a.ts" }, { type: "snapshot" }, { type: "step-finish" }],
        },
      ],
    })
    const parts = conv.messages[0].parts as Array<Record<string, unknown>>
    expect(parts.map((p) => p.text)).toEqual(["[patch applied: a.ts]", "[snapshot]"])
  })

  it("marks an errored tool part", () => {
    const conv = opencodeToConversation({
      ...SESSION,
      messages: [
        {
          role: "assistant",
          createdAt: 1,
          parts: [
            { type: "tool", tool: "bash", callID: "x", state: { status: "error", error: "boom" } },
          ],
        },
      ],
    })
    const tool = conv.messages[0].parts[0] as Record<string, unknown>
    expect(tool.state).toBe("output-error")
    expect(tool.errorText).toBe("boom")
  })
})

describe("parseOpencodeExport", () => {
  it("reconstructs sessions from a flat ShareRecord array", () => {
    const records = [
      {
        key: "session/oc-2",
        content: { id: "oc-2", title: "T", time: { created: 5, updated: 9 }, directory: "/d" },
      },
      {
        key: "message/m1",
        content: { id: "m1", sessionID: "oc-2", role: "user", time: { created: 5 } },
      },
      { key: "part/p1", content: { messageID: "m1", type: "text", text: "hi" } },
    ]
    const sessions = parseOpencodeExport(JSON.stringify(records))
    expect(sessions).toHaveLength(1)
    expect(sessions[0].messages[0].parts[0]).toMatchObject({ type: "text", text: "hi" })
  })

  it("returns [] on invalid json", () => {
    expect(parseOpencodeExport("not json")).toEqual([])
  })

  it("projects tokens/cost/model from a share-export message", () => {
    const records = [
      { key: "session/oc-9", content: { id: "oc-9", title: "T", time: { created: 1 } } },
      {
        key: "message/m9",
        content: {
          id: "m9",
          sessionID: "oc-9",
          role: "assistant",
          modelID: "gpt-x",
          cost: 0.02,
          tokens: { input: 10, output: 5, cache: { read: 20, write: 1 } },
        },
      },
      { key: "part/p9", content: { messageID: "m9", type: "text", text: "hi" } },
    ]
    const sessions = parseOpencodeExport(JSON.stringify(records))
    const msg = sessions[0].messages[0]
    expect(msg.model).toBe("gpt-x")
    expect(msg.cost).toBe(0.02)
    expect(msg.tokens).toMatchObject({ input: 10, output: 5, cacheRead: 20, cacheWrite: 1 })
  })
})

describe("opencodeSessionSource", () => {
  const fs = {
    exists: async () => false,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  }

  afterEach(() => __setOpencodeReaderForTesting(null))

  it("lists via the injected SQLite reader and parses one", async () => {
    __setOpencodeReaderForTesting(async () => [SESSION])
    const input: SessionScanInput = { fs, home: "/home/u" }
    const list = await opencodeSessionSource.listSessions(input)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("Refactor module")
    const conv = await opencodeSessionSource.parseSession(list[0].ref, input)
    expect(conv.messages).toHaveLength(2)
  })

  it("advertises the opencode data dirs as scan roots (feeds the fs-watcher)", () => {
    const roots = opencodeSessionSource.scanRoots("/home/u")
    expect(roots).toContain("/home/u/.local/share/opencode")
    expect(roots).toContain("/home/u/Library/Application Support/opencode")
    expect(roots.some((r) => r.includes("AppData"))).toBe(true)
    expect(opencodeSessionSource.scanRoots("")).toEqual([])
  })

  it("puts the resolved $XDG_DATA_HOME dir first, without dropping the defaults", () => {
    const scanned = opencodeSessionSource.scanRoots("/home/u", {
      claudeConfigDir: "",
      codexHome: "",
      opencodeConfigDir: "",
      opencodeDataDir: "/xdg/data/opencode",
      piAgentDir: "",
      piSessionDir: "",
      geminiDir: "",
      continueDir: "",
    })
    expect(scanned[0]).toBe("/xdg/data/opencode")
    expect(scanned).toContain("/home/u/.local/share/opencode")
    // No home at all still yields the override.
    expect(
      opencodeSessionSource.scanRoots("", {
        claudeConfigDir: "",
        codexHome: "",
        opencodeConfigDir: "",
        opencodeDataDir: "/xdg/data/opencode",
        piAgentDir: "",
        piSessionDir: "",
        geminiDir: "",
        continueDir: "",
      })
    ).toEqual(["/xdg/data/opencode"])
  })

  it("de-dupes a resolved data dir that equals a default", () => {
    const scanned = opencodeSessionSource.scanRoots("/home/u", {
      claudeConfigDir: "",
      codexHome: "",
      opencodeConfigDir: "",
      opencodeDataDir: "/home/u/.local/share/opencode",
      piAgentDir: "",
      piSessionDir: "",
      geminiDir: "",
      continueDir: "",
    })
    expect(scanned.filter((r) => r === "/home/u/.local/share/opencode")).toHaveLength(1)
  })

  it("keeps the platform data fallback alongside an XDG override", () => {
    const scanned = opencodeSessionSource.scanRoots("C:\\Users\\u", {
      claudeConfigDir: "",
      codexHome: "",
      opencodeConfigDir: "",
      opencodeDataDir: "D:\\XDG\\opencode",
      piAgentDir: "",
      piSessionDir: "",
      geminiDir: "",
      continueDir: "",
      opencodePlatformDataDir: "E:\\Profiles\\u\\Roaming\\opencode",
    })
    expect(scanned).toEqual(
      expect.arrayContaining(["D:\\XDG\\opencode", "E:\\Profiles\\u\\Roaming\\opencode"])
    )
  })

  it("reads the DB once per scan input (parse of N sessions is not N reads)", async () => {
    let reads = 0
    __setOpencodeReaderForTesting(async () => {
      reads += 1
      return [SESSION, { ...SESSION, id: "oc-b" }]
    })
    const input: SessionScanInput = { fs, home: "/home/u" }
    const list = await opencodeSessionSource.listSessions(input)
    for (const s of list) await opencodeSessionSource.parseSession(s.ref, input)
    expect(reads).toBe(1)
    // A NEW scan input re-reads (no cross-run staleness).
    await opencodeSessionSource.listSessions({ fs, home: "/home/u" })
    expect(reads).toBe(2)
  })

  it("propagates a DB read failure instead of reporting an empty history", async () => {
    // `scanAllSources` was built to collect per-source failures — its comment
    // names OpenCode's DB as the example — but the reader swallowed the error
    // and returned [], so a locked or corrupt database was indistinguishable
    // from "you have no OpenCode sessions".
    __setOpencodeReaderForTesting(async () => {
      throw new Error("database is locked")
    })
    await expect(opencodeSessionSource.listSessions({ fs, home: "/home/u" })).rejects.toThrow(
      "database is locked"
    )
  })

  it("a failed read is not cached, so the next scan retries", async () => {
    let attempt = 0
    __setOpencodeReaderForTesting(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("database is locked")
      return [SESSION]
    })
    const input: SessionScanInput = { fs, home: "/home/u" }
    await expect(opencodeSessionSource.listSessions(input)).rejects.toThrow()
    // Same input object: a rejected promise left in the per-input cache would
    // poison every later read of this scan.
    await expect(opencodeSessionSource.listSessions(input)).resolves.toHaveLength(1)
  })

  it("nests child (subagent) sessions under their parent and hides them from the list", async () => {
    const child: OpencodeSession = {
      ...SESSION,
      id: "oc-child",
      title: "Subagent run",
      parentId: "oc-1",
      messages: [{ role: "user", createdAt: 1, parts: [{ type: "text", text: "sub task" }] }],
    }
    __setOpencodeReaderForTesting(async () => [SESSION, child])
    const input: SessionScanInput = { fs, home: "/home/u" }
    const list = await opencodeSessionSource.listSessions(input)
    expect(list.map((s) => s.ref.originalSessionId)).toEqual(["oc-1"])
    const conv = await opencodeSessionSource.parseSession(list[0].ref, input)
    expect(conv.nested).toHaveLength(1)
    expect(conv.nested?.[0].session.id).toBe("import:opencode:oc-child")
  })

  it("imports the full descendant tree and lists only its root", async () => {
    const child: OpencodeSession = {
      ...SESSION,
      id: "oc-child",
      parentId: "oc-1",
    }
    const grandchild: OpencodeSession = {
      ...SESSION,
      id: "oc-grandchild",
      parentId: "oc-child",
    }
    __setOpencodeReaderForTesting(async () => [SESSION, child, grandchild])
    const input: SessionScanInput = { fs, home: "/home/u" }

    const list = await opencodeSessionSource.listSessions(input)
    const conv = await opencodeSessionSource.parseSession(list[0].ref, input)

    expect(list.map((s) => s.ref.originalSessionId)).toEqual(["oc-1"])
    expect(conv.nested?.map((nested) => nested.session.id)).toEqual([
      "import:opencode:oc-child",
      "import:opencode:oc-grandchild",
    ])
  })

  it("uses the newest child timestamp for the parent summary", async () => {
    const parent = { ...SESSION, updatedAt: 100 }
    const child: OpencodeSession = {
      ...SESSION,
      id: "oc-child",
      parentId: "oc-1",
      updatedAt: 200,
    }
    __setOpencodeReaderForTesting(async () => [parent, child])

    const list = await opencodeSessionSource.listSessions({ fs, home: "/home/u" })

    expect(list).toHaveLength(1)
    expect(list[0].updatedAt).toBe(200)
  })

  it("changes the parent watch revision when child content changes", async () => {
    let childText = "first"
    __setOpencodeReaderForTesting(async () => [
      SESSION,
      {
        ...SESSION,
        id: "oc-child",
        parentId: "oc-1",
        messages: [
          { role: "assistant", createdAt: 10, parts: [{ type: "text", text: childText }] },
        ],
      },
    ])
    const first = await opencodeSessionSource.listSessions({ fs, home: "/home/u" })
    childText = "second"
    const second = await opencodeSessionSource.listSessions({ fs, home: "/home/u" })

    expect(first[0].watchRevision).toBeDefined()
    expect(second[0].watchRevision).not.toBe(first[0].watchRevision)
  })

  it("still lists an orphaned child whose parent is missing from the store", async () => {
    const orphan: OpencodeSession = {
      ...SESSION,
      id: "oc-orphan",
      parentId: "oc-gone",
    }
    __setOpencodeReaderForTesting(async () => [orphan])
    const list = await opencodeSessionSource.listSessions({ fs, home: "/home/u" })
    expect(list.map((s) => s.ref.originalSessionId)).toEqual(["oc-orphan"])
  })

  it("lists from a picked export file", async () => {
    const records = [
      {
        key: "session/oc-3",
        content: { id: "oc-3", title: "Z", time: { created: 1, updated: 2 } },
      },
      { key: "message/m", content: { id: "m", sessionID: "oc-3", role: "user" } },
      { key: "part/p", content: { messageID: "m", type: "text", text: "yo" } },
    ]
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [
        { name: "export.json", path: "/p/export.json", content: JSON.stringify(records) },
      ],
    }
    const list = await opencodeSessionSource.listSessions(input)
    expect(list[0].ref.originalSessionId).toBe("oc-3")
  })
})
