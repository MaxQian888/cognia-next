import {
  EMPTY_EDITOR_TAB_STATE,
  forgetTab,
  isPreviewTab,
  pinTab,
  renameTab,
  resolveTabIntent,
  type EditorTabState,
} from "./editor-tab-model"

const withPreview = (relPath: string): EditorTabState => ({ previewPath: relPath })

describe("resolveTabIntent", () => {
  it("inserts the first preview tab without evicting anything", () => {
    const result = resolveTabIntent(EMPTY_EDITOR_TAB_STATE, {
      relPath: "src/a.ts",
      mode: "preview",
      isOpen: false,
    })
    expect(result).toEqual({
      outcome: "insert",
      evicted: null,
      state: { previewPath: "src/a.ts" },
    })
  })

  it("reuses the single preview slot, evicting its previous holder", () => {
    const result = resolveTabIntent(withPreview("src/a.ts"), {
      relPath: "src/b.ts",
      mode: "preview",
      isOpen: false,
    })
    expect(result).toEqual({
      outcome: "replace",
      evicted: "src/a.ts",
      state: { previewPath: "src/b.ts" },
    })
  })

  it("never evicts a pinned tab when a preview opens", () => {
    const result = resolveTabIntent(EMPTY_EDITOR_TAB_STATE, {
      relPath: "src/b.ts",
      mode: "preview",
      isOpen: false,
    })
    expect(result.evicted).toBeNull()
  })

  it("inserts a pinned tab alongside an existing preview", () => {
    const result = resolveTabIntent(withPreview("src/a.ts"), {
      relPath: "src/b.ts",
      mode: "pinned",
      isOpen: false,
    })
    expect(result).toEqual({
      outcome: "insert",
      evicted: null,
      state: { previewPath: "src/a.ts" },
    })
  })

  it("activates an already-open tab without touching the preview slot", () => {
    const result = resolveTabIntent(withPreview("src/a.ts"), {
      relPath: "src/b.ts",
      mode: "preview",
      isOpen: true,
    })
    expect(result).toEqual({
      outcome: "activate",
      evicted: null,
      state: { previewPath: "src/a.ts" },
    })
  })

  it("promotes the preview when it is re-opened in pinned mode", () => {
    const result = resolveTabIntent(withPreview("src/a.ts"), {
      relPath: "src/a.ts",
      mode: "pinned",
      isOpen: true,
    })
    expect(result).toEqual({ outcome: "activate", evicted: null, state: { previewPath: null } })
  })

  it("re-previewing the current preview does not evict itself", () => {
    const result = resolveTabIntent(withPreview("src/a.ts"), {
      relPath: "src/a.ts",
      mode: "preview",
      isOpen: false,
    })
    expect(result).toEqual({
      outcome: "insert",
      evicted: null,
      state: { previewPath: "src/a.ts" },
    })
  })
})

describe("pinTab", () => {
  it("clears the preview slot when the preview is pinned", () => {
    expect(pinTab(withPreview("src/a.ts"), "src/a.ts")).toEqual({ previewPath: null })
  })

  it("leaves an unrelated preview alone", () => {
    const state = withPreview("src/a.ts")
    expect(pinTab(state, "src/b.ts")).toBe(state)
  })
})

describe("forgetTab", () => {
  it("frees the preview slot when the preview closes", () => {
    expect(forgetTab(withPreview("src/a.ts"), "src/a.ts")).toEqual({ previewPath: null })
  })

  it("is a no-op for a pinned tab", () => {
    const state = withPreview("src/a.ts")
    expect(forgetTab(state, "src/b.ts")).toBe(state)
  })
})

describe("renameTab", () => {
  it("follows a direct rename", () => {
    expect(renameTab(withPreview("src/a.ts"), "src/a.ts", "src/z.ts")).toEqual({
      previewPath: "src/z.ts",
    })
  })

  it("follows a directory rename", () => {
    expect(renameTab(withPreview("src/lib/a.ts"), "src/lib", "src/core")).toEqual({
      previewPath: "src/core/a.ts",
    })
  })

  it("does not match a sibling with a shared prefix", () => {
    const state = withPreview("src/library/a.ts")
    expect(renameTab(state, "src/lib", "src/core")).toBe(state)
  })

  it("is a no-op with no preview", () => {
    expect(renameTab(EMPTY_EDITOR_TAB_STATE, "src/a.ts", "src/b.ts")).toBe(EMPTY_EDITOR_TAB_STATE)
  })
})

describe("isPreviewTab", () => {
  it("identifies the preview tab only", () => {
    const state = withPreview("src/a.ts")
    expect(isPreviewTab(state, "src/a.ts")).toBe(true)
    expect(isPreviewTab(state, "src/b.ts")).toBe(false)
    expect(isPreviewTab(EMPTY_EDITOR_TAB_STATE, "src/a.ts")).toBe(false)
  })
})
