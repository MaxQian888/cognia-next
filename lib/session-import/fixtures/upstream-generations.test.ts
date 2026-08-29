import { getSessionSources } from "../registry"
import {
  executableGenerationArtifact,
  SESSION_IMPORT_GENERATION_FIXTURES,
} from "./upstream-generations"

describe("session import upstream generation fixtures", () => {
  it("keeps current and previous redacted generations for every registered source", () => {
    for (const source of getSessionSources()) {
      const fixtures = SESSION_IMPORT_GENERATION_FIXTURES.filter(
        (fixture) => fixture.sourceId === source.id
      )
      expect(fixtures.map((fixture) => fixture.generation).sort()).toEqual(["current", "previous"])
      expect(fixtures.find((fixture) => fixture.generation === "current")?.version).toBe(
        source.verifiedVersion
      )
      expect(fixtures.every((fixture) => fixture.verifiedAt === source.verifiedAt)).toBe(true)
    }
  })

  it("contains no credential-like values", () => {
    const serialized = JSON.stringify(SESSION_IMPORT_GENERATION_FIXTURES)
    expect(serialized).not.toMatch(/sk-[a-z0-9]{12,}|bearer\s+[a-z0-9._-]+/i)
  })

  it.each(SESSION_IMPORT_GENERATION_FIXTURES)(
    "$sourceId parses its $generation executable fixture through the registered adapter",
    async (fixture) => {
      const source = getSessionSources().find((candidate) => candidate.id === fixture.sourceId)!
      const artifact = executableGenerationArtifact(fixture)
      const input = {
        fs: {
          exists: async () => false,
          readDir: async () => [],
          stat: async () => ({ size: artifact.content.length, isFile: true }),
          readTextFile: async () => artifact.content,
        },
        home: "",
        pickedFiles: [artifact],
      }
      const list = await source.listSessions(input)
      expect(list).toHaveLength(1)
      const graph = source.parseGraph ? await source.parseGraph(list[0].ref, input) : undefined
      if (graph) {
        expect(graph.nodes.length).toBeGreaterThan(0)
        expect(graph.nodes[0].conversation.messages.length).toBeGreaterThan(0)
      } else {
        expect((await source.parseSession(list[0].ref, input)).messages.length).toBeGreaterThan(0)
      }
    }
  )
})
