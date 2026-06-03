/**
 * Pure commit-graph lane-assignment — the layout engine behind the Commit
 * Graph view. Render-agnostic (no React/DOM): it turns a time-ordered
 * `GitCommit[]` + ref list into per-row lane/edge geometry the SVG renderer
 * draws directly.
 *
 * The algorithm is the standard single forward pass used by git-graph /
 * vscode-git-graph: maintain a list of "active lanes", each holding the commit
 * hash that lane is currently waiting to draw next (a parent). For each commit
 * (newest→oldest): it occupies the lane reserved for it (or the leftmost free
 * lane if it is a tip); its first parent continues that lane; extra parents
 * (merges) open new lanes; lanes whose branch has ended close.
 *
 * `color` fields carry the raw lane index — the renderer maps it through the
 * theme palette (`lib/git/lane-palette`) with a modulo, so this stays free of
 * any color concern.
 */

import type { CommitGraphLayout, GitCommit, GitRef, GraphEdge, GraphRow } from "@/types/git"

function firstFreeLane(lanes: (string | null)[]): number {
  const idx = lanes.indexOf(null)
  return idx === -1 ? lanes.length : idx
}

/** Highest occupied lane index + 1, ignoring trailing empty lanes. */
function occupiedWidth(lanes: (string | null)[]): number {
  let width = 0
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] !== null) width = i + 1
  }
  return width
}

export function assignLanes(commits: GitCommit[], refs: GitRef[] = []): CommitGraphLayout {
  const refsByHash = new Map<string, GitRef[]>()
  for (const ref of refs) {
    const list = refsByHash.get(ref.targetHash)
    if (list) list.push(ref)
    else refsByHash.set(ref.targetHash, [ref])
  }

  // lanes[i] = hash lane i currently expects to render next (or null = free).
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  let laneCount = 0

  for (const commit of commits) {
    // 1. Find the lane reserved for this commit; if none, it's a tip → take
    //    the leftmost free lane.
    let myLane = lanes.indexOf(commit.hash)
    if (myLane === -1) {
      myLane = firstFreeLane(lanes)
      lanes[myLane] = commit.hash
    }

    // Snapshot lane occupancy at the TOP of this row's band (commit at myLane,
    // every other lane holding the parent it's still waiting for).
    const topLanes = lanes.slice()

    // 2. Reserve lanes for parents. First parent continues myLane; extra
    //    parents reuse an existing lane that already expects them (shared
    //    ancestor → fork closes a lane) or open the leftmost free lane.
    const parents = commit.parents
    if (parents.length === 0) {
      lanes[myLane] = null
    } else {
      // First parent: continue this lane UNLESS another lane already expects it
      // (a shared ancestor) — then this lane closes and merges into that lane.
      // `lanes[myLane]` still holds commit.hash here, so indexOf can't return
      // myLane spuriously.
      const firstExisting = lanes.indexOf(parents[0])
      lanes[myLane] = firstExisting !== -1 ? null : parents[0]
      // Extra parents (merges): reuse a lane already expecting them, else open
      // the leftmost free lane.
      for (let i = 1; i < parents.length; i++) {
        const p = parents[i]
        if (lanes.indexOf(p) === -1) {
          lanes[firstFreeLane(lanes)] = p
        }
      }
    }

    const bottomLanes = lanes.slice()

    // 3. Edges crossing this row's band. The commit node (myLane) connects down
    //    to wherever each of its parents now lives; every other occupied lane
    //    is a branch line passing straight through.
    const edges: GraphEdge[] = []
    const width = Math.max(topLanes.length, bottomLanes.length)
    for (let lane = 0; lane < width; lane++) {
      const topHash = topLanes[lane]
      if (topHash == null) continue
      if (lane === myLane) {
        for (const p of parents) {
          const toLane = bottomLanes.indexOf(p)
          if (toLane !== -1) edges.push({ fromLane: myLane, toLane, color: toLane })
        }
      } else {
        const toLane = bottomLanes.indexOf(topHash)
        if (toLane !== -1) edges.push({ fromLane: lane, toLane, color: toLane })
      }
    }

    rows.push({
      commit,
      lane: myLane,
      color: myLane,
      edges,
      refs: refsByHash.get(commit.hash) ?? [],
    })

    laneCount = Math.max(laneCount, myLane + 1, occupiedWidth(topLanes), occupiedWidth(bottomLanes))
  }

  return { rows, laneCount }
}
