/** @jest-environment jsdom */
import {
  ARTIFACT_TOOL_NAMES,
  CANVAS_TOOL_NAMES,
  READ_CONTENT_MAX_CHARS,
  buildArtifactManifestEntries,
  buildCanvasManifestEntries,
  isArtifactBuiltinTool,
  runArtifactBuiltinTool,
  type ArtifactToolDeps,
} from "./artifact-builtin-tools"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSettingsStore } from "@/stores/settings"

const mockReveal = jest.fn()
jest.mock("@/lib/artifacts/reveal", () => ({
  revealCanvasDocument: (...a: unknown[]) => mockReveal(...a),
  revealArtifactInWorkspace: jest.fn(),
}))

function deps(): ArtifactToolDeps {
  return { store: useArtifactStore.getState(), activeSessionId: "s1" }
}

const ctx = { sessionId: "s1", messageId: "m1" }

function setReviewBeforeApply(value: boolean) {
  useSettingsStore.setState({
    settings: {
      ...(useSettingsStore.getState().settings ?? {}),
      artifacts: { reviewBeforeApply: value },
    },
  } as never)
}

beforeEach(() => {
  useArtifactStore.setState({
    artifacts: {},
    artifactVersions: {},
    canvasDocuments: {},
    activeCanvasId: null,
    pendingReviews: {},
    openArtifactIdsBySession: {},
    activeArtifactIdBySession: {},
  })
  mockReveal.mockReset()
  setReviewBeforeApply(false)
})

describe("tool surface", () => {
  it("recognises every shipped name and nothing else", () => {
    for (const name of [...ARTIFACT_TOOL_NAMES, ...CANVAS_TOOL_NAMES]) {
      expect(isArtifactBuiltinTool(name)).toBe(true)
    }
    // Retired from the declared union: `artifact_search` folded into
    // `artifact_read`'s optional `query`; `artifact_render` had nothing to ask
    // for; `artifact_export` would be a model-initiated write to the user's
    // disk for a button already on screen.
    for (const name of ["artifact_search", "artifact_render", "artifact_export", "nope"]) {
      expect(isArtifactBuiltinTool(name)).toBe(false)
    }
  })

  it("declares a manifest entry per tool, each with a closed schema", () => {
    const entries = [...buildArtifactManifestEntries(), ...buildCanvasManifestEntries()]
    expect(entries.map((e) => e.name).sort()).toEqual(
      [...ARTIFACT_TOOL_NAMES, ...CANVAS_TOOL_NAMES].sort()
    )
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.jsonSchema.additionalProperties).toBe(false)
      expect(entry.pluginId).toBe("cognia-artifact-builtin")
    }
  })
})

describe("artifact_create", () => {
  it("returns the id the HOST minted, not one the model supplied", async () => {
    // A `tool_use` block is seen before the row exists, which is why the part
    // is emitted from this result rather than from the model's input.
    const result = (await runArtifactBuiltinTool(
      "artifact_create",
      { type: "chart", title: "Q4", content: '{"type":"bar"}', chartType: "bar" },
      deps(),
      ctx
    )) as { ok: boolean; artifactId: string }

    expect(result.ok).toBe(true)
    expect(result.artifactId).toBeTruthy()
    const row = useArtifactStore.getState().getArtifact(result.artifactId)
    expect(row?.title).toBe("Q4")
    expect(row?.metadata?.chartType).toBe("bar")
    expect(row?.metadata?.sourceOrigin).toBe("tool")
    expect(row?.metadata?.userInitiated).toBe(false)
  })

  it("rejects an unknown artifact type instead of coercing it", async () => {
    const result = (await runArtifactBuiltinTool(
      "artifact_create",
      { type: "spreadsheet", title: "x", content: "y" },
      deps(),
      ctx
    )) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" })
  })

  it("rejects a call missing required fields", async () => {
    const result = (await runArtifactBuiltinTool(
      "artifact_create",
      { title: "no type or content" },
      deps(),
      ctx
    )) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" })
  })
})

describe("artifact_update", () => {
  async function seed() {
    const created = (await runArtifactBuiltinTool(
      "artifact_create",
      { type: "document", title: "Doc", content: "v1" },
      deps(),
      ctx
    )) as { artifactId: string }
    return created.artifactId
  }

  it("stages a diff when the user has review-before-apply on", async () => {
    // An agent-authored edit must not be the one way to bypass the user's own
    // setting — the heuristic revision path already honours it.
    setReviewBeforeApply(true)
    const id = await seed()
    const result = (await runArtifactBuiltinTool(
      "artifact_update",
      { artifactId: id, content: "v2" },
      deps(),
      ctx
    )) as { ok: boolean; staged: string }

    expect(result).toMatchObject({ ok: true, staged: "review" })
    expect(useArtifactStore.getState().getArtifact(id)?.content).toBe("v1")
    expect(useArtifactStore.getState().getPendingReview(id)).not.toBeNull()
  })

  it("applies directly when the user turned review off, keeping a version", async () => {
    const id = await seed()
    const result = (await runArtifactBuiltinTool(
      "artifact_update",
      { artifactId: id, content: "v2", changeDescription: "tighten" },
      deps(),
      ctx
    )) as { ok: boolean; staged: string }

    expect(result).toMatchObject({ ok: true, staged: "applied" })
    expect(useArtifactStore.getState().getArtifact(id)?.content).toBe("v2")
    expect(useArtifactStore.getState().getArtifactVersions(id).length).toBeGreaterThan(0)
  })

  it("reports not_found rather than creating a row", async () => {
    const result = (await runArtifactBuiltinTool(
      "artifact_update",
      { artifactId: "ghost", content: "x" },
      deps(),
      ctx
    )) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: "not_found" })
    expect(Object.keys(useArtifactStore.getState().artifacts)).toHaveLength(0)
  })
})

describe("artifact_read", () => {
  it("caps a large body and says it did", async () => {
    // An unbounded read is both a context-window problem and more text for the
    // caller's PII gate to scan.
    const created = (await runArtifactBuiltinTool(
      "artifact_create",
      { type: "code", title: "Big", content: "x".repeat(READ_CONTENT_MAX_CHARS + 500) },
      deps(),
      ctx
    )) as { artifactId: string }

    const result = (await runArtifactBuiltinTool(
      "artifact_read",
      { artifactId: created.artifactId },
      deps(),
      ctx
    )) as { content: string; truncated: boolean; contentLength: number }

    expect(result.content).toHaveLength(READ_CONTENT_MAX_CHARS)
    expect(result.truncated).toBe(true)
    expect(result.contentLength).toBe(READ_CONTENT_MAX_CHARS + 500)
  })

  it("lists titles without bodies when no id is given", async () => {
    await runArtifactBuiltinTool(
      "artifact_create",
      { type: "document", title: "Alpha", content: "a" },
      deps(),
      ctx
    )
    const result = (await runArtifactBuiltinTool("artifact_read", {}, deps(), ctx)) as {
      artifacts: { title: string; content?: string }[]
    }
    expect(result.artifacts.map((a) => a.title)).toContain("Alpha")
    expect(result.artifacts[0]).not.toHaveProperty("content")
  })

  it("filters the listing by query", async () => {
    for (const title of ["Alpha", "Beta"]) {
      await runArtifactBuiltinTool(
        "artifact_create",
        { type: "document", title, content: "x" },
        deps(),
        ctx
      )
    }
    const result = (await runArtifactBuiltinTool(
      "artifact_read",
      { query: "bet" },
      deps(),
      ctx
    )) as { artifacts: { title: string }[] }
    expect(result.artifacts.map((a) => a.title)).toEqual(["Beta"])
  })
})

describe("artifact_delete", () => {
  it("removes the row", async () => {
    const created = (await runArtifactBuiltinTool(
      "artifact_create",
      { type: "document", title: "Doomed", content: "x" },
      deps(),
      ctx
    )) as { artifactId: string }
    const result = (await runArtifactBuiltinTool(
      "artifact_delete",
      { artifactId: created.artifactId },
      deps(),
      ctx
    )) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(useArtifactStore.getState().getArtifact(created.artifactId)).toBeUndefined()
  })

  it("reports not_found for an unknown id", async () => {
    const result = (await runArtifactBuiltinTool(
      "artifact_delete",
      { artifactId: "ghost" },
      deps(),
      ctx
    )) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: "not_found" })
  })
})

describe("canvas tools", () => {
  async function seedDoc() {
    const created = (await runArtifactBuiltinTool(
      "canvas_create",
      { title: "Draft", content: "v1", language: "markdown", type: "text" },
      deps(),
      ctx
    )) as { ok: boolean; documentId: string }
    return created.documentId
  }

  it("creates a document and reports its id and title", async () => {
    const id = await seedDoc()
    expect(useArtifactStore.getState().canvasDocuments[id]?.title).toBe("Draft")
  })

  it("stages a canvas rewrite for review by default", async () => {
    setReviewBeforeApply(true)
    const id = await seedDoc()
    const result = (await runArtifactBuiltinTool(
      "canvas_update",
      { documentId: id, content: "v2" },
      deps(),
      ctx
    )) as { staged: string }
    expect(result.staged).toBe("review")
    expect(useArtifactStore.getState().canvasDocuments[id]?.content).toBe("v1")
  })

  it("reads a document, capped like an artifact", async () => {
    const id = await seedDoc()
    const result = (await runArtifactBuiltinTool(
      "canvas_read",
      { documentId: id },
      deps(),
      ctx
    )) as { content: string; truncated: boolean }
    expect(result.content).toBe("v1")
    expect(result.truncated).toBe(false)
  })

  it("opens a document through the shared reveal seam", async () => {
    const id = await seedDoc()
    mockReveal.mockReturnValue(useArtifactStore.getState().canvasDocuments[id])
    const result = (await runArtifactBuiltinTool(
      "canvas_open",
      { documentId: id },
      deps(),
      ctx
    )) as { ok: boolean; opened: boolean }
    expect(mockReveal).toHaveBeenCalledWith(id)
    expect(result).toMatchObject({ ok: true, opened: true })
  })

  it("reports not_found when the document cannot be revealed", async () => {
    mockReveal.mockReturnValue(null)
    const result = (await runArtifactBuiltinTool(
      "canvas_open",
      { documentId: "ghost" },
      deps(),
      ctx
    )) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: "not_found" })
  })
})

describe("failure contract", () => {
  it("never throws — a rejection would reach the model as an opaque transport error", async () => {
    const broken = {
      store: {
        createArtifact: () => {
          throw new Error("store exploded")
        },
      },
      activeSessionId: null,
    } as unknown as ArtifactToolDeps

    const result = (await runArtifactBuiltinTool(
      "artifact_create",
      { type: "document", title: "x", content: "y" },
      broken,
      ctx
    )) as { ok: boolean; code: string; error: string }
    expect(result).toMatchObject({ ok: false, code: "tool_failed" })
    expect(result.error).toContain("store exploded")
  })

  it("rejects an unknown tool name", async () => {
    const result = (await runArtifactBuiltinTool("artifact_teleport", {}, deps(), ctx)) as {
      ok: boolean
    }
    expect(result.ok).toBe(false)
  })
})
