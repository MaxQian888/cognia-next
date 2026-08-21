jest.mock("@/lib/data/import-registry", () => ({
  applyImported: jest.fn(async () => ({ sessions: 1, messages: 3 })),
}))
jest.mock("@/lib/memory/external/home", () => ({
  resolveHome: jest.fn(async () => "/home/u"),
  detectPlatform: jest.fn(() => "linux"),
}))

import { applyImported } from "@/lib/data/import-registry"
import {
  __resetDynamicSessionSourcesForTesting,
  importSessions,
  listAllSessions,
  listSessionsForSource,
  parseSessions,
  registerSessionSource,
  resolveScanInput,
  scanAllSources,
} from "./index"
import type { AgentSessionSourceAdapter, SessionScanInput } from "./types"

const applyImportedMock = applyImported as jest.MockedFunction<typeof applyImported>

const fs = {
  exists: async () => false,
  readDir: async () => [],
  stat: async () => ({ size: 0, isFile: true }),
  readTextFile: async () => "",
}
const input: SessionScanInput = { fs, home: "" }

function source(id: string, summaries: number): AgentSessionSourceAdapter {
  return {
    id,
    displayName: id,
    labelKey: id,
    acceptedExtensions: [],
    scanRoots: () => [],
    detect: () => "no",
    listSessions: async () =>
      Array.from({ length: summaries }, (_, i) => ({
        ref: { sourceId: id, originalSessionId: `${id}-${i}`, locator: `${id}-${i}` },
        title: `${id} ${i}`,
        sourceId: id,
        messageCount: 2,
        updatedAt: i,
      })),
    parseSession: async (ref) => ({
      session: { id: ref.originalSessionId, title: "t", createdAt: 0, updatedAt: 0 } as never,
      messages: [
        {
          id: "m",
          sessionId: ref.originalSessionId,
          role: "user",
          parts: [],
          createdAt: 0,
        } as never,
      ],
    }),
  }
}

afterEach(() => {
  __resetDynamicSessionSourcesForTesting()
  applyImportedMock.mockClear()
})

describe("session-import runner", () => {
  it("resolves the scan input with real home when not overridden", async () => {
    const resolved = await resolveScanInput({ fs })
    expect(resolved.home).toBe("/home/u")
    // The vendor roots come along so adapters honour $CODEX_HOME & friends.
    expect(resolved.roots?.codexHome).toBe("/home/u/.codex")
  })

  it("keeps explicitly passed vendor roots", async () => {
    const roots = {
      claudeConfigDir: "/relocated/claude",
      codexHome: "/relocated/codex",
      opencodeConfigDir: "",
      opencodeDataDir: "",
      piAgentDir: "",
      piSessionDir: "",
      geminiDir: "",
      continueDir: "",
    }
    const resolved = await resolveScanInput({ fs, roots })
    expect(resolved.roots).toBe(roots)
  })

  it("lists sessions for a single source and across all sources", async () => {
    registerSessionSource(source("plug", 2), { pluginId: "p" })
    expect(await listSessionsForSource("p:plug", input)).toHaveLength(2)
    const all = await listAllSessions(input)
    // built-ins return [] with empty home; plugin returns 2.
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it("parses refs, stamps projectId, and persists via applyImported", async () => {
    registerSessionSource(source("plug", 1), { pluginId: "p" })
    const refs = [{ sourceId: "p:plug", originalSessionId: "x", locator: "x" }]
    const parsed = await parseSessions(refs, input, "proj-9")
    expect(parsed[0].session.projectId).toBe("proj-9")
    expect(parsed[0].messages[0].projectId).toBe("proj-9")

    const counts = await importSessions(refs, input, "proj-9")
    expect(applyImportedMock).toHaveBeenCalledTimes(1)
    expect(counts).toEqual({ sessions: 1, messages: 3, lossBySource: {} })
  })

  it("scanAllSources collects per-source failures instead of swallowing them", async () => {
    const good = source("good", 1)
    const bad: AgentSessionSourceAdapter = {
      ...source("bad", 0),
      id: "bad",
      listSessions: async () => {
        throw new Error("db locked")
      },
    }
    registerSessionSource(good, { pluginId: "p" })
    registerSessionSource(bad, { pluginId: "p" })
    const { summaries, errors } = await scanAllSources(input)
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    expect(errors).toContainEqual({ sourceId: "p:bad", message: "db locked" })
  })

  it("skips refs whose source is unknown", async () => {
    const parsed = await parseSessions(
      [{ sourceId: "ghost", originalSessionId: "x", locator: "x" }],
      input
    )
    expect(parsed).toEqual([])
  })

  it("reports only refs that parsed successfully", async () => {
    const ok = source("ok", 0)
    const bad: AgentSessionSourceAdapter = {
      ...source("bad", 0),
      parseSession: async () => {
        throw new Error("corrupt transcript")
      },
    }
    registerSessionSource(ok, { pluginId: "p" })
    registerSessionSource(bad, { pluginId: "p" })
    const parsedRefs: string[] = []

    await importSessions(
      [
        { sourceId: "p:ok", originalSessionId: "ok", locator: "ok" },
        { sourceId: "p:bad", originalSessionId: "bad", locator: "bad" },
      ],
      input,
      undefined,
      { onRefParsed: (ref) => parsedRefs.push(ref.originalSessionId) }
    )

    expect(parsedRefs).toEqual(["ok"])
  })

  it("flattens nested subagent conversations and stamps their projectId", async () => {
    const nesting: AgentSessionSourceAdapter = {
      ...source("nest", 1),
      id: "nest",
      parseSession: async (ref) => ({
        session: { id: ref.originalSessionId, title: "main", createdAt: 0, updatedAt: 0 } as never,
        messages: [
          {
            id: "m0",
            sessionId: ref.originalSessionId,
            role: "user",
            parts: [],
            createdAt: 0,
          } as never,
        ],
        nested: [
          {
            session: {
              id: `${ref.originalSessionId}:sub:a`,
              title: "sub",
              kind: "subagent",
              createdAt: 0,
              updatedAt: 0,
            } as never,
            messages: [
              {
                id: "n0",
                sessionId: `${ref.originalSessionId}:sub:a`,
                role: "user",
                parts: [],
                createdAt: 0,
              } as never,
            ],
          },
        ],
      }),
    }
    registerSessionSource(nesting, { pluginId: "p" })
    const refs = [{ sourceId: "p:nest", originalSessionId: "x", locator: "x" }]
    const parsed = await parseSessions(refs, input, "proj-Z")
    // Main + the nested subagent transcript are both top-level, both stamped.
    expect(parsed).toHaveLength(2)
    expect(parsed[1].session.id).toBe("x:sub:a")
    expect(parsed[1].session.projectId).toBe("proj-Z")
    expect(parsed[1].messages[0].projectId).toBe("proj-Z")
  })

  const manyRefs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sourceId: "p:plug",
      originalSessionId: `x${i}`,
      locator: `x${i}`,
    }))

  it("flushes in chunks instead of one giant transaction", async () => {
    registerSessionSource(source("plug", 0), { pluginId: "p" })
    const counts = await importSessions(manyRefs(5), input, undefined, { chunkSize: 2 })
    // 5 refs @ chunk 2 → flushes at 2, 4, and final 5 = 3 writes.
    expect(applyImportedMock).toHaveBeenCalledTimes(3)
    expect(counts).toEqual({ sessions: 3, messages: 9, lossBySource: {} }) // 3 × mock {1,3}
  })

  it("reports parsing then writing progress", async () => {
    registerSessionSource(source("plug", 0), { pluginId: "p" })
    const ticks: Array<{ phase: string; done: number; total: number }> = []
    await importSessions(manyRefs(3), input, undefined, {
      chunkSize: 2,
      onProgress: (p) => ticks.push({ ...p }),
    })
    expect(ticks.filter((t) => t.phase === "parsing").map((t) => t.done)).toEqual([1, 2, 3])
    expect(ticks.at(-1)).toEqual({ phase: "writing", done: 3, total: 3 })
  })

  it("stops on abort but keeps work already parsed", async () => {
    registerSessionSource(source("plug", 0), { pluginId: "p" })
    const controller = new AbortController()
    let seen = 0
    const counts = await importSessions(manyRefs(10), input, undefined, {
      chunkSize: 100, // no mid-loop flush; only the final flush persists the buffer
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "parsing") {
          seen = p.done
          if (p.done === 3) controller.abort()
        }
      },
    })
    expect(seen).toBe(3) // parsing halted after the 3rd ref
    // The 3 buffered conversations are still flushed once on the way out.
    expect(applyImportedMock).toHaveBeenCalledTimes(1)
    expect(counts).toEqual({ sessions: 1, messages: 3, lossBySource: {} })
  })

  it("projects canonical headers + per-source loss for codec-declaring sources (ADR-0090 P8)", async () => {
    const putHeader = jest.fn()
    jest.doMock("@/lib/db/agent-canonical-sessions", () => ({
      putCanonicalSessionHeader: (...a: unknown[]) => putHeader(...a),
      headerRowFromCanonical: jest.requireActual("@/lib/db/agent-canonical-sessions")
        .headerRowFromCanonical,
    }))
    const { conversationToCanonical } = jest.requireActual("./codec-types")
    const withCodec: AgentSessionSourceAdapter = {
      ...source("codecful", 1),
      codec: {
        importFidelity: "structured",
        toCanonical: (conversation: never) =>
          conversationToCanonical(conversation, {
            sourceRuntime: "codecful",
            importFidelity: "structured",
          }),
      } as never,
    }
    registerSessionSource(withCodec)
    const counts = await importSessions(
      [{ sourceId: "codecful", originalSessionId: "codecful-0", locator: "codecful-0" }],
      input
    )
    expect(counts.lossBySource.codecful).toMatchObject({ fidelity: "structured" })
    expect(putHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalSessionId: "canon:codecful:codecful-0",
        sourceRuntime: "codecful",
        importFidelity: "structured",
      })
    )
  })

  it("persists nothing when aborted before the first ref", async () => {
    registerSessionSource(source("plug", 0), { pluginId: "p" })
    const controller = new AbortController()
    controller.abort()
    const counts = await importSessions(manyRefs(4), input, undefined, {
      signal: controller.signal,
    })
    expect(applyImportedMock).not.toHaveBeenCalled()
    expect(counts).toEqual({ sessions: 0, messages: 0, lossBySource: {} })
  })

  describe("provenance stamping", () => {
    it("stamps the source id and display name onto every parsed conversation", async () => {
      const adapter = source("acme", 1)
      adapter.displayName = "Cursor (Acme)"
      registerSessionSource(adapter, { pluginId: "acme" })

      const [conv] = await parseSessions(
        [{ sourceId: "acme:acme", originalSessionId: "s", locator: "s" }],
        input
      )
      // The session id encodes the source, but a plugin id may itself contain a
      // colon — `import:acme:acme:s` cannot be split back apart, so the fields
      // are what let the UI name the origin.
      expect(conv.session.importSource).toBe("acme:acme")
      expect(conv.session.importSourceLabel).toBe("Cursor (Acme)")
    })

    it("stamps nested subagent transcripts with the same origin", async () => {
      const adapter = source("nested-src", 1)
      adapter.parseSession = async () => ({
        session: { id: "root", title: "t", createdAt: 0, updatedAt: 0 } as never,
        messages: [{ id: "m", sessionId: "root", role: "user", parts: [], createdAt: 0 } as never],
        nested: [
          {
            session: { id: "child", title: "c", createdAt: 0, updatedAt: 0 } as never,
            messages: [
              { id: "m2", sessionId: "child", role: "user", parts: [], createdAt: 0 } as never,
            ],
          },
        ],
      })
      registerSessionSource(adapter)

      const convs = await parseSessions(
        [{ sourceId: "nested-src", originalSessionId: "root", locator: "root" }],
        input
      )
      expect(convs.map((c) => c.session.importSource)).toEqual(["nested-src", "nested-src"])
    })
  })
})
