jest.mock("@/lib/data/import-registry", () => ({
  applyImported: jest.fn(async () => ({ sessions: 1, messages: 3 })),
}))
jest.mock("@/lib/memory/external/home", () => ({ resolveHome: jest.fn(async () => "/home/u") }))

import { applyImported } from "@/lib/data/import-registry"
import {
  __resetDynamicSessionSourcesForTesting,
  importSessions,
  listAllSessions,
  listSessionsForSource,
  parseSessions,
  registerSessionSource,
  resolveScanInput,
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
    expect(counts).toEqual({ sessions: 1, messages: 3 })
  })

  it("skips refs whose source is unknown", async () => {
    const parsed = await parseSessions(
      [{ sourceId: "ghost", originalSessionId: "x", locator: "x" }],
      input
    )
    expect(parsed).toEqual([])
  })
})
