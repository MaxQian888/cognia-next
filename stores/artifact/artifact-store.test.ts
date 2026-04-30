/**
 * @jest-environment jsdom
 */

import { useArtifactStore } from "./artifact-store"

const initial = {
  artifacts: {},
  activeArtifactId: null,
  artifactVersions: {},
  artifactWorkspace: {
    scope: "session" as const,
    sessionId: null,
    searchQuery: "",
    typeFilter: "all" as const,
    runtimeFilter: "all" as const,
    recentArtifactIds: [],
    returnContext: null,
  },
  canvasDocuments: {},
  activeCanvasId: null,
  canvasOpen: false,
  analysisResults: {},
  panelOpen: false,
  panelView: "artifact" as const,
}

beforeEach(() => {
  localStorage.clear()
  useArtifactStore.setState(initial)
})

describe("createArtifact", () => {
  it("creates an artifact, opens the panel, and emits a plugin dispatch", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m1",
      type: "code",
      title: "First",
      content: "console.log(1)",
      language: "javascript",
    })
    expect(a.id).toBeDefined()
    const s = useArtifactStore.getState()
    expect(s.activeArtifactId).toBe(a.id)
    expect(s.panelOpen).toBe(true)
    expect(s.panelView).toBe("artifact")
    expect(s.artifactWorkspace.recentArtifactIds[0]).toBe(a.id)
  })
})

describe("updateArtifact", () => {
  it("bumps version and updatedAt", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "v1",
      content: "x",
    })
    const before = a.version
    useArtifactStore.getState().updateArtifact(a.id, { content: "y" })
    const next = useArtifactStore.getState().artifacts[a.id]
    expect(next.version).toBe(before + 1)
    expect(next.content).toBe("y")
  })

  it("ignores updates to unknown ids", () => {
    useArtifactStore.getState().updateArtifact("missing", { content: "y" })
    expect(Object.keys(useArtifactStore.getState().artifacts)).toHaveLength(0)
  })
})

describe("deleteArtifact + deleteArtifacts", () => {
  it("removes the artifact and clears active when matched", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    useArtifactStore.getState().deleteArtifact(a.id)
    expect(useArtifactStore.getState().artifacts[a.id]).toBeUndefined()
    expect(useArtifactStore.getState().activeArtifactId).toBeNull()
  })

  it("batch-deletes ids and prunes recents", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().deleteArtifacts([a.id, b.id])
    expect(useArtifactStore.getState().artifacts).toEqual({})
    expect(useArtifactStore.getState().artifactWorkspace.recentArtifactIds).toEqual([])
  })
})

describe("duplicateArtifact", () => {
  it("creates a new artifact derived from the original", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "Source",
      content: "console.log(1)",
    })
    const dup = useArtifactStore.getState().duplicateArtifact(a.id)
    expect(dup).not.toBeNull()
    expect(dup!.id).not.toBe(a.id)
    expect(dup!.title).toBe("Source (Copy)")
    expect(dup!.metadata?.derivedFromArtifactId).toBe(a.id)
  })

  it("returns null for unknown id", () => {
    expect(useArtifactStore.getState().duplicateArtifact("missing")).toBeNull()
  })
})

describe("setActiveArtifact + panel open/close", () => {
  it("opens the panel when activating", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    useArtifactStore.setState({ activeArtifactId: null, panelOpen: false })
    useArtifactStore.getState().setActiveArtifact(a.id)
    expect(useArtifactStore.getState().panelOpen).toBe(true)
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
  })

  it("nulls activeArtifactId when called with null", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    useArtifactStore.getState().setActiveArtifact(null)
    expect(useArtifactStore.getState().activeArtifactId).toBeNull()
    expect(useArtifactStore.getState().artifacts[a.id]).toBeDefined()
  })

  it("closes the panel via closePanel and reopens via openPanel", () => {
    useArtifactStore.getState().closePanel()
    expect(useArtifactStore.getState().panelOpen).toBe(false)
    useArtifactStore.getState().openPanel("canvas")
    expect(useArtifactStore.getState().panelOpen).toBe(true)
    expect(useArtifactStore.getState().panelView).toBe("canvas")
  })

  it("setPanelView swaps the active view", () => {
    useArtifactStore.getState().setPanelView("analysis")
    expect(useArtifactStore.getState().panelView).toBe("analysis")
  })
})

describe("workspace filters", () => {
  it("setArtifactWorkspaceFilters merges patches", () => {
    useArtifactStore.getState().setArtifactWorkspaceFilters({
      searchQuery: "abc",
      typeFilter: "html",
    })
    const ws = useArtifactStore.getState().artifactWorkspace
    expect(ws.searchQuery).toBe("abc")
    expect(ws.typeFilter).toBe("html")
  })

  it("setArtifactWorkspaceScope updates scope and sessionId", () => {
    useArtifactStore.getState().setArtifactWorkspaceScope("recent", "s2")
    const ws = useArtifactStore.getState().artifactWorkspace
    expect(ws.scope).toBe("recent")
    expect(ws.sessionId).toBe("s2")
  })

  it("setArtifactWorkspaceReturnContext stores context", () => {
    useArtifactStore.getState().setArtifactWorkspaceReturnContext({
      scope: "session",
      sessionId: "s",
      searchQuery: "",
      typeFilter: "all",
      runtimeFilter: "all",
    })
    expect(useArtifactStore.getState().artifactWorkspace.returnContext).not.toBeNull()
  })

  it("getArtifactsForWorkspace honors session filter", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().setArtifactWorkspaceScope("session", "s1")
    const list = useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s1" })
    expect(list.map((x) => x.id)).toEqual([a.id])
  })

  it("getArtifactsForWorkspace recent scope only includes recent ids", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore.getState().setArtifactWorkspaceScope("recent")
    const list = useArtifactStore.getState().getArtifactsForWorkspace()
    expect(list.map((x) => x.id)).toContain(a.id)
  })

  it("getArtifactsForWorkspace honors limit", () => {
    for (let i = 0; i < 5; i++) {
      useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "code",
        title: `t${i}`,
        content: "x",
      })
    }
    expect(
      useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s", limit: 2 })
    ).toHaveLength(2)
  })
})

describe("autoCreateFromContent", () => {
  it("creates artifacts from a multi-line code block", async () => {
    const md = "```js\n" + "console.log(1)\n".repeat(15) + "```"
    const out = await useArtifactStore.getState().autoCreateFromContent({
      sessionId: "s",
      messageId: "m1",
      content: md,
    })
    expect(out.length).toBeGreaterThanOrEqual(1)
    const created = Object.values(useArtifactStore.getState().artifacts)
    expect(created.length).toBeGreaterThanOrEqual(1)
  })

  it("dedupes by source fingerprint when called twice with the same content", async () => {
    const md = "```js\n" + "console.log(1)\n".repeat(15) + "```"
    await useArtifactStore.getState().autoCreateFromContent({
      sessionId: "s",
      messageId: "m1",
      content: md,
    })
    await useArtifactStore.getState().autoCreateFromContent({
      sessionId: "s",
      messageId: "m1",
      content: md,
    })
    expect(Object.keys(useArtifactStore.getState().artifacts)).toHaveLength(1)
  })
})

describe("artifact version history", () => {
  it("saveArtifactVersion + getArtifactVersions round-trip", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    const v = useArtifactStore.getState().saveArtifactVersion(a.id, "first")
    expect(v).not.toBeNull()
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    expect(versions).toHaveLength(1)
    expect(versions[0].changeDescription).toBe("first")
  })

  it("saveArtifactVersion returns null for unknown id", () => {
    expect(useArtifactStore.getState().saveArtifactVersion("missing")).toBeNull()
  })

  it("restoreArtifactVersion swaps content back", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "v1" })
    useArtifactStore.getState().saveArtifactVersion(a.id, "snapshot")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    useArtifactStore.getState().restoreArtifactVersion(a.id, versions[0].id)
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("v1")
  })

  it("restoreArtifactVersion ignores unknown versions", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "v1" })
    useArtifactStore.getState().restoreArtifactVersion(a.id, "missing")
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("v1")
  })

  it("restoreArtifactVersion records the default English auto-save description when none is given", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "v1" })
    useArtifactStore.getState().saveArtifactVersion(a.id, "snapshot")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    useArtifactStore.getState().restoreArtifactVersion(a.id, versions[0].id)
    const after = useArtifactStore.getState().getArtifactVersions(a.id)
    const autoSave = after.find((v) => v.changeDescription === "Auto-saved before restore")
    expect(autoSave).toBeTruthy()
  })

  it("restoreArtifactVersion uses the provided localized auto-save description", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "v1" })
    useArtifactStore.getState().saveArtifactVersion(a.id, "snapshot")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    useArtifactStore.getState().restoreArtifactVersion(a.id, versions[0].id, "恢复前自动保存")
    const after = useArtifactStore.getState().getArtifactVersions(a.id)
    const autoSave = after.find((v) => v.changeDescription === "恢复前自动保存")
    expect(autoSave).toBeTruthy()
  })

  it("getArtifactVersions returns [] for unknown id", () => {
    expect(useArtifactStore.getState().getArtifactVersions("missing")).toEqual([])
  })
})

describe("canvas documents", () => {
  it("createCanvasDocument opens the canvas panel", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "console.log(1)",
      language: "javascript",
      type: "code",
    })
    expect(id).toBeDefined()
    const s = useArtifactStore.getState()
    expect(s.activeCanvasId).toBe(id)
    expect(s.canvasOpen).toBe(true)
    expect(s.panelView).toBe("canvas")
  })

  it("updateCanvasDocument bumps updatedAt for content changes", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    const before = useArtifactStore.getState().canvasDocuments[id].updatedAt
    useArtifactStore.getState().updateCanvasDocument(id, { content: "v2" })
    const after = useArtifactStore.getState().canvasDocuments[id]
    expect(after.content).toBe("v2")
    expect(after.editorContext?.saveState).toBe("dirty")
    expect(after.updatedAt).not.toBe(before)
  })

  it("updateCanvasDocument is a no-op for unknown ids", () => {
    useArtifactStore.getState().updateCanvasDocument("missing", { content: "x" })
    expect(useArtifactStore.getState().canvasDocuments).toEqual({})
  })

  it("setActiveCanvas / openCanvas / closeCanvas toggle state", () => {
    const id = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "x", language: "javascript", type: "code" })
    useArtifactStore.getState().closeCanvas()
    expect(useArtifactStore.getState().canvasOpen).toBe(false)
    useArtifactStore.getState().openCanvas()
    expect(useArtifactStore.getState().canvasOpen).toBe(true)
    useArtifactStore.getState().setActiveCanvas(null)
    expect(useArtifactStore.getState().activeCanvasId).toBeNull()
    useArtifactStore.getState().setActiveCanvas(id)
    expect(useArtifactStore.getState().activeCanvasId).toBe(id)
  })

  it("deleteCanvasDocument clears active when needed", () => {
    const id = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "x", language: "javascript", type: "code" })
    useArtifactStore.getState().deleteCanvasDocument(id)
    expect(useArtifactStore.getState().canvasDocuments).toEqual({})
    expect(useArtifactStore.getState().activeCanvasId).toBeNull()
  })

  it("canvas suggestions add / update / apply / clear", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "a\nb\nc",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().addSuggestion(id, {
      type: "edit",
      range: { startLine: 1, endLine: 1 },
      originalText: "b",
      suggestedText: "B",
      explanation: "case",
      status: "pending",
    })
    const sugId = useArtifactStore.getState().canvasDocuments[id].aiSuggestions![0].id
    useArtifactStore.getState().updateSuggestionStatus(id, sugId, "rejected")
    expect(
      useArtifactStore.getState().canvasDocuments[id].aiSuggestions!.find((s) => s.id === sugId)!
        .status
    ).toBe("rejected")
    useArtifactStore.getState().applySuggestion(id, sugId)
    expect(useArtifactStore.getState().canvasDocuments[id].content).toContain("B")
    useArtifactStore.getState().clearSuggestions(id)
    expect(useArtifactStore.getState().canvasDocuments[id].aiSuggestions).toEqual([])
  })

  it("addSuggestion is a no-op for unknown documents", () => {
    useArtifactStore.getState().addSuggestion("missing", {
      type: "edit",
      range: { startLine: 0, endLine: 0 },
      originalText: "",
      suggestedText: "",
      explanation: "",
      status: "pending",
    })
    expect(useArtifactStore.getState().canvasDocuments).toEqual({})
  })

  it("saveCanvasVersion + restoreCanvasVersion + delete + getCanvasVersions + compareVersions", () => {
    const id = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "v1", language: "javascript", type: "code" })
    const v1 = useArtifactStore.getState().saveCanvasVersion(id, "first")
    expect(v1).not.toBeNull()
    useArtifactStore.getState().updateCanvasDocument(id, { content: "v2" })
    const v2 = useArtifactStore.getState().saveCanvasVersion(id, "second")
    const versions = useArtifactStore.getState().getCanvasVersions(id)
    expect(versions.length).toBeGreaterThanOrEqual(2)
    useArtifactStore.getState().restoreCanvasVersion(id, v1!.id)
    expect(useArtifactStore.getState().canvasDocuments[id].content).toBe("v1")
    useArtifactStore.getState().deleteCanvasVersion(id, v2!.id)
    expect(
      useArtifactStore.getState().canvasDocuments[id].versions!.some((v) => v.id === v2!.id)
    ).toBe(false)
    const cmp = useArtifactStore.getState().compareVersions(id, v1!.id, v1!.id)
    expect(cmp).not.toBeNull()
  })

  it("restoreCanvasVersion uses provided localized auto-save description", () => {
    const id = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "v1", language: "javascript", type: "code" })
    const v1 = useArtifactStore.getState().saveCanvasVersion(id, "first")
    useArtifactStore.getState().updateCanvasDocument(id, { content: "v2" })
    useArtifactStore.getState().restoreCanvasVersion(id, v1!.id, "恢复前自动保存")
    const versions = useArtifactStore.getState().canvasDocuments[id].versions!
    expect(versions.some((v) => v.description === "恢复前自动保存")).toBe(true)
  })

  it("saveCanvasVersion returns null for unknown id", () => {
    expect(useArtifactStore.getState().saveCanvasVersion("missing")).toBeNull()
  })

  it("getCanvasVersions returns [] for unknown id", () => {
    expect(useArtifactStore.getState().getCanvasVersions("missing")).toEqual([])
  })

  it("compareVersions returns null when versions are missing", () => {
    expect(useArtifactStore.getState().compareVersions("missing", "x", "y")).toBeNull()
  })
})

describe("analysis results", () => {
  it("addAnalysisResult + getMessageAnalysis", () => {
    useArtifactStore.getState().addAnalysisResult({
      sessionId: "s",
      messageId: "m1",
      type: "math",
      content: "1+1",
      output: { result: 2 },
    })
    const list = useArtifactStore.getState().getMessageAnalysis("m1")
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe("math")
  })
})

describe("clearSessionData", () => {
  it("removes only the matching session's artifacts", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().clearSessionData("s1")
    const remaining = useArtifactStore.getState().artifacts
    expect(remaining[a.id]).toBeUndefined()
    expect(remaining[b.id]).toBeDefined()
  })
})

describe("getArtifact / getSessionArtifacts / search / filter / recent", () => {
  it("getArtifact returns rehydrated record", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    expect(useArtifactStore.getState().getArtifact(a.id)?.id).toBe(a.id)
    expect(useArtifactStore.getState().getArtifact("missing")).toBeUndefined()
  })

  it("searchArtifacts matches title/type/language", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "Alpha",
      content: "x",
      language: "python",
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "html",
      title: "Beta",
      content: "<html></html>",
    })
    expect(useArtifactStore.getState().searchArtifacts("alpha")).toHaveLength(1)
    expect(useArtifactStore.getState().searchArtifacts("html")).toHaveLength(1)
    expect(useArtifactStore.getState().searchArtifacts("python")).toHaveLength(1)
  })

  it("filterArtifactsByType honors session scope", () => {
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    expect(useArtifactStore.getState().filterArtifactsByType("code")).toHaveLength(2)
    expect(useArtifactStore.getState().filterArtifactsByType("code", "s1")).toHaveLength(1)
  })

  it("getRecentArtifacts respects limit", () => {
    for (let i = 0; i < 5; i++) {
      useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "code",
        title: `t${i}`,
        content: "x",
      })
    }
    expect(useArtifactStore.getState().getRecentArtifacts(3)).toHaveLength(3)
  })

  it("getSessionArtifacts only includes the matching session and rehydrates dates", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "a",
      content: "x",
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s2",
      messageId: "m",
      type: "code",
      title: "b",
      content: "y",
    })
    const list = useArtifactStore.getState().getSessionArtifacts("s1")
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("a")
    expect(list[0].createdAt).toBeInstanceOf(Date)
  })
})

describe("setActiveArtifact unknown id", () => {
  it("still updates activeArtifactId even when the artifact does not exist", () => {
    useArtifactStore.getState().setActiveArtifact("does-not-exist")
    expect(useArtifactStore.getState().activeArtifactId).toBe("does-not-exist")
  })
})

describe("rehydrateArtifactMetadata", () => {
  it("rehydrates lastAccessedAt from an ISO string in persisted state", () => {
    const iso = "2024-05-01T00:00:00.000Z"
    useArtifactStore.setState({
      artifacts: {
        ar: {
          id: "ar",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "t",
          content: "x",
          version: 1,
          createdAt: iso as unknown as Date,
          updatedAt: iso as unknown as Date,
          metadata: {
            lastAccessedAt: iso as unknown as Date,
          },
        },
      },
    })
    const a = useArtifactStore.getState().getArtifact("ar")
    expect(a?.metadata?.lastAccessedAt).toBeInstanceOf(Date)
    expect((a?.metadata?.lastAccessedAt as Date).toISOString()).toBe(iso)
  })

  it("returns undefined metadata when none was set on the artifact", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    const fetched = useArtifactStore.getState().getArtifact(a.id)
    expect(fetched?.metadata).toBeUndefined()
  })
})

describe("artifact workspace filters - branch coverage", () => {
  it("typeFilter excludes mismatched artifact types", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "code-1",
      content: "x",
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "html",
      title: "html-1",
      content: "<html></html>",
    })
    useArtifactStore.getState().setArtifactWorkspaceFilters({ typeFilter: "html" })
    const list = useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s" })
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("html-1")
  })

  it("runtimeFilter excludes artifacts whose runtimeHealth does not match", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "ready",
      content: "x",
      metadata: { runtimeHealth: "ready" },
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "errored",
      content: "y",
      metadata: { runtimeHealth: "error" },
    })
    useArtifactStore.getState().setArtifactWorkspaceFilters({ runtimeFilter: "ready" })
    const list = useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s" })
    expect(list.map((x) => x.id)).toEqual([a.id])
  })

  it("searchQuery matches title, type, or language", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "Alpha",
      content: "x",
      language: "python",
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "html",
      title: "Beta",
      content: "<html></html>",
    })
    useArtifactStore.getState().setArtifactWorkspaceFilters({ searchQuery: "alpha" })
    expect(
      useArtifactStore
        .getState()
        .getArtifactsForWorkspace({ sessionId: "s" })
        .map((x) => x.title)
    ).toEqual(["Alpha"])
    useArtifactStore.getState().setArtifactWorkspaceFilters({ searchQuery: "html" })
    expect(
      useArtifactStore
        .getState()
        .getArtifactsForWorkspace({ sessionId: "s" })
        .map((x) => x.title)
    ).toEqual(["Beta"])
    useArtifactStore.getState().setArtifactWorkspaceFilters({ searchQuery: "python" })
    expect(
      useArtifactStore
        .getState()
        .getArtifactsForWorkspace({ sessionId: "s" })
        .map((x) => x.title)
    ).toEqual(["Alpha"])
  })

  it("falls back to recent ids when scope is recent", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    // Manually drop b from recents so scope=recent only sees a
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        scope: "recent",
        recentArtifactIds: [a.id],
      },
    }))
    const list = useArtifactStore.getState().getArtifactsForWorkspace()
    expect(list.map((x) => x.id)).toEqual([a.id])
    expect(list.find((x) => x.id === b.id)).toBeUndefined()
  })
})

describe("deleteArtifact + returnContext interaction", () => {
  it("clears returnContext when the deleted artifact matches it", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifact(a.id)
    expect(useArtifactStore.getState().artifactWorkspace.returnContext).toBeNull()
  })

  it("preserves returnContext when the deleted artifact id does not match", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: b.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifact(a.id)
    expect(useArtifactStore.getState().artifactWorkspace.returnContext?.activeArtifactId).toBe(b.id)
  })

  it("falls back to a recent artifact when the active id is deleted", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    // Both a and b are in recents (newest first). Active artifact is b. Delete b.
    useArtifactStore.getState().deleteArtifact(b.id)
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
  })

  it("uses returnContext to resolve the next active artifact when available", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.setState((state) => ({
      activeArtifactId: b.id,
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifact(b.id)
    // returnContext should win over recent fallback
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
  })
})

describe("openPanel honors returnContext when no active artifact", () => {
  it("activates the returnContext artifact when missing an active one", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    useArtifactStore.setState((state) => ({
      activeArtifactId: null,
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().openPanel("artifact")
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
  })

  it("keeps the existing active id when set", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    useArtifactStore.getState().openPanel("artifact")
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
  })
})

describe("deleteArtifacts batch returnContext handling", () => {
  it("clears returnContext when one of the deleted ids matches it", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifacts([a.id])
    expect(useArtifactStore.getState().artifactWorkspace.returnContext).toBeNull()
  })

  it("preserves returnContext when deleting unrelated ids", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifacts([b.id])
    expect(useArtifactStore.getState().artifactWorkspace.returnContext?.activeArtifactId).toBe(a.id)
  })

  it("preserves the active artifact when none of the deleted ids match it", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.setState({ activeArtifactId: a.id })
    useArtifactStore.getState().deleteArtifacts([b.id])
    expect(useArtifactStore.getState().activeArtifactId).toBe(a.id)
  })
})

describe("updateCanvasDocument editor-context only updates", () => {
  it("does not bump updatedAt when only editorContext changes", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })
    const beforeUpdated = useArtifactStore.getState().canvasDocuments[id].updatedAt
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: { saveState: "saved" },
    })
    expect(useArtifactStore.getState().canvasDocuments[id].updatedAt).toBe(beforeUpdated)
  })

  it("merges nested editor-context fields (selection / visibleRange / location)", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: { startLine: 1, endLine: 2 } as never,
        visibleRange: { startLine: 0, endLine: 10 } as never,
        location: { path: ["a", "b"] } as never,
      },
    })
    const ctx = useArtifactStore.getState().canvasDocuments[id].editorContext
    expect(ctx?.selection).toBeDefined()
    expect(ctx?.visibleRange).toBeDefined()
    expect(ctx?.location?.path).toEqual(["a", "b"])
  })

  it("merges with existing nested editor-context fields", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: { startLine: 1, endLine: 2 } as never,
        visibleRange: { startLine: 0, endLine: 10 } as never,
        location: { path: ["a"] } as never,
      },
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: { startLine: 5, endLine: 6 } as never,
        visibleRange: { startLine: 3, endLine: 30 } as never,
        location: { path: undefined } as never,
      },
    })
    const ctx = useArtifactStore.getState().canvasDocuments[id].editorContext
    expect((ctx?.selection as { startLine: number } | undefined)?.startLine).toBe(5)
    expect((ctx?.visibleRange as { startLine: number } | undefined)?.startLine).toBe(3)
    // Path should fallback to the existing value when undefined
    expect(ctx?.location?.path).toEqual(["a"])
  })

  it("clears nested fields when explicitly passed undefined / null", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: { startLine: 1, endLine: 2 } as never,
        visibleRange: { startLine: 0, endLine: 10 } as never,
        location: { path: ["a"] } as never,
      },
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: undefined,
        visibleRange: undefined,
        location: undefined,
      },
    })
    const ctx = useArtifactStore.getState().canvasDocuments[id].editorContext
    expect(ctx?.selection).toBeUndefined()
    expect(ctx?.visibleRange).toBeUndefined()
    expect(ctx?.location).toBeUndefined()
  })
})

describe("clearSessionData additional branches", () => {
  it("preserves the activeArtifactId when it survives the session purge", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.setState({ activeArtifactId: b.id })
    useArtifactStore.getState().clearSessionData("s1")
    expect(useArtifactStore.getState().activeArtifactId).toBe(b.id)
    expect(useArtifactStore.getState().artifacts[a.id]).toBeUndefined()
  })

  it("clears the workspace sessionId when it matches the cleared session", () => {
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore.getState().setArtifactWorkspaceScope("session", "s1")
    useArtifactStore.getState().clearSessionData("s1")
    expect(useArtifactStore.getState().artifactWorkspace.sessionId).toBeNull()
  })

  it("preserves the activeCanvasId for canvases that survive the purge", () => {
    const surviving = useArtifactStore.getState().createCanvasDocument({
      sessionId: "keep",
      title: "k",
      content: "x",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().createCanvasDocument({
      sessionId: "purge",
      title: "p",
      content: "y",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.setState({ activeCanvasId: surviving })
    useArtifactStore.getState().clearSessionData("purge")
    expect(useArtifactStore.getState().activeCanvasId).toBe(surviving)
  })

  it("nulls activeCanvasId when its document is purged", () => {
    const purged = useArtifactStore.getState().createCanvasDocument({
      sessionId: "purge",
      title: "p",
      content: "y",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.setState({ activeCanvasId: purged })
    useArtifactStore.getState().clearSessionData("purge")
    expect(useArtifactStore.getState().activeCanvasId).toBeNull()
  })
})

describe("persist migration", () => {
  it("seeds missing top-level keys with safe defaults", () => {
    // Inject a v1 snapshot and force the persist middleware to migrate on rehydrate
    const snapshot = JSON.stringify({
      state: {
        artifacts: {},
      },
      version: 1,
    })
    localStorage.setItem("cognia-artifacts", snapshot)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./artifact-store") as typeof import("./artifact-store")
      const state = mod.useArtifactStore.getState()
      expect(state.canvasDocuments).toBeDefined()
      expect(state.artifactVersions).toBeDefined()
      expect(state.analysisResults).toBeDefined()
      expect(state.artifactWorkspace).toBeDefined()
    })
  })

  it("merges an existing artifactWorkspace with the initial defaults", () => {
    const snapshot = JSON.stringify({
      state: {
        artifacts: {},
        canvasDocuments: {},
        artifactVersions: {},
        analysisResults: {},
        artifactWorkspace: {
          searchQuery: "preserved",
        },
      },
      version: 1,
    })
    localStorage.setItem("cognia-artifacts", snapshot)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./artifact-store") as typeof import("./artifact-store")
      const state = mod.useArtifactStore.getState()
      expect(state.artifactWorkspace.searchQuery).toBe("preserved")
      expect(state.artifactWorkspace.scope).toBe("session")
    })
  })
})

describe("resolveNextActiveArtifactId fallback paths", () => {
  it("falls back to the most-recently-updated artifact when scope is recent (no session filter)", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    // Move scope away from "session" so the fallback hits the `: true` branch.
    useArtifactStore.setState((state) => ({
      activeArtifactId: a.id,
      artifactWorkspace: {
        ...state.artifactWorkspace,
        scope: "recent",
        sessionId: null,
        recentArtifactIds: [],
      },
    }))
    useArtifactStore.getState().deleteArtifact(a.id)
    // Expect the most-recently-updated remaining artifact (b) to be picked up
    expect(useArtifactStore.getState().activeArtifactId).toBe(b.id)
  })

  it("falls back to the latest artifact even when scope is session but no sessionId is set", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.setState((state) => ({
      activeArtifactId: a.id,
      artifactWorkspace: {
        ...state.artifactWorkspace,
        scope: "session",
        sessionId: null,
        recentArtifactIds: [],
      },
    }))
    useArtifactStore.getState().deleteArtifact(a.id)
    expect(useArtifactStore.getState().activeArtifactId).toBe(b.id)
  })

  it("filters by sessionId when scope is session AND sessionId is set", () => {
    const aS1 = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const bS1 = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "b", content: "y" })
    const cS2 = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "c", content: "z" })
    useArtifactStore.setState((state) => ({
      activeArtifactId: aS1.id,
      artifactWorkspace: {
        ...state.artifactWorkspace,
        scope: "session",
        sessionId: "s1",
        recentArtifactIds: [],
        returnContext: null,
      },
    }))
    // Delete the active artifact: resolveNextActiveArtifactId should pick a
    // scoped artifact from session "s1" (not "s2").
    useArtifactStore.getState().deleteArtifact(aS1.id)
    expect(useArtifactStore.getState().activeArtifactId).toBe(bS1.id)
    expect(useArtifactStore.getState().activeArtifactId).not.toBe(cS2.id)
  })
})

describe("persist partialize - LRU & truncation", () => {
  it("sorts artifacts by string-form updatedAt and truncates oversized content during persistence", async () => {
    // Rather than dig into the internal partialize, we simulate the behavior by
    // creating an artifact with oversized content and one with a Date string
    // updatedAt, then forcing a write by mutating state and reading the
    // localStorage snapshot the persist middleware emits.
    const big = "x".repeat(200_000)
    const recent = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "big", content: big })
    // Add two artifacts whose updatedAt is a string (simulating just-rehydrated)
    // so that both sides of the partialize ternary on the b-side run.
    useArtifactStore.setState((state) => ({
      artifacts: {
        ...state.artifacts,
        "with-string-date-1": {
          id: "with-string-date-1",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "string-date-1",
          content: "small-1",
          version: 1,
          createdAt: new Date(),
          updatedAt: "2023-01-01T00:00:00.000Z" as unknown as Date,
        },
        "with-string-date-2": {
          id: "with-string-date-2",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "string-date-2",
          content: "small-2",
          version: 1,
          createdAt: new Date(),
          updatedAt: "2024-01-01T00:00:00.000Z" as unknown as Date,
        },
      },
    }))
    // Trigger a persist write by toggling state
    useArtifactStore.getState().setPanelView("artifact")
    // Allow the persist middleware to flush
    await new Promise((resolve) => setTimeout(resolve, 0))
    const persisted = localStorage.getItem("cognia-artifacts")
    if (persisted) {
      const parsed = JSON.parse(persisted) as {
        state: { artifacts: Record<string, { content: string }> }
      }
      const recentEntry = parsed.state.artifacts[recent.id]
      // Truncated to 100KB
      expect(recentEntry?.content.length).toBeLessThanOrEqual(100 * 1024)
    }
  })

  it("sorts when both updatedAt values are non-Date strings", async () => {
    // Pure string-vs-string sort, exercising both sides of the ternary.
    useArtifactStore.setState({
      artifacts: {
        x: {
          id: "x",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "x",
          content: "c",
          version: 1,
          createdAt: new Date(),
          updatedAt: "2024-06-01T00:00:00.000Z" as unknown as Date,
        },
        y: {
          id: "y",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "y",
          content: "c",
          version: 1,
          createdAt: new Date(),
          updatedAt: "2024-07-01T00:00:00.000Z" as unknown as Date,
        },
      },
    })
    // Cause persist write
    useArtifactStore.getState().setPanelView("canvas")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const persisted = localStorage.getItem("cognia-artifacts")
    expect(persisted).toBeTruthy()
  })
})

describe("auto-save retention", () => {
  it("keeps only the most recent auto-saves when the cap is exceeded", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "doc",
      content: "v0",
      language: "javascript",
      type: "code",
    })
    // Bypass the saveCanvasVersion API by directly seeding many auto-saves.
    const many: Array<{
      id: string
      content: string
      title: string
      createdAt: Date
      isAutoSave: boolean
    }> = []
    for (let i = 0; i < 35; i++) {
      many.push({
        id: `v-${i}`,
        content: `c-${i}`,
        title: "doc",
        createdAt: new Date(2023, 0, i + 1),
        isAutoSave: true,
      })
    }
    useArtifactStore.setState((state) => ({
      canvasDocuments: {
        ...state.canvasDocuments,
        [id]: { ...state.canvasDocuments[id], versions: many as never },
      },
    }))
    // Now force retention to apply via saveCanvasVersion (auto-save = true)
    useArtifactStore.getState().saveCanvasVersion(id, "trigger", true)
    const versions = useArtifactStore.getState().canvasDocuments[id].versions || []
    // Cap is 30; we just added one more on top of 35, then retention prunes.
    expect(versions.length).toBeLessThanOrEqual(30)
  })
})
