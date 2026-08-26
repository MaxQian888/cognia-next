"use client"

/**
 * The half of a stack that lives on GitHub: opening the pull requests, landing
 * them, and telling their reviewers when a restack moved the commits.
 *
 * Kept apart from {@link useStacks} because the two have different costs. The
 * local half is a handful of `git config` reads and runs every time the panel
 * opens; this half shells out for a credential and then makes one API call per
 * branch. So nothing here happens until the user asks for it — the forge is
 * resolved on the first publish or merge and reused for the rest of the
 * session, and a repository nobody publishes from never pays for any of it.
 *
 * # Push, then publish
 *
 * `publishStack` opens pull requests; it does not push. A pull request for a
 * branch the remote has never seen is rejected, and — worse — a stack that was
 * restacked but not pushed publishes pull requests whose diffs are the old
 * commits. So publishing pushes the whole stack first, with the lease
 * `git_stack_push` applies, and only then walks the layers.
 *
 * # The note is best effort
 *
 * A restack rewrites every layer above the one that moved, which means every
 * reviewer's comments are now attached to commits that no longer exist.
 * {@link restackNoteBody} says so on each pull request. It is never the reason
 * a restack fails: the branches have already moved by the time it runs, and a
 * failed comment must not present itself as a failed restack.
 */

import { useCallback, useRef, useState } from "react"

import { openStackForge, type StackForge } from "@/lib/stack/forge-session"
import type { Stack, StackPullRequest } from "@/lib/stack/model"
import { mergeStack, type MergeStackResult } from "@/lib/stack/merge"
import { attachPullRequests } from "@/lib/stack/discover"
import { publishStack, type PublishStackResult } from "@/lib/stack/publish"
import { restackNoteBody, type RestackAnnouncement } from "@/lib/stack/restack"
import type { GitStackPushOutcome } from "@/types/git"

/** A forge that is anything other than usable. */
export type StackForgeUnavailable = Exclude<StackForge, { status: "ready" }>

export type StackForgeOutcome =
  | { kind: "unavailable"; forge: StackForgeUnavailable }
  | { kind: "published"; result: PublishStackResult; pushed: GitStackPushOutcome }
  | { kind: "merged"; result: MergeStackResult }

export interface UseStackForgeDeps {
  open(repositoryRoot: string): Promise<StackForge>
  push(repositoryRoot: string, remote: string, branches: string[]): Promise<GitStackPushOutcome>
  publish: typeof publishStack
  merge: typeof mergeStack
  attach: typeof attachPullRequests
}

const DEFAULT_DEPS: UseStackForgeDeps = {
  open: (repositoryRoot) => openStackForge(repositoryRoot),
  push: async (repositoryRoot, remote, branches) => {
    const { gitStackPush } = await import("@/lib/git/commands")
    return gitStackPush(repositoryRoot, remote, branches)
  },
  publish: publishStack,
  merge: mergeStack,
  attach: attachPullRequests,
}

export interface UseStackForgeResult {
  /** Null until the first publish or merge asks for one. */
  forge: StackForge | null
  /** Id of the stack currently being published or merged. */
  busy: string | null
  /** Pull request per branch, for every layer anything has looked up. */
  pullRequests: Record<string, StackPullRequest>
  publish: (stack: Stack) => Promise<StackForgeOutcome>
  merge: (stack: Stack) => Promise<StackForgeOutcome>
  /**
   * Leave the restack note on each moved layer's pull request.
   *
   * A no-op when the forge has not been resolved yet, on purpose: a local-only
   * restack must not start authenticating against GitHub behind the user's
   * back. Once anything in this session has published, the notes follow.
   */
  announce: (updates: readonly RestackAnnouncement[]) => Promise<void>
}

/** Stable empty map, so a repository with nothing attached does not re-render. */
const EMPTY_PULL_REQUESTS: Record<string, StackPullRequest> = {}

function branchesOf(stack: Stack): string[] {
  return [...stack.layers]
    .sort((left, right) => left.order - right.order)
    .map((layer) => layer.branch)
}

export function useStackForge(
  repositoryRoot: string | null | undefined,
  deps?: Partial<UseStackForgeDeps>
): UseStackForgeResult {
  const root = repositoryRoot?.trim() ?? ""
  const [busy, setBusy] = useState<string | null>(null)
  // Both pieces of state are stamped with the repository they belong to and
  // read only when it still matches. A different repository is a different
  // forge, a different remote and a different set of pull requests; keeping
  // any of it would publish one repository's stack against another's — and
  // clearing it from an effect costs a cascading render on every open.
  const [session, setSession] = useState<{ root: string; forge: StackForge } | null>(null)
  const [attached, setAttached] = useState<{
    root: string
    pullRequests: Record<string, StackPullRequest>
  }>({ root: "", pullRequests: {} })

  // The resolved forge is also read from a callback that must not re-create
  // itself when it changes — `announce` is handed to a restack already in
  // flight.
  const forgeRef = useRef<{ root: string; forge: StackForge } | null>(null)
  const pendingRef = useRef<{ root: string; promise: Promise<StackForge> } | null>(null)

  const forge = session?.root === root ? session.forge : null
  const pullRequests = attached.root === root ? attached.pullRequests : EMPTY_PULL_REQUESTS

  const ensure = useCallback(async (): Promise<StackForge | null> => {
    if (!root) return null
    if (forgeRef.current?.root === root) return forgeRef.current.forge
    const resolved: UseStackForgeDeps = { ...DEFAULT_DEPS, ...deps }
    // One resolution at a time: two buttons pressed together would otherwise
    // each shell out for a credential.
    if (pendingRef.current?.root !== root) {
      pendingRef.current = { root, promise: resolved.open(root) }
    }
    const inflight = pendingRef.current
    let opened: StackForge
    try {
      opened = await inflight.promise
    } finally {
      if (pendingRef.current === inflight) pendingRef.current = null
    }
    forgeRef.current = { root, forge: opened }
    setSession({ root, forge: opened })
    return opened
  }, [root, deps])

  const remember = useCallback(
    (found: Record<string, StackPullRequest>) => {
      setAttached((previous) =>
        previous.root === root
          ? { root, pullRequests: { ...previous.pullRequests, ...found } }
          : { root, pullRequests: found }
      )
    },
    [root]
  )

  const publish = useCallback(
    async (stack: Stack): Promise<StackForgeOutcome> => {
      const opened = await ensure()
      if (!opened) return { kind: "unavailable", forge: { status: "noRemote" } }
      if (opened.status !== "ready") return { kind: "unavailable", forge: opened }
      setBusy(stack.id)
      try {
        const resolved: UseStackForgeDeps = { ...DEFAULT_DEPS, ...deps }
        const pushed = await resolved.push(root, opened.remote, branchesOf(stack))
        const result = await resolved.publish({
          stack,
          repository: opened.repository,
          adapter: opened.adapter,
        })
        if (result.status === "published") {
          remember(
            Object.fromEntries(
              result.layers.map((entry) => [entry.layer.branch, entry.pullRequest])
            )
          )
        }
        return { kind: "published", result, pushed }
      } finally {
        setBusy(null)
      }
    },
    [ensure, root, deps, remember]
  )

  const merge = useCallback(
    async (stack: Stack): Promise<StackForgeOutcome> => {
      const opened = await ensure()
      if (!opened) return { kind: "unavailable", forge: { status: "noRemote" } }
      if (opened.status !== "ready") return { kind: "unavailable", forge: opened }
      setBusy(stack.id)
      try {
        const resolved: UseStackForgeDeps = { ...DEFAULT_DEPS, ...deps }
        // Looked up fresh rather than taken from the map: merging acts on
        // whichever pull request is open right now, and a number cached from
        // earlier in the session outlives somebody closing it.
        const withPulls = await resolved.attach(stack, opened.repository, opened.adapter)
        remember(
          Object.fromEntries(
            withPulls.layers
              .filter((layer) => layer.pullRequest)
              .map((layer) => [layer.branch, layer.pullRequest!])
          )
        )
        const result = await resolved.merge({
          stack: withPulls,
          repository: opened.repository,
          adapter: opened.adapter,
          remote: opened.remote,
        })
        return { kind: "merged", result }
      } finally {
        setBusy(null)
      }
    },
    [ensure, deps, remember]
  )

  const announce = useCallback(
    async (updates: readonly RestackAnnouncement[]) => {
      const current = forgeRef.current
      if (current?.root !== root) return
      const opened = current.forge
      if (opened.status !== "ready") return
      for (const update of updates) {
        const pullRequest = pullRequests[update.branch]
        if (!pullRequest) continue
        // Per pull request, and only its own move: the note opens with "this
        // branch", and pasting every layer's line onto every layer turns one
        // useful sentence into four.
        await opened.adapter
          .comment(opened.repository, pullRequest.number, restackNoteBody([update]))
          .catch(() => {})
      }
    },
    [root, pullRequests]
  )

  return { forge, busy, pullRequests, publish, merge, announce }
}
