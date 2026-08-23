import {
  digestComposition,
  digestPrompt,
  digestToolSurface,
  digestValue,
  withCompositionDigest,
} from "./digest"
import type { Sha256Hex, ToolSurfaceEntry } from "./digest"
import { AGENT_COMPOSITION_SCHEMA_VERSION } from "@cognia/agent-config-types/agent-composition"
import type { ResolvedAgentCompositionV1 } from "@cognia/agent-config-types/agent-composition"

const DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/

function undigested(): Omit<ResolvedAgentCompositionV1, "compositionDigest"> {
  return {
    schemaVersion: AGENT_COMPOSITION_SCHEMA_VERSION,
    presetId: "standard",
    presetVersion: "1",
    presetSource: "builtin",
    authority: "default",
    toolPresentation: "native",
    orchestration: "direct",
    engagement: "inline",
    autonomy: "autopilot",
    promptDigest: `sha256:${"a".repeat(64)}`,
    toolDigest: `sha256:${"b".repeat(64)}`,
    warnings: [],
  }
}

describe("digestValue", () => {
  it("produces a sha256-prefixed lowercase hex digest", async () => {
    await expect(digestValue({ a: 1 })).resolves.toMatch(DIGEST_SHAPE)
  })

  it("ignores key order", async () => {
    const first = await digestValue({ a: 1, b: 2 })
    const second = await digestValue({ b: 2, a: 1 })
    expect(second).toBe(first)
  })

  it("distinguishes values", async () => {
    expect(await digestValue({ a: 1 })).not.toBe(await digestValue({ a: 2 }))
  })

  it("distinguishes an absent key from a null one", async () => {
    expect(await digestValue({})).not.toBe(await digestValue({ a: null }))
  })

  it("uses the injected hash when one is given", async () => {
    const hash: Sha256Hex = jest.fn(async () => "0".repeat(64))
    await expect(digestValue({ a: 1 }, hash)).resolves.toBe(`sha256:${"0".repeat(64)}`)
    expect(hash).toHaveBeenCalledWith('{"a":1}')
  })

  it("refuses a value that cannot be canonicalized", async () => {
    // Reusing the Character Pack canonicalizer means non-JSON values fail loudly
    // instead of silently digesting as `{}`.
    await expect(digestValue({ when: new Date(0) })).rejects.toThrow()
  })
})

describe("digestPrompt", () => {
  it("separates different prompts", async () => {
    expect(await digestPrompt("you are helpful")).not.toBe(await digestPrompt("you are terse"))
  })

  it("is stable for the same prompt", async () => {
    expect(await digestPrompt("same")).toBe(await digestPrompt("same"))
  })
})

describe("digestToolSurface", () => {
  const read: ToolSurfaceEntry = {
    name: "Read",
    schema: { type: "object", properties: { path: { type: "string" } } },
    visibility: "native",
  }
  const grep: ToolSurfaceEntry = {
    name: "Grep",
    schema: { type: "object", properties: { pattern: { type: "string" } } },
    visibility: "native",
  }

  it("treats tool order as significant", async () => {
    expect(await digestToolSurface([read, grep])).not.toBe(await digestToolSurface([grep, read]))
  })

  it("separates the same tool offered natively and through the code SDK", async () => {
    expect(await digestToolSurface([read])).not.toBe(
      await digestToolSurface([{ ...read, visibility: "code" }])
    )
  })

  it("does not drop a schema property named like a volatile field", async () => {
    // The execution fingerprint's canonicalizer strips any key called
    // `timestamp` at any depth. If these digests reused it, these two tool
    // surfaces would collide and share a replay tape.
    const withTimestamp: ToolSurfaceEntry = {
      ...read,
      schema: { type: "object", properties: { timestamp: { type: "string" } } },
    }
    const withoutProperties: ToolSurfaceEntry = {
      ...read,
      schema: { type: "object", properties: {} },
    }
    expect(await digestToolSurface([withTimestamp])).not.toBe(
      await digestToolSurface([withoutProperties])
    )
  })

  it("digests an empty tool surface", async () => {
    await expect(digestToolSurface([])).resolves.toMatch(DIGEST_SHAPE)
  })
})

describe("digestComposition", () => {
  it("is blind to how the composition was reached", async () => {
    const migratedComposition: Omit<ResolvedAgentCompositionV1, "compositionDigest"> = {
      ...undigested(),
      legacyModeId: "general",
      executionFingerprint: "aexf1-abc",
      warnings: [{ reason: "unknown-legacy-mode", requested: "nope", applied: "standard" }],
    }
    expect(await digestComposition(migratedComposition)).toBe(await digestComposition(undigested()))
  })

  it("changes when an axis changes", async () => {
    expect(await digestComposition({ ...undigested(), authority: "plan" })).not.toBe(
      await digestComposition(undigested())
    )
  })
})

describe("withCompositionDigest", () => {
  it("stamps a digest without disturbing the resolution", async () => {
    const resolved = await withCompositionDigest(undigested())
    expect(resolved.compositionDigest).toMatch(DIGEST_SHAPE)
    const { compositionDigest: _digest, ...rest } = resolved
    expect(rest).toEqual(undigested())
  })

  it("agrees with digestComposition", async () => {
    const resolved = await withCompositionDigest(undigested())
    expect(resolved.compositionDigest).toBe(await digestComposition(undigested()))
  })
})
