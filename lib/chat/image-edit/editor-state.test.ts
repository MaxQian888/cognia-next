import {
  attributionForSave,
  canRedo,
  canUndo,
  currentPipeline,
  editorReducer,
  isDirty,
  operationsForSave,
  pipelineAt,
  referencedCheckpoints,
  releasedCheckpoints,
  INITIAL_EDITOR_STATE,
  MAX_AI_CHECKPOINTS,
  MAX_LOCAL_COMMANDS,
  type EditorEntry,
  type EditorState,
} from "./editor-state"

const crop = (x = 0): EditorEntry => ({
  kind: "crop",
  rect: { x, y: 0, width: 10, height: 10 },
})
const rotate = (turns = 1): EditorEntry => ({ kind: "rotate", turns })
const adjust = (gestureId: string, brightness: number): EditorEntry => ({
  kind: "adjust",
  adjustments: { brightness },
  gestureId,
})
const ai = (checkpointId: string, extra: Partial<Record<string, string>> = {}): EditorEntry => ({
  kind: "ai",
  checkpointId,
  operation: "ai.prompt",
  ...extra,
})

function applyAll(entries: EditorEntry[], from: EditorState = INITIAL_EDITOR_STATE): EditorState {
  return entries.reduce((state, entry) => editorReducer(state, { type: "apply", entry }), from)
}

describe("apply", () => {
  it("pushes a step and advances the cursor", () => {
    const state = applyAll([crop()])
    expect(state.entries).toHaveLength(1)
    expect(state.cursor).toBe(1)
  })

  it("abandons the redo tail when a new step lands after an undo", () => {
    let state = applyAll([crop(1), crop(2)])
    state = editorReducer(state, { type: "undo" })
    state = editorReducer(state, { type: "apply", entry: rotate() })
    expect(state.entries.map((entry) => entry.kind)).toEqual(["crop", "rotate"])
    expect(canRedo(state)).toBe(false)
  })

  it("collapses one slider drag into a single step", () => {
    // Every pixel of travel fires a change. Without coalescing a single drag
    // fills the whole fifty-step window and undo stops meaning anything.
    const state = applyAll([adjust("g1", 5), adjust("g1", 12), adjust("g1", 30)])
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ adjustments: { brightness: 30 } })
  })

  it("keeps separate drags as separate steps", () => {
    const state = applyAll([adjust("g1", 5), adjust("g2", 12)])
    expect(state.entries).toHaveLength(2)
  })

  it("never coalesces across an intervening step", () => {
    const state = applyAll([adjust("g1", 5), crop(), adjust("g1", 9)])
    expect(state.entries).toHaveLength(3)
  })

  it("does not coalesce entries with an empty gesture id", () => {
    const state = applyAll([adjust("", 5), adjust("", 9)])
    expect(state.entries).toHaveLength(2)
  })
})

describe("undo and redo", () => {
  it("moves the cursor without discarding steps", () => {
    let state = applyAll([crop(), rotate()])
    state = editorReducer(state, { type: "undo" })
    expect(state.cursor).toBe(1)
    expect(state.entries).toHaveLength(2)
    state = editorReducer(state, { type: "redo" })
    expect(state.cursor).toBe(2)
  })

  it("is a no-op at either end and returns the same object", () => {
    const empty = INITIAL_EDITOR_STATE
    expect(editorReducer(empty, { type: "undo" })).toBe(empty)
    const full = applyAll([crop()])
    expect(editorReducer(full, { type: "redo" })).toBe(full)
    expect(canUndo(empty)).toBe(false)
    expect(canRedo(full)).toBe(false)
  })
})

describe("jump", () => {
  it("moves the cursor anywhere in range", () => {
    const state = applyAll([crop(), rotate(), crop(2)])
    expect(editorReducer(state, { type: "jump", cursor: 1 }).cursor).toBe(1)
    expect(editorReducer(state, { type: "jump", cursor: 0 }).cursor).toBe(0)
  })

  it("clamps out-of-range targets and short-circuits a no-op", () => {
    const state = applyAll([crop()])
    expect(editorReducer(state, { type: "jump", cursor: 99 }).cursor).toBe(1)
    expect(editorReducer(state, { type: "jump", cursor: -4 }).cursor).toBe(0)
    expect(editorReducer(state, { type: "jump", cursor: 1 })).toBe(state)
  })
})

describe("reset", () => {
  it("returns to the untouched original", () => {
    const state = applyAll([crop(), ai("c1"), rotate()])
    expect(editorReducer(state, { type: "reset" })).toEqual(INITIAL_EDITOR_STATE)
  })
})

describe("isDirty", () => {
  it("is false only for an untouched editor", () => {
    expect(isDirty(INITIAL_EDITOR_STATE)).toBe(false)
    expect(isDirty(applyAll([crop()]))).toBe(true)
  })

  it("stays true after undoing back to the start when steps were baked", () => {
    // Those steps are in the pixels even though they left the undo window, so
    // the discard-changes prompt still has to fire.
    let state = applyAll(Array.from({ length: MAX_LOCAL_COMMANDS + 2 }, (_, i) => crop(i)))
    for (let i = 0; i < MAX_LOCAL_COMMANDS; i += 1) state = editorReducer(state, { type: "undo" })
    expect(state.cursor).toBe(0)
    expect(state.baked.length).toBeGreaterThan(0)
    expect(isDirty(state)).toBe(true)
  })

  it("is false after undoing every step that is still undoable", () => {
    let state = applyAll([crop(), rotate()])
    state = editorReducer(state, { type: "undo" })
    state = editorReducer(state, { type: "undo" })
    expect(isDirty(state)).toBe(false)
  })
})

describe("local command ceiling", () => {
  it("bakes the oldest steps once the window is full", () => {
    const state = applyAll(Array.from({ length: MAX_LOCAL_COMMANDS + 3 }, (_, i) => crop(i)))
    expect(state.entries).toHaveLength(MAX_LOCAL_COMMANDS)
    expect(state.baked).toHaveLength(3)
  })

  it("keeps the baked steps in the render pipeline, so the image is unchanged", () => {
    const state = applyAll(Array.from({ length: MAX_LOCAL_COMMANDS + 3 }, (_, i) => crop(i)))
    expect(currentPipeline(state).operations).toHaveLength(MAX_LOCAL_COMMANDS + 3)
    // The very first step is still applied even though it can no longer be undone.
    expect(currentPipeline(state).operations[0]).toMatchObject({ rect: { x: 0 } })
  })
})

describe("AI checkpoint ceiling", () => {
  it("keeps at most the configured number reachable", () => {
    const state = applyAll(Array.from({ length: MAX_AI_CHECKPOINTS + 2 }, (_, i) => ai(`c${i}`)))
    expect(state.entries.filter((entry) => entry.kind === "ai")).toHaveLength(MAX_AI_CHECKPOINTS)
  })

  it("promotes a baked checkpoint to the origin and clears the baked steps", () => {
    // The checkpoint's bitmap already contains every step before it, so those
    // steps must not be replayed on top of it a second time.
    const state = applyAll([
      crop(1),
      ...Array.from({ length: MAX_AI_CHECKPOINTS + 1 }, (_, i) => ai(`c${i}`)),
    ])
    expect(state.originCheckpointId).toBe("c0")
    expect(state.baked).toEqual([])
  })

  it("reports the dropped bitmaps so the component can revoke them", () => {
    const before = applyAll(Array.from({ length: MAX_AI_CHECKPOINTS }, (_, i) => ai(`c${i}`)))
    const after = editorReducer(before, { type: "apply", entry: ai("new") })
    expect(releasedCheckpoints(before, after)).toEqual([])
    const evicted = editorReducer(after, { type: "apply", entry: ai("newer") })
    expect(releasedCheckpoints(after, evicted)).toEqual(["c0"])
  })

  it("counts the origin as still referenced", () => {
    const state = applyAll([
      ...Array.from({ length: MAX_AI_CHECKPOINTS + 1 }, (_, i) => ai(`c${i}`)),
    ])
    expect(referencedCheckpoints(state)).toContain("c0")
  })
})

describe("pipelineAt", () => {
  it("starts from the original when nothing was done", () => {
    expect(currentPipeline(INITIAL_EDITOR_STATE)).toEqual({
      baseCheckpointId: null,
      operations: [],
    })
  })

  it("replays local steps on the original", () => {
    const pipeline = currentPipeline(applyAll([crop(), rotate()]))
    expect(pipeline.baseCheckpointId).toBeNull()
    expect(pipeline.operations.map((entry) => entry.kind)).toEqual(["crop", "rotate"])
  })

  it("starts from the most recent AI checkpoint and replays only what follows", () => {
    // An AI result is a bitmap that already contains the crop before it.
    // Replaying that crop again would apply it twice.
    const pipeline = currentPipeline(applyAll([crop(), ai("c1"), rotate()]))
    expect(pipeline.baseCheckpointId).toBe("c1")
    expect(pipeline.operations.map((entry) => entry.kind)).toEqual(["rotate"])
  })

  it("falls back to the earlier base when the cursor is moved before a checkpoint", () => {
    const state = applyAll([crop(), ai("c1"), rotate()])
    expect(pipelineAt(state, 1).baseCheckpointId).toBeNull()
    expect(pipelineAt(state, 1).operations.map((entry) => entry.kind)).toEqual(["crop"])
  })

  it("clamps a negative cursor to the untouched image", () => {
    expect(pipelineAt(applyAll([crop()]), -3).operations).toEqual([])
  })
})

describe("operationsForSave", () => {
  it("is empty for an untouched image", () => {
    expect(operationsForSave(INITIAL_EDITOR_STATE)).toEqual([])
  })

  it("lists each operation once, in first-use order", () => {
    const state = applyAll([crop(1), adjust("g", 4), crop(2), rotate()])
    expect(operationsForSave(state)).toEqual(["crop", "adjust", "rotate"])
  })

  it("names the AI operation that produced a step", () => {
    const state = applyAll([
      { kind: "ai", checkpointId: "c1", operation: "ai.remove-background" },
      crop(),
    ])
    expect(operationsForSave(state)).toEqual(["ai.remove-background", "crop"])
  })

  it("excludes steps the cursor has undone past", () => {
    let state = applyAll([crop(), rotate()])
    state = editorReducer(state, { type: "undo" })
    expect(operationsForSave(state)).toEqual(["crop"])
  })

  it("includes steps that fell out of the undo window", () => {
    const state = applyAll([
      rotate(),
      ...Array.from({ length: MAX_LOCAL_COMMANDS }, (_, i) => crop(i)),
    ])
    expect(state.baked.length).toBeGreaterThan(0)
    expect(operationsForSave(state)).toContain("rotate")
  })
})

describe("attributionForSave", () => {
  it("is null when no model touched the image", () => {
    expect(attributionForSave(applyAll([crop()]))).toBeNull()
  })

  it("names the last model to run, not the first", () => {
    // Two models contributed, but the record says who produced this result.
    const state = applyAll([
      ai("c1", { providerId: "openai", modelId: "gpt-image-1" }),
      ai("c2", { providerId: "xai", modelId: "grok-2-image" }),
      crop(),
    ])
    expect(attributionForSave(state)).toEqual({ providerId: "xai", modelId: "grok-2-image" })
  })

  it("omits absent fields rather than writing undefined", () => {
    expect(attributionForSave(applyAll([ai("c1")]))).toEqual({})
  })

  it("ignores an AI step the cursor has undone past", () => {
    let state = applyAll([ai("c1", { providerId: "openai" })])
    state = editorReducer(state, { type: "undo" })
    expect(attributionForSave(state)).toBeNull()
  })
})
