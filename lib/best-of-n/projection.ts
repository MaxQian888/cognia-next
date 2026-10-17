import { getDb } from "@/lib/db/schema"
import { isTauri } from "@/lib/platform/detect"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { createScmHost, type ScmHost } from "@/lib/scm/host"
import type {
  BestOfNDeviceRole,
  BestOfNGroup,
  BestOfNRunMetadata,
  BestOfNRunSummary,
} from "@/types/best-of-n"
import { createBestOfNHost, type BestOfNHost } from "./host"

/** Paired devices render synced summaries; only the executing Host offers mutations. */
export function canManageBestOfNRuns(): boolean {
  return isTauri() && !isRemoteHostActive()
}

/** See {@link BestOfNDeviceRole}: a paired observer can only watch and ask to stop. */
export function bestOfNDeviceRole(): BestOfNDeviceRole {
  return canManageBestOfNRuns() ? "host" : "pairedObserver"
}

/** A late poll cannot roll back a newer ledger version or erase its chat binding. */
export async function projectBestOfNGroup(
  group: BestOfNGroup,
  metadata: BestOfNRunMetadata = {}
): Promise<BestOfNRunSummary> {
  const db = getDb()
  return db.transaction("rw", db.bestOfNRuns, db.messages, db.sessions, async () => {
    const previous = await db.bestOfNRuns.get(group.groupId)
    const current = previous && previous.group.version > group.version ? previous.group : group
    const freshMetadata = { ...metadata }
    if (current !== group) {
      delete freshMetadata.candidateChangesets
      delete freshMetadata.summaries
    }
    // Entry points use the parent assistant's id as the idempotency request id,
    // so rebuilding the disposable table also recovers the visible chat slot.
    const message = await db.messages.get(current.requestId)
    const child = current.candidates[0]
      ? await db.sessions.get(current.candidates[0].childSessionId)
      : undefined
    const binding: BestOfNRunMetadata = {
      ...(child?.projectId ? { projectId: child.projectId } : {}),
      ...(message?.role === "assistant"
        ? { parentMessageId: message.id, parentSessionId: message.sessionId }
        : {}),
      ...previous,
      ...Object.fromEntries(
        Object.entries(freshMetadata).filter(([, value]) => value !== undefined)
      ),
    }
    if (binding.candidateChangesets) {
      binding.candidateChangesets = Object.fromEntries(
        current.candidates.flatMap((candidate) => {
          const incoming = binding.candidateChangesets?.[candidate.candidateId]
          const retained = previous?.candidateChangesets?.[candidate.candidateId]
          const exact = [incoming, retained]
            .filter(
              (changeset) =>
                changeset &&
                changeset.headSha === candidate.headSha &&
                changeset.changesetId === candidate.changesetId
            )
            .sort((a, b) => b!.version - a!.version)[0]
          return exact ? [[candidate.candidateId, exact]] : []
        })
      )
    }
    const row: BestOfNRunSummary = {
      ...binding,
      id: group.groupId,
      group: current,
      updatedAt: Math.max(Date.now(), current.updatedAt, (previous?.updatedAt ?? 0) + 1),
    }
    if (
      previous &&
      JSON.stringify({ ...row, updatedAt: previous.updatedAt }) === JSON.stringify(previous)
    ) {
      return previous
    }
    // Companion has one watermark for the entire table. A burst on one group
    // must not advance it past a different group's write in the same millisecond.
    const newest = await db.bestOfNRuns.orderBy("updatedAt").last()
    row.updatedAt = Math.max(row.updatedAt, (newest?.updatedAt ?? 0) + 1)
    await db.bestOfNRuns.put(row)
    return row
  })
}

export function getBestOfNRun(groupId: string): Promise<BestOfNRunSummary | undefined> {
  return getDb().bestOfNRuns.get(groupId)
}

export function getBestOfNRunForMessage(parentMessageId: string) {
  return getDb().bestOfNRuns.where("parentMessageId").equals(parentMessageId).first()
}

export async function listBestOfNRuns(parentSessionId: string) {
  const rows = await getDb().bestOfNRuns.where("parentSessionId").equals(parentSessionId).toArray()
  return rows.sort((a, b) => b.group.createdAt - a.group.createdAt)
}

export async function refreshBestOfNRun(
  groupId: string,
  host: Pick<BestOfNHost, "get"> = createBestOfNHost(),
  scm: Pick<ScmHost, "getChangeset"> = createScmHost()
) {
  return projectBestOfNGroupWithEvidence(await host.get(groupId), scm)
}

async function projectBestOfNGroupWithEvidence(
  group: BestOfNGroup,
  scm: Pick<ScmHost, "getChangeset">
) {
  const candidateChangesets: NonNullable<BestOfNRunMetadata["candidateChangesets"]> = {}
  const summaries: Record<string, string> = {}
  const requiredChecks = new Set<string>()
  for (const candidate of group.candidates) {
    if (candidate.changesetId) {
      const changeset = await scm.getChangeset(candidate.changesetId)
      if (changeset && changeset.headSha === candidate.headSha) {
        candidateChangesets[candidate.candidateId] = changeset
        for (const check of changeset.requiredChecks) requiredChecks.add(check)
      }
    }
    const messages = await getDb()
      .messages.where("sessionId")
      .equals(candidate.childSessionId)
      .sortBy("createdAt")
    const lastReply = messages.filter((message) => message.role === "assistant").at(-1)
    if (lastReply)
      summaries[candidate.candidateId] = lastReply.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
  }
  return projectBestOfNGroup(group, {
    candidateChangesets,
    summaries,
    ...(requiredChecks.size ? { requiredChecks: [...requiredChecks] } : {}),
  })
}

/** Never deletes rows: the Host ledger retains groups, including archived groups. */
export async function rebuildBestOfNRunSummaries(
  host: Pick<BestOfNHost, "list"> = createBestOfNHost(),
  scm: Pick<ScmHost, "getChangeset"> = createScmHost()
) {
  const groups = await host.list()
  const rows: BestOfNRunSummary[] = []
  for (const group of groups) rows.push(await projectBestOfNGroupWithEvidence(group, scm))
  return rows
}
