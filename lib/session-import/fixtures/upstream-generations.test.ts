import { getSessionSources } from "../registry"
import { readFileSync } from "node:fs"
import path from "node:path"
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
      expect(fixtures.find((fixture) => fixture.generation === "current")?.verifiedAt).toBe(
        source.verifiedAt
      )
      for (const fixture of fixtures) {
        expect(fixture.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(new Date(fixture.verifiedAt).toISOString().slice(0, 10)).toBe(fixture.verifiedAt)
      }
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
      const artifact =
        fixture.sourceId === "copilot-cli" && fixture.generation === "current"
          ? {
              name: "events.jsonl",
              path: "/fixtures/.copilot/session-state/copilot-1.0.103-acceptance/events.jsonl",
              content: readFileSync(
                path.join(
                  process.cwd(),
                  "lib/session-import/fixtures/copilot-1.0.103-events.jsonl"
                ),
                "utf8"
              ),
            }
          : fixture.sourceId === "gemini-cli" && fixture.generation === "current"
            ? {
                name: "session.jsonl",
                path: "/fixtures/.gemini/tmp/project/chats/gemini-0.61.0-session.jsonl",
                content: readFileSync(
                  path.join(
                    process.cwd(),
                    "lib/session-import/fixtures/gemini-0.61.0-session.jsonl"
                  ),
                  "utf8"
                ),
              }
            : executableGenerationArtifact(fixture)
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
