// DAG helpers for Claude Code transcripts (ADR-0062 fidelity upgrade).
//
// A `~/.claude/projects/*/…​.jsonl` transcript is NOT a flat list: every record
// carries a `uuid` and a `parentUuid`, forming a forest. Two things create
// branches:
//   • rewind + edit + re-run — the file keeps BOTH the abandoned continuation
//     and the new one, as sibling children of one parent. Read in file order,
//     the abandoned turns interleave into the thread.
//   • Task subagents — their turns are logged inline with `isSidechain: true`,
//     forming their own sub-trees hanging off the spawning main-branch turn.
//
// These helpers resolve both structurally, independent of the message-content
// mapping (they only read `uuid` / `parentUuid` / `isSidechain` / `timestamp`),
// so they're pure and unit-testable with tiny fixtures. Generic over the record
// type so the adapter passes its own `ClaudeLine` through unchanged.

/** The structural fields these helpers need. `ClaudeLine` satisfies this. */
export interface DagNode {
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  timestamp?: string
}

/** One extracted subagent sub-transcript, linearized to its own active leaf. */
export interface SidechainGroup<T extends DagNode> {
  /** Root→leaf records of this subagent run. */
  records: T[]
  /** The sidechain root's own uuid. */
  rootUuid: string
  /**
   * The main-thread record uuid that spawned this run (the sidechain root's
   * `parentUuid` when it points outside the sidechain set). Used to attach the
   * reconstructed `SubagentPart` to the correct spawning assistant turn.
   * Undefined for an orphan sidechain with no back-edge.
   */
  spawnParentUuid?: string
}

function ts(node: DagNode): number {
  if (!node.timestamp) return 0
  const n = Date.parse(node.timestamp)
  return Number.isNaN(n) ? 0 : n
}

/** Index nodes by uuid (last wins on a duplicate id — corrupt transcript). */
function indexById<T extends DagNode>(nodes: T[]): Map<string, T> {
  const byId = new Map<string, T>()
  for (const n of nodes) if (n.uuid) byId.set(n.uuid, n)
  return byId
}

/** Set of uuids that are referenced as some node's parent (i.e. have a child). */
function parentUuids<T extends DagNode>(nodes: T[], byId: Map<string, T>): Set<string> {
  const parents = new Set<string>()
  for (const n of nodes) {
    if (n.parentUuid && byId.has(n.parentUuid)) parents.add(n.parentUuid)
  }
  return parents
}

/**
 * Reduce a forest to the single chain ending at the newest leaf. Finds every
 * leaf (a node no other node claims as parent), picks the one with the latest
 * timestamp (ties broken by file order — later wins), and walks `parentUuid`
 * back to the root, with a visited-set guard so a cyclic/corrupt transcript
 * can't hang. Falls back to the input order when the graph has no leaf (a pure
 * cycle) or no node carries a uuid.
 */
export function linearizeActiveLeaf<T extends DagNode>(nodes: T[]): T[] {
  if (nodes.length === 0) return []
  const byId = indexById(nodes)
  if (byId.size === 0) return [...nodes] // no uuids — nothing to walk

  const parents = parentUuids(nodes, byId)
  const leaves = nodes.filter((n) => n.uuid && !parents.has(n.uuid))
  if (leaves.length === 0) return [...nodes] // pure cycle — degrade gracefully

  let active = leaves[0]
  let activeTs = ts(active)
  for (const leaf of leaves) {
    const t = ts(leaf)
    if (t >= activeTs) {
      active = leaf
      activeTs = t
    }
  }

  const chain: T[] = []
  const visited = new Set<string>()
  let cur: T | undefined = active
  while (cur?.uuid && !visited.has(cur.uuid)) {
    visited.add(cur.uuid)
    chain.push(cur)
    cur = cur.parentUuid ? byId.get(cur.parentUuid) : undefined
  }
  return chain.reverse()
}

/** Partition records into the main thread vs. subagent sidechains. */
export function splitMainAndSidechain<T extends DagNode>(
  nodes: T[]
): { main: T[]; sidechains: T[] } {
  const main: T[] = []
  const sidechains: T[] = []
  for (const n of nodes) {
    if (n.isSidechain) sidechains.push(n)
    else main.push(n)
  }
  return { main, sidechains }
}

/**
 * Group sidechain records into independent subagent runs. A group root is a
 * sidechain record whose `parentUuid` points OUTSIDE the sidechain set (into
 * the main thread, or nowhere). Each group is the connected component under its
 * root, linearized to its own active leaf. O(n) via a prebuilt child adjacency
 * (not the naive O(n²) rescan).
 */
export function extractSidechains<T extends DagNode>(nodes: T[]): SidechainGroup<T>[] {
  const sidechainNodes = nodes.filter((n) => n.isSidechain)
  if (sidechainNodes.length === 0) return []

  const byId = indexById(sidechainNodes)
  const childrenByParent = new Map<string, T[]>()
  for (const n of sidechainNodes) {
    if (n.parentUuid && byId.has(n.parentUuid)) {
      const bucket = childrenByParent.get(n.parentUuid)
      if (bucket) bucket.push(n)
      else childrenByParent.set(n.parentUuid, [n])
    }
  }

  const roots = sidechainNodes.filter((n) => !n.parentUuid || !byId.has(n.parentUuid))
  const groups: SidechainGroup<T>[] = []
  for (const root of roots) {
    if (!root.uuid) continue
    // Collect the connected component under `root` (cycle-guarded).
    const component: T[] = []
    const seen = new Set<string>()
    const stack: T[] = [root]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (!cur?.uuid || seen.has(cur.uuid)) continue
      seen.add(cur.uuid)
      component.push(cur)
      for (const child of childrenByParent.get(cur.uuid) ?? []) stack.push(child)
    }
    groups.push({
      records: linearizeActiveLeaf(component),
      rootUuid: root.uuid,
      spawnParentUuid: typeof root.parentUuid === "string" ? root.parentUuid : undefined,
    })
  }
  // Stable order: by the root's timestamp then uuid.
  groups.sort(
    (a, b) =>
      ts(a.records[0] ?? {}) - ts(b.records[0] ?? {}) || a.rootUuid.localeCompare(b.rootUuid)
  )
  return groups
}
