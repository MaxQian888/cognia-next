import {
  openEncryptedReplayFixture,
  recordSession,
  refreshFixture,
  sealReplayFixture,
} from "./fixture-maintenance"
import type { ReplayFixtureV1 } from "@/lib/ai/replay/fixture"

const fixture: ReplayFixtureV1 = {
  scenario: {
    schemaVersion: 1,
    scenarioId: "private-recording",
    title: "Private recording",
    level: "runtime",
    platform: "headless",
    actors: [{ actorRef: "root", role: "root" }],
    inputSteps: [{ kind: "prompt", actorRef: "root", text: "private prompt" }],
    permissionScript: [],
    expectations: { assertConsumed: true, fidelity: "full" },
  },
  tapes: [
    {
      schemaVersion: 1,
      tapeId: "tape-1",
      match: {
        actorRef: "root",
        purpose: "turn",
        requestDigest: `sha256:${"a".repeat(64)}`,
      },
      behavior: { kind: "stream", chunksRef: "chunks-1" },
      synthetic: false,
    },
  ],
  assets: { "chunks-1": ["private model output"] },
}

describe("encrypted replay fixtures", () => {
  it("keeps a real recording encrypted at rest and round-trips with its password", async () => {
    const bundle = await sealReplayFixture(fixture, "strong replay password")
    const serialized = JSON.stringify(bundle)

    expect(bundle.schema).toBe("cognia-replay-fixture-bundle/v1")
    expect(serialized).not.toContain("private prompt")
    expect(serialized).not.toContain("private model output")
    await expect(openEncryptedReplayFixture(bundle, "strong replay password")).resolves.toEqual(
      fixture
    )
  })

  it("refuses the wrong password", async () => {
    const bundle = await sealReplayFixture(fixture, "correct replay password")
    await expect(openEncryptedReplayFixture(bundle, "wrong replay password")).rejects.toThrow()
  })
})

describe("fixture maintenance", () => {
  it("renumbers tapes, drops orphaned assets, and preserves manual-review warnings", () => {
    const result = refreshFixture({
      ...fixture,
      tapes: [
        {
          ...fixture.tapes[0],
          tapeId: "old-tape-id",
        },
      ],
      assets: { ...fixture.assets, orphaned: ["unused"] },
    })

    expect(result.fixture.tapes[0].tapeId).toBe("tape-1")
    expect(result.fixture.assets).toEqual({ "chunks-1": ["private model output"] })
    expect(result.changes).toEqual(
      expect.arrayContaining([
        'dropped unreferenced asset "orphaned"',
        "renumbered old-tape-id to tape-1",
      ])
    )
    expect(result.warnings.join("\n")).toContain("real recordings")
  })

  it("starts and stops the recording proxy around the capture callback", async () => {
    const recorded = await recordSession({
      scenario: fixture.scenario,
      waitForCompletion: async (proxy) => {
        expect(proxy.port).toBeGreaterThan(0)
        expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
      },
    })

    expect(recorded).toEqual({
      scenario: fixture.scenario,
      tapes: [],
      assets: {},
      actors: [],
    })
  })
})
