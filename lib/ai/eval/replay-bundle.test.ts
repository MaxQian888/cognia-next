import { createEvalReplayBundle, openEvalReplayBundle } from "./replay-bundle"

describe("encrypted evaluation replay bundle", () => {
  it("round-trips manifest and encrypted artifacts without credentials", async () => {
    const bundle = await createEvalReplayBundle(
      {
        schema: "cognia-eval/v2",
        exportedAt: "2026-07-31T00:00:00.000Z",
        project: { id: "p", name: "P", mode: "model", datasetDigest: "sha256:data" },
        experiment: {
          id: "e",
          status: "completed",
          randomSeed: 7,
          appVersion: "1.0.0",
        },
        variants: [],
        aggregates: [],
      },
      [{ id: "sample-1", kind: "sample", payload: { output: "private" } }],
      "bundle-password"
    )

    expect(bundle.schema).toBe("cognia-eval-bundle/v1")
    expect(JSON.stringify(bundle)).not.toContain("private")
    await expect(openEvalReplayBundle(bundle, "wrong-password")).rejects.toThrow()
    await expect(openEvalReplayBundle(bundle, "bundle-password")).resolves.toMatchObject({
      manifest: { schema: "cognia-eval/v2" },
      artifacts: [{ id: "sample-1", payload: { output: "private" } }],
    })
  })
})
