/**
 * Per-path three-way diff and merge for template payloads.
 *
 * # Why this exists
 *
 * The previous producer compared whole documents. When baseline, local and
 * upstream were all different it reported one conflict at `$`, and
 * `TemplateService.planUpdate` turns any conflict into a `blocker`. So an
 * instance the user had customised could never take an upstream release
 * again, even when the two sides had touched completely disjoint fields.
 * `TemplateDiffResult.changes[]` already carried a `path`. Only the producer
 * was degenerate.
 *
 * # Why arrays are atomic
 *
 * Objects recurse key by key. Arrays do NOT recurse by index: an element-wise
 * three-way merge silently pairs the wrong objects the moment a member is
 * reordered, inserted or removed, and template payloads are full of ordered
 * collections whose identity is positional only by accident (workflow nodes
 * and edges, teammate rosters, task lists with `assignedToIndex`). A wrong
 * merge is worse than a refused one, so a changed array is reported as a
 * single conflict or change at the array's own path.
 *
 * A domain that DOES have stable element ids can still do better: `diff` is a
 * `TemplateDomainAdapter` member (`service.ts`), so such a domain overrides it
 * rather than teaching this module a heuristic it cannot verify.
 *
 * # Path syntax
 *
 * Slash-separated from a `$` root, with `~1` escaping a literal `/` in a key
 * (JSON Pointer's rule, so a path is unambiguous). The root itself is `$`.
 */

import type { TemplateJson } from "./contracts"
import type { TemplateDiffResult } from "./service"

/** The root path. Also what an atomic whole-document difference reports. */
export const TEMPLATE_DIFF_ROOT = "$"

function escapeSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1")
}

function childPath(parent: string, key: string): string {
  return parent === TEMPLATE_DIFF_ROOT
    ? `${TEMPLATE_DIFF_ROOT}/${escapeSegment(key)}`
    : `${parent}/${escapeSegment(key)}`
}

function isPlainObject(value: TemplateJson): value is { [key: string]: TemplateJson } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Structural equality. `JSON.stringify` is not enough on its own because key
 * order differs between a stored payload and a freshly projected one, and two
 * payloads that differ only in key order are the same payload.
 */
function equal(a: TemplateJson, b: TemplateJson): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => equal(item, b[index] as TemplateJson))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      const left = key in a ? a[key] : undefined
      const right = key in b ? b[key] : undefined
      if (left === undefined || right === undefined) {
        if (left !== right) return false
        continue
      }
      if (!equal(left, right)) return false
    }
    return true
  }
  return false
}

/** A key present in none of the three documents contributes nothing. */
const ABSENT = Symbol("absent")
type Slot = TemplateJson | typeof ABSENT

function slot(source: TemplateJson, key: string): Slot {
  if (!isPlainObject(source)) return ABSENT
  return key in source ? (source[key] as TemplateJson) : ABSENT
}

function slotsEqual(a: Slot, b: Slot): boolean {
  if (a === ABSENT || b === ABSENT) return a === b
  return equal(a, b)
}

/** `undefined` for an absent slot, so a deletion reads as "no value". */
function present(value: Slot): TemplateJson | undefined {
  return value === ABSENT ? undefined : value
}

function walk(
  baseline: Slot,
  local: Slot,
  next: Slot,
  path: string,
  result: TemplateDiffResult
): void {
  // Upstream did not move. Whatever local did is simply kept.
  if (slotsEqual(baseline, next)) return
  // Both sides landed on the same value. Agreement, not conflict.
  if (slotsEqual(local, next)) return
  // Recurse wherever recursion is sound, which is two plain objects, and do it
  // BEFORE deciding change-versus-conflict. Deciding first would report a
  // whole object as one coarse node even when only one key inside it moved,
  // which is the granularity this module exists to provide. Arrays and scalars
  // cannot be recursed (see the header) and fall through.
  if (isPlainObject(local) && isPlainObject(next)) {
    const baselineObject = isPlainObject(baseline) ? baseline : {}
    const keys = new Set([
      ...Object.keys(baselineObject),
      ...Object.keys(local),
      ...Object.keys(next),
    ])
    for (const key of keys) {
      walk(
        isPlainObject(baseline) ? slot(baseline, key) : ABSENT,
        slot(local, key),
        slot(next, key),
        childPath(path, key),
        result
      )
    }
    return
  }
  // Local never moved, so upstream's change applies cleanly.
  if (slotsEqual(baseline, local)) {
    const change: TemplateDiffResult["changes"][number] = { path }
    const before = present(baseline)
    const after = present(next)
    if (before !== undefined) change.before = before
    if (after !== undefined) change.after = after
    result.changes.push(change)
    return
  }
  const conflict: TemplateDiffResult["conflicts"][number] = { path }
  const baselineValue = present(baseline)
  const localValue = present(local)
  const nextValue = present(next)
  if (baselineValue !== undefined) conflict.baseline = baselineValue
  if (localValue !== undefined) conflict.local = localValue
  if (nextValue !== undefined) conflict.next = nextValue
  result.conflicts.push(conflict)
}

/**
 * Three-way diff of `local` and `next` against their common `baseline`.
 *
 * `changes` are upstream edits local never touched: safe to take. `conflicts`
 * are paths both sides moved to different values, and the caller decides.
 */
export function diffPayload(
  baseline: TemplateJson,
  local: TemplateJson,
  next: TemplateJson
): TemplateDiffResult {
  const result: TemplateDiffResult = { changes: [], conflicts: [] }
  walk(baseline, local, next, TEMPLATE_DIFF_ROOT, result)
  return result
}

function setAtPath(
  root: TemplateJson,
  path: string,
  value: TemplateJson | undefined
): TemplateJson {
  if (path === TEMPLATE_DIFF_ROOT) return value === undefined ? null : value
  const segments = path
    .slice(TEMPLATE_DIFF_ROOT.length + 1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
  const cloned: TemplateJson = isPlainObject(root) ? { ...root } : {}
  let cursor = cloned as { [key: string]: TemplateJson }
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index] as string
    const child = cursor[key]
    // A missing or non-object ancestor is replaced: the adopted path has to
    // exist for the value to land, and upstream is the authority on its shape.
    cursor[key] = isPlainObject(child) ? { ...child } : {}
    cursor = cursor[key] as { [key: string]: TemplateJson }
  }
  const leaf = segments[segments.length - 1] as string
  if (value === undefined) delete cursor[leaf]
  else cursor[leaf] = value
  return cloned
}

/**
 * The payload to write: `local`, with the adopted paths taken from `next`.
 *
 * `adopt` names paths from a prior `diffPayload` result. Every non-conflicting
 * change is applied whether or not it is listed, because a change is by
 * definition a field local never touched, so declining it would silently pin
 * the instance to a stale value it never chose. Only conflicts are opt-in.
 */
export function mergePayload(
  baseline: TemplateJson,
  local: TemplateJson,
  next: TemplateJson,
  adopt: readonly string[] = []
): TemplateJson {
  const diff = diffPayload(baseline, local, next)
  const adopted = new Set(adopt)
  let merged = local
  for (const change of diff.changes) {
    merged = setAtPath(merged, change.path, change.after)
  }
  for (const conflict of diff.conflicts) {
    if (!adopted.has(conflict.path)) continue
    merged = setAtPath(merged, conflict.path, conflict.next)
  }
  return merged
}
