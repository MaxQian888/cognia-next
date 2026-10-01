/**
 * The running cogset follower and write-through, if this host started them.
 *
 * A leaf module so the actions and the host-command handler can nudge the
 * follower without importing the follower's production wiring (Dexie, the
 * project store, the execution broker) into their own graphs.
 */

export interface CogsetFollowerHandle {
  evaluate: () => Promise<void>
}

let active: CogsetFollowerHandle | null = null

export function setActiveCogsetFollower(follower: CogsetFollowerHandle | null): void {
  active = follower
}

export function getActiveCogsetFollower(): CogsetFollowerHandle | null {
  return active
}

export interface CogsetWriteThroughHandle {
  /** Resolves once every manual change observed so far has been written. */
  settled: () => Promise<void>
}

let activeWriteThrough: CogsetWriteThroughHandle | null = null

/** Activation waits on this before it rewrites the outgoing cogset. */
export function setActiveCogsetWriteThrough(writeThrough: CogsetWriteThroughHandle | null): void {
  activeWriteThrough = writeThrough
}

export function getActiveCogsetWriteThrough(): CogsetWriteThroughHandle | null {
  return activeWriteThrough
}
