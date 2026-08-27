// Run markers for the live IM harness.
//
// A marker is the only thing that ties four independent observations together:
// the message the driver posted, the prompt the model fixture saw, the reply
// the target bot sent back, and the row in the evidence file. It therefore has
// to be unpredictable — a predictable marker lets a stale message left over
// from an earlier run satisfy this run's assertion, which is exactly the class
// of false green this harness exists to prevent.
//
// Shape: `cognia-e2e:<platform>:<runId>:turn-<n>`
//
// `MARKER_RE` is kept byte-identical to `LIVE_MARKER_RE` in
// `tests/e2e/mocks/anthropic/server.ts` — the fixture scans prompts with its
// copy, this module scans platform replies with this one, and a divergence
// would make the two halves of the same assertion disagree silently.

import { randomBytes } from "node:crypto"

/** Global-flagged; callers that reuse it must reset `lastIndex` (see `findMarkers`). */
export const MARKER_RE = /cognia-e2e:[a-z0-9-]+:[0-9a-f]+:turn-\d+/g

const PLATFORM_RE = /^[a-z0-9-]+$/
const RUN_ID_RE = /^[0-9a-f]+$/

/** 16 hex chars = 64 bits of entropy — past any chance of colliding with an old run. */
export function newRunId() {
  return randomBytes(8).toString("hex")
}

/**
 * Build the marker for one turn.
 *
 * Throws on malformed input rather than returning something unmatchable: a
 * marker that `MARKER_RE` cannot match would make every assertion in the run
 * fail with "no marker found", pointing the operator at the platform instead
 * of at the bad argument.
 */
export function buildMarker(platform, runId, turn) {
  if (typeof platform !== "string" || !PLATFORM_RE.test(platform)) {
    throw new TypeError(
      `marker platform must match ${PLATFORM_RE}, got ${JSON.stringify(platform)}`
    )
  }
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new TypeError(`marker runId must match ${RUN_ID_RE}, got ${JSON.stringify(runId)}`)
  }
  if (!Number.isInteger(turn) || turn < 1) {
    throw new TypeError(`marker turn must be a positive integer, got ${JSON.stringify(turn)}`)
  }
  return `cognia-e2e:${platform}:${runId}:turn-${turn}`
}

/** Every distinct marker in `text`, in first-seen order. */
export function findMarkers(text) {
  if (typeof text !== "string" || text === "") return []
  MARKER_RE.lastIndex = 0
  return [...new Set(text.match(MARKER_RE) ?? [])]
}

/**
 * Whether `text` carries this exact marker.
 *
 * Substring, not equality: the reply is the model's echo wrapped in whatever
 * prefix the fixture scenario and the platform's rendering added around it.
 */
export function containsMarker(text, marker) {
  if (typeof text !== "string" || typeof marker !== "string" || marker === "") return false
  return text.includes(marker)
}

/** Markers belonging to this run, ignoring any left by a concurrent one. */
export function markersForRun(text, runId) {
  return findMarkers(text).filter((m) => m.split(":")[2] === runId)
}
