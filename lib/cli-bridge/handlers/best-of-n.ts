/**
 * Renderer handler for the CLI bridge's best-of-N route
 * (`POST /api/dev/best-of-n/{action}`).
 *
 * Fan-out, exact-head checks and integration run in the desktop renderer, so
 * the CLI drives them here; reads come from the Host ledger. Select and
 * publish only run for a CLI that confirmed on an interactive terminal, and
 * even then the Host's own native approval decides: no field here can assert
 * that a person chose the winner.
 */

import type { BestOfNGroup } from "@/types/best-of-n"
import type { BestOfNPublicCandidate, BestOfNPublicRun } from "@/lib/best-of-n/public-run"

export type BestOfNCliAction =
  "list" | "status" | "start" | "cancel" | "select" | "publish" | "archive"

export type BestOfNCliCandidate = BestOfNPublicCandidate
export type BestOfNCliRun = BestOfNPublicRun

export type BestOfNCliResult =
  | { ok: true; runs: BestOfNCliRun[] }
  | {
      ok: true
      run: BestOfNCliRun
      checks?: Array<{ profileId: string; outcome: string; headSha: string }>
      requiredChecks?: string[]
      outcome?: { kind: string; reason?: string; message?: string }
      archiveError?: string | null
      releaseError?: string | null
    }
  | { ok: false; error: string }

const string = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null)

export async function projectCliRun(group: BestOfNGroup): Promise<BestOfNCliRun> {
  const { toPublicBestOfNRun } = await import("@/lib/best-of-n/public-run")
  return toPublicBestOfNRun(group)
}

function candidateId(group: BestOfNGroup, raw: unknown): string | null {
  const wanted = typeof raw === "number" ? String(raw) : string(raw)
  return (
    group.candidates.find(
      (candidate) => candidate.candidateId === wanted || String(candidate.index + 1) === wanted
    )?.candidateId ?? null
  )
}

export async function bestOfNCli(payload: Record<string, unknown>): Promise<BestOfNCliResult> {
  const action = payload.action as BestOfNCliAction
  try {
    const { createBestOfNHost } = await import("@/lib/best-of-n/host")
    const host = createBestOfNHost()
    if (action === "list") {
      const groups = await host.list()
      return {
        ok: true,
        runs: await Promise.all(
          [...groups].sort((a, b) => b.createdAt - a.createdAt).map(projectCliRun)
        ),
      }
    }
    if (action === "start") {
      const sessionId = string(payload.sessionId)
      const prompt = string(payload.prompt)
      if (!sessionId || !prompt)
        return { ok: false, error: "start requires a sessionId and prompt" }
      const agents = Array.isArray(payload.agents)
        ? payload.agents.filter((item): item is string => typeof item === "string")
        : undefined
      const n = typeof payload.n === "number" ? payload.n : (agents?.length ?? 2)
      if (![2, 3, 4].includes(n)) return { ok: false, error: "best-of-N runs 2–4 attempts" }
      const { prepareBestOfNChat, startPreparedBestOfN } = await import("@/lib/best-of-n/entry")
      const prepared = await prepareBestOfNChat(sessionId, prompt, n as 2 | 3 | 4, agents)
      const branch = string(payload.existingBranch)
      // An existing branch moves only when named explicitly, and only a local one.
      if (branch && !prepared.branches.includes(branch))
        return { ok: false, error: `no local branch named ${branch}` }
      const group = await startPreparedBestOfN(
        prepared,
        branch
          ? { targetRef: branch, targetIsNew: false }
          : { targetRef: string(payload.targetRef) ?? prepared.targetRef, targetIsNew: true }
      )
      return { ok: true, run: await projectCliRun(group) }
    }
    const groupId = string(payload.groupId)
    if (!groupId) return { ok: false, error: `${action} requires a groupId` }
    if (action === "status") return { ok: true, run: await projectCliRun(await host.get(groupId)) }
    if (action === "cancel") {
      const { cancelBestOfN } = await import("@/lib/best-of-n/service")
      return { ok: true, run: await projectCliRun(await cancelBestOfN(groupId)) }
    }
    if (action === "archive") {
      const { archiveBestOfN } = await import("@/lib/best-of-n/publication")
      const result = await archiveBestOfN(groupId)
      return { ok: true, run: await projectCliRun(result.group), archiveError: result.archiveError }
    }
    if (action === "select" || action === "publish") {
      if (payload.confirmedOnTty !== true)
        return {
          ok: false,
          error: `${action} requires confirmation on an interactive terminal`,
        }
      const publication = await import("@/lib/best-of-n/publication")
      if (action === "select") {
        const id = candidateId(await host.get(groupId), payload.candidate)
        if (!id) return { ok: false, error: "no such candidate in this run" }
        const result = await publication.pickBestOfNCandidate(groupId, id)
        return {
          ok: true,
          run: await projectCliRun(result.group),
          checks: result.checks.map(({ profileId, outcome, headSha }) => ({
            profileId,
            outcome,
            headSha,
          })),
          requiredChecks: result.requiredChecks,
        }
      }
      const result = await publication.publishBestOfNCandidate(groupId)
      return {
        ok: true,
        run: await projectCliRun(result.group),
        outcome: {
          kind: result.outcome.kind,
          ...(result.outcome.reason ? { reason: result.outcome.reason } : {}),
          ...(result.outcome.message ? { message: result.outcome.message } : {}),
        },
        archiveError: result.archiveError,
        releaseError: result.releaseError,
      }
    }
    return { ok: false, error: `unknown best-of-N action: ${String(action)}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
