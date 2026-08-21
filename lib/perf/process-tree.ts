import type { ProcessSample } from "./backend/types"

export interface ProcessTreeNode {
  process: ProcessSample
  children: ProcessTreeNode[]
  orphaned: boolean
}

type ProcessSort = (left: ProcessSample, right: ProcessSample) => number

const defaultSort: ProcessSort = (left, right) =>
  right.cpuPct - left.cpuPct || left.name.localeCompare(right.name) || left.pid - right.pid

function hasAncestor(pid: number, candidate: number, byPid: Map<number, ProcessSample>): boolean {
  const visited = new Set<number>([pid])
  let current = byPid.get(candidate)
  while (current) {
    if (visited.has(current.pid)) return true
    visited.add(current.pid)
    if (current.parentPid === null) return false
    current = byPid.get(current.parentPid)
  }
  return false
}

export function buildProcessTree(
  processes: readonly ProcessSample[],
  sort: ProcessSort = defaultSort
): ProcessTreeNode[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]))
  // Annotated: an inline `children: []` infers as `never[]`, which then rejects
  // the very nodes this loop pushes into it.
  const nodes = new Map<ProcessSample["pid"], ProcessTreeNode>(
    processes.map((process) => [
      process.pid,
      {
        process,
        children: [],
        orphaned: process.parentPid !== null && !byPid.has(process.parentPid),
      },
    ])
  )
  const roots: ProcessTreeNode[] = []
  for (const process of processes) {
    const node = nodes.get(process.pid)!
    const parent = process.parentPid === null ? undefined : nodes.get(process.parentPid)
    if (
      !parent ||
      process.parentPid === process.pid ||
      hasAncestor(process.pid, process.parentPid!, byPid)
    ) {
      node.orphaned = process.parentPid !== null
      roots.push(node)
    } else {
      parent.children.push(node)
    }
  }
  const sortLevel = (level: ProcessTreeNode[]) => {
    level.sort((left, right) => sort(left.process, right.process))
    for (const node of level) sortLevel(node.children)
  }
  sortLevel(roots)
  return roots
}

export function filterProcessTree(
  roots: readonly ProcessTreeNode[],
  query: string
): ProcessTreeNode[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return [...roots]
  return roots.flatMap((node) => {
    const children = filterProcessTree(node.children, normalized)
    const matches =
      node.process.name.toLocaleLowerCase().includes(normalized) ||
      String(node.process.pid).includes(normalized)
    return matches || children.length > 0 ? [{ ...node, children }] : []
  })
}
