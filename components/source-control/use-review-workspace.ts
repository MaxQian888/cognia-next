"use client"

/**
 * State and actions behind the unified review sheet.
 *
 * Extracted from the 488-line sheet so the multi-repository rules are testable
 * without rendering, and so the sheet is layout again rather than layout plus a
 * publish pipeline.
 *
 * Three things it does that the inline version could not:
 *
 *  - **Per-repository everything.** Branch, pull request and refs are keyed by
 *    root. The sheet used to collect scope across every selected root and then
 *    run `lookup` / `push` / `create` against `rootDir` alone, so a two-root
 *    review produced one pull request on the primary repository.
 *  - **Lazy hunks.** Listing costs one RPC per root; a file's diff is fetched
 *    when it is opened. Files that already carry a stored comment are loaded up
 *    front regardless — a stored comment on an unopened file would otherwise be
 *    missing from the bundle, silently dropping review someone had written.
 *  - **A delivery, not a boolean.** Publishing returns per-repository legs, so
 *    a failure in one root neither hides the others' success nor forces a retry
 *    that re-posts to them.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { gitStatus } from "@/lib/git/commands"
import { createReviewComment } from "@/lib/review/contracts"
import {
  publishReviewFeedback,
  retryableLegs,
  uncertainLegs,
  type ReviewDeliveryTarget,
} from "@/lib/review/delivery"
import {
  listReviewScopeFiles,
  loadReviewScopeFile,
  type ReviewScopeFileRef,
  type ReviewScopeRequest,
  type ReviewScopedHunk,
  type UnavailableReviewRoot,
} from "@/lib/review/scope"
import { useDiffReviewStore } from "@/stores/git/diff-review-store"
import type {
  PullRequestProvider,
  PullRequestRef,
  ReviewDelivery,
  ReviewFeedbackBundle,
  ReviewRepositoryRefs,
  ReviewScope,
} from "@/types/review"

export type AuthState = "authenticated" | "unauthenticated" | "unavailable"

export interface ReviewRootState {
  repositoryRoot: string
  branch: string | null
  pullRequest: PullRequestRef | null
  refs: ReviewRepositoryRefs
}

export function reviewFileKey(
  file: Pick<ReviewScopeFileRef, "repositoryRoot" | "path" | "staged">
): string {
  return `${file.repositoryRoot}\n${file.path}\n${Boolean(file.staged)}`
}

export function reviewHunkKey(file: ReviewScopeFileRef, hunk: ReviewScopedHunk): string {
  return `${reviewFileKey(file)}\n${hunk.hunkHash}\n${hunk.index}`
}

/**
 * A hunk whose content hash appears once in its file.
 *
 * A comment is anchored by content, so a hash that appears twice cannot be
 * placed — `remapReviewComment` marks that case stale rather than guessing, and
 * the composer refuses to author one in the first place.
 */
export function isUniqueHunk(hunks: readonly ReviewScopedHunk[], hunk: ReviewScopedHunk): boolean {
  return hunks.filter((candidate) => candidate.hunkHash === hunk.hunkHash).length === 1
}

export interface UseReviewWorkspaceOptions {
  rootDir: string
  repositoryRoots: string[]
  lastTurnRunIdByRoot?: Record<string, string>
  provider: PullRequestProvider
  open: boolean
}

export function useReviewWorkspace(options: UseReviewWorkspaceOptions) {
  const { provider, repositoryRoots, rootDir, lastTurnRunIdByRoot, open } = options

  const [scope, setScope] = useState<ReviewScope>("uncommitted")
  const [selectedRoots, setSelectedRoots] = useState<Set<string>>(
    () => new Set(repositoryRoots.length > 0 ? repositoryRoots : [rootDir])
  )
  const [roots, setRoots] = useState<Record<string, ReviewRootState>>({})
  const [files, setFiles] = useState<ReviewScopeFileRef[]>([])
  const [hunksByFile, setHunksByFile] = useState<Record<string, ReviewScopedHunk[]>>({})
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [comments, setComments] = useState<Record<string, string>>({})
  const [staleCommentCount, setStaleCommentCount] = useState(0)
  const [unavailableRoots, setUnavailableRoots] = useState<UnavailableReviewRoot[]>([])
  const [summary, setSummary] = useState("")
  const [auth, setAuth] = useState<AuthState>("unavailable")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [delivery, setDelivery] = useState<ReviewDelivery | null>(null)
  const setStoredComment = useDiffReviewStore((state) => state.setComment)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void provider.getAuthenticationState().then((state) => {
      if (!cancelled) setAuth(state)
    })
    return () => {
      cancelled = true
    }
  }, [open, provider])

  const rootState = useCallback(
    (repositoryRoot: string): ReviewRootState =>
      roots[repositoryRoot] ?? {
        repositoryRoot,
        branch: null,
        pullRequest: null,
        refs: {
          ...(lastTurnRunIdByRoot?.[repositoryRoot]
            ? { lastTurnRunId: lastTurnRunIdByRoot[repositoryRoot] }
            : {}),
        },
      },
    [roots, lastTurnRunIdByRoot]
  )

  const patchRoot = useCallback((repositoryRoot: string, patch: Partial<ReviewRootState>) => {
    setRoots((current) => {
      const existing = current[repositoryRoot] ?? {
        repositoryRoot,
        branch: null,
        pullRequest: null,
        refs: {},
      }
      return { ...current, [repositoryRoot]: { ...existing, ...patch } }
    })
  }, [])

  const setRootRefs = useCallback((repositoryRoot: string, refs: Partial<ReviewRepositoryRefs>) => {
    setRoots((current) => {
      const existing = current[repositoryRoot] ?? {
        repositoryRoot,
        branch: null,
        pullRequest: null,
        refs: {},
      }
      return {
        ...current,
        [repositoryRoot]: { ...existing, refs: { ...existing.refs, ...refs } },
      }
    })
  }, [])

  const toggleRoot = useCallback((repositoryRoot: string, on: boolean) => {
    setSelectedRoots((current) => {
      const next = new Set(current)
      if (on) next.add(repositoryRoot)
      else next.delete(repositoryRoot)
      return next
    })
  }, [])

  const toggleFile = useCallback((key: string, on: boolean) => {
    setSelectedFiles((current) => {
      const next = new Set(current)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const scopeRequest = useMemo((): ReviewScopeRequest => {
    const selected = [...selectedRoots]
    return {
      scope,
      repositoryRoots: selected,
      refsByRoot: Object.fromEntries(
        selected.map((repositoryRoot) => {
          const state = rootState(repositoryRoot)
          return [
            repositoryRoot,
            {
              ...state.refs,
              ...(lastTurnRunIdByRoot?.[repositoryRoot] && !state.refs.lastTurnRunId
                ? { lastTurnRunId: lastTurnRunIdByRoot[repositoryRoot] }
                : {}),
            },
          ]
        })
      ),
    }
  }, [scope, selectedRoots, rootState, lastTurnRunIdByRoot])

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * Read one file's hunks and re-attach any comment stored against them.
   *
   * Returns the count of stored comments that could not be placed: their hunk
   * is gone, or its content now appears more than once. Those are reported, not
   * silently dropped.
   */
  const loadFileInternal = useCallback(
    async (
      request: ReviewScopeRequest,
      ref: ReviewScopeFileRef
    ): Promise<{ hunks: ReviewScopedHunk[]; stored: Record<string, string>; stale: number }> => {
      const loaded = await loadReviewScopeFile(request, ref)
      const stored: Record<string, string> = {}
      let stale = 0
      const decisions = useDiffReviewStore
        .getState()
        .getFileDecisions(ref.repositoryRoot, ref.reviewKey)
      for (const decision of decisions) {
        if (!decision.comment?.trim()) continue
        const matches = loaded.hunks.filter((hunk) => hunk.hunkHash === decision.hash)
        if (matches.length !== 1) {
          stale += 1
          continue
        }
        stored[reviewHunkKey(ref, matches[0])] = decision.comment
      }
      return { hunks: loaded.hunks, stored, stale }
    },
    []
  )

  const loadFile = useCallback(
    (ref: ReviewScopeFileRef) =>
      run(async () => {
        const key = reviewFileKey(ref)
        const { hunks, stored, stale } = await loadFileInternal(scopeRequest, ref)
        setHunksByFile((current) => ({ ...current, [key]: hunks }))
        setComments((current) => ({ ...stored, ...current }))
        if (stale > 0) setStaleCommentCount((current) => current + stale)
      }),
    [run, scopeRequest, loadFileInternal]
  )

  const loadScope = useCallback(
    () =>
      run(async () => {
        const request = scopeRequest
        const listing = await listReviewScopeFiles(request)
        const refs = listing.files
        setFiles(refs)
        setUnavailableRoots(listing.unavailable)
        setSelectedFiles(new Set(refs.map(reviewFileKey)))
        setDelivery(null)

        // A file the user already commented on MUST be loaded now: its comments
        // reach the bundle only through the hunks, so leaving it collapsed would
        // quietly drop review that was already written.
        const store = useDiffReviewStore.getState()
        const withStoredComments = refs.filter((ref) =>
          store
            .getFileDecisions(ref.repositoryRoot, ref.reviewKey)
            .some((decision) => Boolean(decision.comment?.trim()))
        )
        const loaded = await Promise.all(
          withStoredComments.map(async (ref) => ({
            key: reviewFileKey(ref),
            ...(await loadFileInternal(request, ref)),
          }))
        )
        const nextHunks: Record<string, ReviewScopedHunk[]> = {}
        const nextComments: Record<string, string> = {}
        let stale = 0
        for (const entry of loaded) {
          nextHunks[entry.key] = entry.hunks
          Object.assign(nextComments, entry.stored)
          stale += entry.stale
        }
        // Refs that already carried their hunks (Task Workspace patch sets) cost
        // nothing to keep, so keep them all rather than re-reading on expand.
        for (const ref of refs) {
          if (ref.hunks) nextHunks[reviewFileKey(ref)] ??= ref.hunks
        }
        setHunksByFile(nextHunks)
        setComments(nextComments)
        setStaleCommentCount(stale)
      }),
    [run, scopeRequest, loadFileInternal]
  )

  const setComment = useCallback(
    (ref: ReviewScopeFileRef, hunk: ReviewScopedHunk, value: string) => {
      setComments((current) => ({ ...current, [reviewHunkKey(ref, hunk)]: value }))
      setStoredComment(ref.repositoryRoot, ref.reviewKey, hunk.index, hunk.hunkHash, value)
    },
    [setStoredComment]
  )

  const buildBundle = useCallback(async (): Promise<ReviewFeedbackBundle> => {
    const now = Date.now()
    const authored = await Promise.all(
      files.flatMap((ref) => {
        const key = reviewFileKey(ref)
        if (!selectedFiles.has(key)) return []
        const hunks = hunksByFile[key] ?? []
        return hunks.flatMap((hunk) => {
          const body = comments[reviewHunkKey(ref, hunk)]?.trim()
          if (!body || !isUniqueHunk(hunks, hunk)) return []
          const commitSha = rootState(ref.repositoryRoot).refs.commitSha
          return [
            createReviewComment({
              anchor: {
                repositoryRoot: ref.repositoryRoot,
                path: ref.path,
                hunkHash: hunk.hunkHash,
                side: hunk.side,
                line: hunk.line,
                ...(scope === "commit" && commitSha ? { commitSha } : {}),
              },
              body,
              createdAt: now,
            }),
          ]
        })
      })
    )
    return {
      id: `review-feedback:${crypto.randomUUID()}`,
      sessionId: "source-control",
      scope,
      repositoryRoots: [...selectedRoots],
      comments: authored,
      summary,
      state: "draft",
      createdAt: now,
      updatedAt: now,
    }
  }, [files, selectedFiles, hunksByFile, comments, scope, selectedRoots, summary, rootState])

  const lookupAll = useCallback(
    () =>
      run(async () => {
        for (const repositoryRoot of selectedRoots) {
          // Each repository has its own checked-out branch; the primary root's
          // branch is not a fact about any of the others.
          const status = await gitStatus(repositoryRoot)
          const branch = status.branch
          const pullRequest = branch ? await provider.findForBranch(repositoryRoot, branch) : null
          patchRoot(repositoryRoot, { branch, pullRequest })
        }
      }),
    [run, selectedRoots, provider, patchRoot]
  )

  const pushRoot = useCallback(
    (repositoryRoot: string) =>
      run(async () => {
        const branch = rootState(repositoryRoot).branch ?? (await gitStatus(repositoryRoot)).branch
        if (!branch) throw new Error(`The current branch is unavailable for ${repositoryRoot}`)
        await provider.push(repositoryRoot, branch)
        patchRoot(repositoryRoot, { branch })
      }),
    [run, provider, rootState, patchRoot]
  )

  const createFor = useCallback(
    (repositoryRoot: string, input: { title: string; body: string; draft: boolean }) =>
      run(async () => {
        const state = rootState(repositoryRoot)
        const branch = state.branch ?? (await gitStatus(repositoryRoot)).branch
        if (!branch) throw new Error(`The current branch is unavailable for ${repositoryRoot}`)
        await provider.push(repositoryRoot, branch)
        const pullRequest = await provider.create({
          repositoryRoot,
          headRef: branch,
          baseRef: state.refs.baseRef ?? "main",
          title: input.title,
          body: input.body,
          draft: input.draft,
        })
        patchRoot(repositoryRoot, { branch, pullRequest })
      }),
    [run, provider, rootState, patchRoot]
  )

  const targets = useCallback((): ReviewDeliveryTarget[] => {
    return [...selectedRoots].flatMap((repositoryRoot) => {
      const pullRequest = rootState(repositoryRoot).pullRequest
      return pullRequest ? [{ repositoryRoot, pullRequest }] : []
    })
  }, [selectedRoots, rootState])

  const publish = useCallback(
    (options: { retry?: boolean } = {}) =>
      run(async () => {
        const bundle = await buildBundle()
        const result = await publishReviewFeedback({
          provider,
          bundle,
          targets: targets(),
          ...(options.retry && delivery ? { previous: delivery } : {}),
        })
        setDelivery(result)
      }),
    [run, buildBundle, provider, targets, delivery]
  )

  return {
    scope,
    setScope,
    selectedRoots,
    toggleRoot,
    rootState,
    setRootRefs,
    files,
    hunksByFile,
    loadFile,
    loadScope,
    selectedFiles,
    toggleFile,
    comments,
    setComment,
    staleCommentCount,
    unavailableRoots,
    summary,
    setSummary,
    auth,
    busy,
    error,
    delivery,
    failedLegs: delivery ? retryableLegs(delivery) : [],
    uncertain: delivery ? uncertainLegs(delivery) : [],
    lookupAll,
    pushRoot,
    createFor,
    publish,
  }
}

export type ReviewWorkspace = ReturnType<typeof useReviewWorkspace>
