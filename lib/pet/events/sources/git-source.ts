// Source Control operations → pet events. The adapter observes only the Git
// store's operation/error slices, aggregates concurrent operations into one
// busy batch, and never forwards repository paths or error text.

import { useGitStore, type GitOp, type GitState } from "@/stores/git/git-store"
import type { PetEmit } from "../pet-event-bus"

const PET_GIT_OPS: readonly GitOp[] = [
  "commit",
  "push",
  "pull",
  "fetch",
  "sync",
  "stage",
  "unstage",
  "checkout",
  "stash",
  "discard",
  "restore",
  "resolve",
  "branch",
  "remote",
  "tag",
  "reset",
  "sequence",
  "ignore",
]

const MILESTONE_OPS = new Set<GitOp>(["commit", "push", "pull", "sync"])

export interface GitActivitySnapshot {
  activeOps: readonly GitOp[]
  failedOp: GitOp | null
}

export interface GitSourceDeps {
  subscribe?: (listener: () => void) => () => void
  getSnapshot?: () => GitActivitySnapshot
}

function snapshotFromState(state: GitState): GitActivitySnapshot {
  return {
    activeOps: PET_GIT_OPS.filter((op) => state.ops[op]),
    failedOp:
      state.lastError && PET_GIT_OPS.includes(state.lastError.op) ? state.lastError.op : null,
  }
}

function defaultSnapshot(): GitActivitySnapshot {
  return snapshotFromState(useGitStore.getState())
}

function defaultSubscribe(listener: () => void): () => void {
  return useGitStore.subscribe((state, previous) => {
    if (state.ops === previous.ops && state.lastError === previous.lastError) return
    listener()
  })
}

export function createGitSource(deps: GitSourceDeps = {}): (emit: PetEmit) => () => void {
  const subscribe = deps.subscribe ?? defaultSubscribe
  const getSnapshot = deps.getSnapshot ?? defaultSnapshot

  return (emit) => {
    const initial = getSnapshot()
    let wasBusy = initial.activeOps.length > 0
    let batchOps = new Set(initial.activeOps)
    let batchFailedOp: GitOp | null = null
    let lastOp = initial.activeOps.at(-1) ?? null

    const sync = () => {
      const { activeOps, failedOp } = getSnapshot()
      const busy = activeOps.length > 0

      if (!wasBusy && busy) {
        batchOps = new Set(activeOps)
        // useGitActions raises the op flag before clearing the previous error,
        // so an error visible on this rising edge belongs to the prior batch.
        batchFailedOp = null
        lastOp = activeOps.at(-1) ?? null
        wasBusy = true
        emit({
          source: "source-control",
          kind: "thinking",
          xp: 0,
          meta: { activeCount: activeOps.length, op: lastOp },
        })
        return
      }

      if (wasBusy && busy) {
        for (const op of activeOps) batchOps.add(op)
        if (failedOp && batchOps.has(failedOp)) batchFailedOp = failedOp
        lastOp = activeOps.at(-1) ?? lastOp
        return
      }

      if (!wasBusy || busy) return
      wasBusy = false
      if (failedOp && batchOps.has(failedOp)) batchFailedOp = failedOp
      const op = batchFailedOp ?? lastOp
      const failed = batchFailedOp !== null
      emit({
        source: "source-control",
        kind: failed ? "error" : "success",
        xp: failed ? 0 : [...batchOps].some((candidate) => MILESTONE_OPS.has(candidate)) ? 2 : 0,
        meta: { activeCount: 0, op },
      })
      batchOps.clear()
      batchFailedOp = null
      lastOp = null
    }

    return subscribe(sync)
  }
}

export const wireGitSource = createGitSource()
