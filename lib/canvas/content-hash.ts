/**
 * A cheap, stable fingerprint of a document's content.
 *
 * Used to decide whether an AI proposal still describes the buffer it was
 * diffed from. That question used to be answered by an `isStale` flag that
 * `updateCanvasDocument` had to remember to set, so a proposal that survived a
 * reload, or a buffer changed by a path that did not go through that action,
 * could be applied against content it was never diffed from. Accepted hunks are
 * applied BY LINE NUMBER, so that corrupts the document with no error.
 *
 * FNV-1a, not a cryptographic hash: this answers "did this change", never "is
 * this authentic". It is synchronous (`crypto.subtle` is not), which matters
 * because the check runs on the apply path and in a store action, and it is
 * stable across reloads and platforms, which a `Date`-based revision is not.
 *
 * A 32-bit space means collisions exist in principle. The consequence of one is
 * that a proposal is treated as fresh when it is not, which is exactly the
 * behaviour before this existed, so the hash can only narrow the window.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

export function hashCanvasContent(content: string): string {
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    // `Math.imul` keeps the multiply in 32-bit space. A plain `*` overflows
    // into a float and quietly stops being FNV after a few hundred bytes.
    hash = Math.imul(hash, FNV_PRIME)
  }
  // Length is folded in so two documents that hash alike must also differ in
  // size to collide.
  return `${(hash >>> 0).toString(36)}.${content.length.toString(36)}`
}
