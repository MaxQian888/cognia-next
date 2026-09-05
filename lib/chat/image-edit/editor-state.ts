/**
 * The workbench's undo history, as a pure reducer.
 *
 * Two kinds of step share one timeline and they behave very differently.
 *
 * A LOCAL step (crop, resize, rotate, flip, adjust) is a description. It costs
 * a few dozen bytes and can be replayed from the image it started from, so the
 * history stores the description and re-renders on demand.
 *
 * An AI step is a bitmap. Nothing about "make the sky orange" can be replayed,
 * so the result itself has to be retained, and each one is megabytes. That is
 * why the two have separate ceilings: fifty local steps, five AI checkpoints.
 *
 * Rendering at a given cursor means finding the most recent AI checkpoint at or
 * before it, and replaying the local steps after that. Everything here is a
 * plain value, ids included, so the reducer stays pure and the component keeps
 * the actual pixels in a map beside it. `releasedCheckpoints` is how the
 * component learns which of those bitmaps it may now revoke.
 */

import type { ImageAdjustments } from "@/lib/images"
import type { CropRect } from "@/lib/images"

import type { ImageEditOperation } from "./version"

/** Undo depth for replayable steps. */
export const MAX_LOCAL_COMMANDS = 50

/**
 * How many AI results stay reachable.
 *
 * Five, not fifty: each one is a full decoded frame held in memory for as long
 * as the workbench is open, and a 1568px RGBA buffer is roughly 10MB before the
 * blob backing its preview.
 */
export const MAX_AI_CHECKPOINTS = 5

export interface CropEntry {
  kind: "crop"
  rect: CropRect
}

export interface ResizeEntry {
  kind: "resize"
  width: number
  height: number
}

export interface RotateEntry {
  kind: "rotate"
  /** Clockwise quarter turns. Negative is counter-clockwise. */
  turns: number
}

export interface FlipEntry {
  kind: "flip"
  horizontal: boolean
  vertical: boolean
}

export interface AdjustEntry {
  kind: "adjust"
  adjustments: ImageAdjustments
  /**
   * Identifies one continuous slider drag.
   *
   * A slider fires a change per pixel of travel. Pushing each one would fill
   * the fifty-step history with a single gesture and make undo useless, so
   * consecutive entries carrying the same gesture replace one another and the
   * drag lands as one step.
   */
  gestureId: string
}

export interface AiEntry {
  kind: "ai"
  /** Key into the component's bitmap map. */
  checkpointId: string
  operation: ImageEditOperation
  providerId?: string
  modelId?: string
}

export type EditorEntry = CropEntry | ResizeEntry | RotateEntry | FlipEntry | AdjustEntry | AiEntry

export type LocalEntry = Exclude<EditorEntry, AiEntry>

export interface EditorState {
  /**
   * The bitmap the timeline starts from, or `null` for the original image.
   *
   * Set when an AI checkpoint falls off the bottom of the history: everything
   * before it is subsumed, so it becomes the new floor.
   */
  originCheckpointId: string | null
  /** Steps that fell out of the undo window. Always applied, never undoable. */
  baked: LocalEntry[]
  /** The undo stack, oldest first. */
  entries: EditorEntry[]
  /** How many of `entries` are currently applied. */
  cursor: number
}

export const INITIAL_EDITOR_STATE: EditorState = {
  originCheckpointId: null,
  baked: [],
  entries: [],
  cursor: 0,
}

export type EditorAction =
  | { type: "apply"; entry: EditorEntry }
  | { type: "undo" }
  | { type: "redo" }
  /** Back to the original image, discarding everything. */
  | { type: "reset" }
  /** Jump the cursor, which is what clicking the version rail does. */
  | { type: "jump"; cursor: number }

function isAi(entry: EditorEntry): entry is AiEntry {
  return entry.kind === "ai"
}

/** Every checkpoint id the state can still reach, origin included. */
export function referencedCheckpoints(state: EditorState): string[] {
  const ids = state.entries.filter(isAi).map((entry) => entry.checkpointId)
  return state.originCheckpointId ? [state.originCheckpointId, ...ids] : ids
}

/**
 * Checkpoint bitmaps that `previous` could reach and `next` cannot.
 *
 * The component revokes their object URLs. Without this the workbench holds
 * every AI result it ever produced until it closes, which for a long session is
 * exactly the leak the five-checkpoint ceiling exists to prevent.
 */
export function releasedCheckpoints(previous: EditorState, next: EditorState): string[] {
  const live = new Set(referencedCheckpoints(next))
  return referencedCheckpoints(previous).filter((id) => !live.has(id))
}

/**
 * Whether `entry` should replace the top of the stack instead of extending it.
 * Only ever true for two halves of one slider drag.
 */
function coalesces(top: EditorEntry | undefined, entry: EditorEntry): boolean {
  return (
    top?.kind === "adjust" &&
    entry.kind === "adjust" &&
    top.gestureId === entry.gestureId &&
    top.gestureId.length > 0
  )
}

/**
 * Push everything up to `count` out of the undo window.
 *
 * An AI entry that gets baked becomes the new origin and clears the baked list,
 * because its bitmap already contains every step before it. A local entry is
 * appended to the baked list, where it is still replayed on every render but
 * can no longer be undone.
 */
function bake(state: EditorState, count: number): EditorState {
  if (count <= 0) return state
  let originCheckpointId = state.originCheckpointId
  let baked = state.baked
  for (const entry of state.entries.slice(0, count)) {
    if (isAi(entry)) {
      originCheckpointId = entry.checkpointId
      baked = []
    } else {
      baked = [...baked, entry]
    }
  }
  return {
    originCheckpointId,
    baked,
    entries: state.entries.slice(count),
    cursor: Math.max(0, state.cursor - count),
  }
}

/** How many entries must be baked to respect both ceilings. */
function overflowCount(entries: readonly EditorEntry[]): number {
  const localIndexes: number[] = []
  const aiIndexes: number[] = []
  entries.forEach((entry, index) => {
    if (isAi(entry)) aiIndexes.push(index)
    else localIndexes.push(index)
  })

  let count = 0
  if (localIndexes.length > MAX_LOCAL_COMMANDS) {
    count = localIndexes[localIndexes.length - MAX_LOCAL_COMMANDS - 1] + 1
  }
  if (aiIndexes.length > MAX_AI_CHECKPOINTS) {
    count = Math.max(count, aiIndexes[aiIndexes.length - MAX_AI_CHECKPOINTS - 1] + 1)
  }
  return count
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "apply": {
      // Applying after an undo abandons the redo tail, which is what every
      // editor does and what the version rail visibly reflects.
      const kept = state.entries.slice(0, state.cursor)
      const top = kept.at(-1)
      const entries = coalesces(top, action.entry)
        ? [...kept.slice(0, -1), action.entry]
        : [...kept, action.entry]
      const next: EditorState = { ...state, entries, cursor: entries.length }
      return bake(next, overflowCount(entries))
    }
    case "undo":
      return state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state
    case "redo":
      return state.cursor < state.entries.length ? { ...state, cursor: state.cursor + 1 } : state
    case "jump": {
      const cursor = Math.max(0, Math.min(action.cursor, state.entries.length))
      return cursor === state.cursor ? state : { ...state, cursor }
    }
    case "reset":
      return INITIAL_EDITOR_STATE
    default:
      return state
  }
}

export function canUndo(state: EditorState): boolean {
  return state.cursor > 0
}

export function canRedo(state: EditorState): boolean {
  return state.cursor < state.entries.length
}

/**
 * Whether anything at all has been done to the image.
 *
 * Drives both the save button and the discard-changes confirmation, so it has
 * to count baked steps and a promoted origin too: those are edits the user made
 * that simply fell out of the undo window.
 */
export function isDirty(state: EditorState): boolean {
  return state.cursor > 0 || state.baked.length > 0 || state.originCheckpointId !== null
}

export interface RenderPipeline {
  /** Bitmap to start from. `null` means decode the original image. */
  baseCheckpointId: string | null
  /** Local steps to replay on top of it, in order. */
  operations: LocalEntry[]
}

/**
 * What to render at a given cursor.
 *
 * Walks backwards for the most recent AI checkpoint, because an AI result is a
 * bitmap that already contains everything before it. Only the local steps after
 * that point need replaying.
 */
export function pipelineAt(state: EditorState, cursor: number): RenderPipeline {
  const applied = [...state.baked, ...state.entries.slice(0, Math.max(0, cursor))]
  for (let index = applied.length - 1; index >= 0; index -= 1) {
    const entry = applied[index]
    if (isAi(entry)) {
      return {
        baseCheckpointId: entry.checkpointId,
        operations: applied.slice(index + 1) as LocalEntry[],
      }
    }
  }
  return {
    baseCheckpointId: state.originCheckpointId,
    operations: applied as LocalEntry[],
  }
}

/** What to render right now. */
export function currentPipeline(state: EditorState): RenderPipeline {
  return pipelineAt(state, state.cursor)
}

const OPERATION_BY_KIND: Record<LocalEntry["kind"], ImageEditOperation> = {
  crop: "crop",
  resize: "resize",
  rotate: "rotate",
  flip: "flip",
  adjust: "adjust",
}

/**
 * The operations to record on a saved version.
 *
 * Deduplicated and in first-use order, so a version that was cropped, adjusted
 * and cropped again reads as "crop, adjust" rather than repeating itself. Steps
 * beyond the undo window count: they are in the saved pixels.
 */
export function operationsForSave(state: EditorState): ImageEditOperation[] {
  const applied = [...state.baked, ...state.entries.slice(0, state.cursor)]
  const seen: ImageEditOperation[] = []
  for (const entry of applied) {
    const operation = isAi(entry) ? entry.operation : OPERATION_BY_KIND[entry.kind]
    if (!seen.includes(operation)) seen.push(operation)
  }
  return seen
}

/**
 * Provider and model of the AI step that produced the current pixels, if any.
 *
 * Only the LAST AI step is attributed. An earlier one contributed to the image,
 * but the version record names who made this result, and claiming two models
 * made one image would be worse than naming the one that finished it.
 */
export function attributionForSave(
  state: EditorState
): { providerId?: string; modelId?: string } | null {
  const applied = [...state.baked, ...state.entries.slice(0, state.cursor)]
  for (let index = applied.length - 1; index >= 0; index -= 1) {
    const entry = applied[index]
    if (!isAi(entry)) continue
    return {
      ...(entry.providerId ? { providerId: entry.providerId } : {}),
      ...(entry.modelId ? { modelId: entry.modelId } : {}),
    }
  }
  return null
}
