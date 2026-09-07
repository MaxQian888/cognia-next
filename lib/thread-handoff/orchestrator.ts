import type { UIMessage } from "ai"
import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"
import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"
import type {
  ThreadHandoffHostRef,
  ThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"
import type { ChatSession } from "@cognia/agent-config-types"
import type { CredentialReference } from "@cognia/provider-types/provider-profile"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { enqueueHostDispatch } from "@/lib/db/host-dispatch-queue"
import { listMessages } from "@/lib/db/messages"
import { listDeploymentProfiles } from "@/lib/db/provider-profiles"
import { conversationToCanonical } from "@/lib/session-import/codec-types"
import { normalizeMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { buildThreadHandoffAttachments, stageRemoteThreadHandoffAttachments } from "./attachments"
import { detectPlatform } from "@/lib/platform/detect"

import { offerThreadHandoff, commitThreadHandoff, type SourceCommitProof } from "./service"
import { ThreadHandoffClient } from "./client"
import { getDb } from "@/lib/db/schema"
import { getThreadHandoffTicket } from "@/lib/db/thread-handoff-tickets"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"

export const THREAD_HANDOFF_OFFER_CHANNEL = "thread-handoff://offer"
export const THREAD_HANDOFF_TTL_MS = 30 * 60_000

export interface ThreadHandoffOfferFrame {
  ticket: ThreadHandoffTicket
  envelope: CanonicalSession
}

export type ThreadHandoffTarget = ThreadHandoffHostRef

function targetTicketFromFrozen(
  frozen: ThreadHandoffTicket,
  actor: string,
  at: number
): ThreadHandoffTicket {
  return {
    ...frozen,
    role: "target",
    state: "preparing",
    history: [{ state: "preparing", at, actor }],
  }
}

async function enqueueThreadHandoffOffer(
  frozen: ThreadHandoffTicket,
  envelope: CanonicalSession,
  now: number
): Promise<void> {
  await enqueueHostDispatch({
    id: frozen.ticketId,
    accountId: getActiveAccountId(),
    domain: "thread-handoff",
    targetRef: frozen.target.hostRef,
    kind: "offer",
    payload: {
      ticket: targetTicketFromFrozen(frozen, frozen.target.hostRef, now),
      envelope,
    },
    idempotencyKey: `thread-handoff:${frozen.ticketId}:offer`,
    expiresAt: frozen.expiresAt,
    now,
  })
}

function credentialRefId(ref: CredentialReference): string {
  switch (ref.kind) {
    case "legacy-provider-settings":
      return `legacy-provider-settings:${ref.providerId}`
    case "subscription-vault":
      return `subscription-vault:${ref.providerId}`
    case "secret-store":
      return `secret-store:${ref.secretId}`
    case "env":
      return `env:${ref.var}`
  }
}

function sourceHostKind(): ThreadHandoffHostRef["kind"] {
  switch (detectPlatform()) {
    case "headless":
      return "cloud"
    case "mobile":
      return "mobile"
    case "tauri":
    case "web":
      return "desktop"
  }
}

export async function buildThreadHandoffOffer(
  session: ChatSession,
  target: ThreadHandoffTarget,
  now = Date.now(),
  dependencies: {
    messages?: readonly UIMessage[]
    deployments?: Awaited<ReturnType<typeof listDeploymentProfiles>>
    ticketId?: string
  } = {}
): Promise<ThreadHandoffOfferFrame> {
  if (session.collaboration) {
    throw new Error("thread_handoff_shared_session_requires_executor_transfer")
  }
  const [messages, deployments] = await Promise.all([
    dependencies.messages ? Promise.resolve(dependencies.messages) : listMessages(session.id),
    dependencies.deployments ? Promise.resolve(dependencies.deployments) : listDeploymentProfiles(),
  ])
  const normalized = await Promise.all(messages.map(normalizeMessageMedia))
  const conversion = conversationToCanonical(
    {
      session,
      messages: normalized.map((message) => ({
        ...message,
        sessionId: session.id,
        createdAt: now,
        metadata: message.metadata as Record<string, unknown> | undefined,
      })),
    },
    { sourceRuntime: session.sdkSessionId ? "claude-code" : "cognia", importFidelity: "structured" }
  )
  if (conversion.loss.losses.length > 0) {
    throw new Error(
      `thread_handoff_unsupported_content:${conversion.loss.losses.map((loss) => loss.path).join(",")}`
    )
  }
  const turns = conversion.session.turns
  const attachments = await buildThreadHandoffAttachments(turns, session.id)
  const digest = computeSequenceDigest(turns)
  // `upstreamId` / `canonicalModelRef` are optional, so an unset `session.model`
  // would `.includes(undefined)` its way into the first deployment with either
  // field missing — and the ticket would then require a provider and credential
  // this session never used, which the target refuses at preflight.
  const sessionProviderOverride = session.providerOverride
  const sessionModel = session.model
  const selectedDeployment = deployments.find(
    (deployment) =>
      (sessionProviderOverride !== undefined &&
        (deployment.id === sessionProviderOverride ||
          deployment.legacyProviderId === sessionProviderOverride)) ||
      (sessionModel !== undefined &&
        deployment.models.some((model) =>
          [model.id, model.upstreamId, model.canonicalModelRef].includes(sessionModel)
        ))
  )
  const providerRefs = selectedDeployment
    ? [selectedDeployment.providerRef, selectedDeployment.id]
    : session.providerOverride
      ? [session.providerOverride]
      : []
  const credentialProfileRefs = selectedDeployment?.credentialProfileRef
    ? [credentialRefId(selectedDeployment.credentialProfileRef)]
    : []
  const ticketId = dependencies.ticketId ?? crypto.randomUUID()
  const createdAt = new Date(session.createdAt ?? now).toISOString()
  const updatedAt = new Date(session.updatedAt ?? now).toISOString()
  const envelope: CanonicalSession = {
    header: {
      canonicalVersion: 1,
      canonicalSessionId: `thread-handoff:${ticketId}`,
      sourceRuntime: session.sdkSessionId ? "claude-code" : "cognia",
      ...(session.sdkSessionId
        ? { runtimeBinding: { nativeSessionId: session.sdkSessionId } }
        : {}),
      title: session.title,
      createdAt,
      updatedAt,
      turnCount: turns.length,
      importFidelity: "structured",
      sequenceDigest: digest,
    },
    turns,
  }
  const seedTranscript = turns
    .map(
      (turn) =>
        `${turn.role === "assistant" ? "Assistant" : turn.role === "user" ? "User" : "System"}: ${turn.text}`
    )
    .join("\n\n")
  const ticket: ThreadHandoffTicket = {
    ticketVersion: 1,
    ticketId,
    state: "preparing",
    role: "source",
    source: {
      hostRef: "local",
      kind: sourceHostKind(),
      sessionId: session.id,
      title: session.title,
      messageCount: turns.length,
    },
    target,
    transport: target.kind === "mobile" ? "companion" : "remote-host",
    project: {
      ...(session.projectId
        ? { sourceProjectId: session.projectId, workspaceRef: session.projectId }
        : {}),
    },
    requirements: {
      capabilities: ["thread-handoff-v1", "thread-handoff-structured-v1"],
      hostOperations: [],
      providerRefs,
      models: session.model ? [session.model] : [],
      credentialProfileRefs,
      minProtocolVersion: 1,
    },
    continuation: {
      sourceRuntime: envelope.header.sourceRuntime,
      // A native id is provenance, not proof that the target owns its runtime state.
      fidelity: "contextual",
      sequenceDigest: digest,
      ...(seedTranscript ? { seedTranscript } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
      ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
      ...(session.characterId ? { characterId: session.characterId } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.providerOverride ? { providerOverride: session.providerOverride } : {}),
    },
    attachments,
    pendingApprovals: [],
    history: [{ state: "preparing", at: now, actor: "local" }],
    createdAt: now,
    updatedAt: now,
    expiresAt: now + THREAD_HANDOFF_TTL_MS,
  }
  return { ticket, envelope }
}

export async function startThreadHandoff(
  session: ChatSession,
  target: ThreadHandoffTarget,
  now = Date.now()
): Promise<ThreadHandoffTicket> {
  if (target.kind !== "mobile") return startRemoteThreadHandoff(session, target, now)
  const frame = await buildThreadHandoffOffer(session, target, now)
  const frozen = await offerThreadHandoff(frame.ticket, now)
  await enqueueThreadHandoffOffer(frozen, frame.envelope, now)
  return frozen
}

/**
 * Rebuild the path-free offer after the source was frozen but the durable
 * dispatch row could not be created. The digest check prevents retrying with
 * history that changed outside the write guard.
 */
export async function recoverThreadHandoffOffer(
  session: ChatSession,
  frozen: ThreadHandoffTicket,
  now = Date.now()
): Promise<void> {
  if (frozen.target.kind !== "mobile") {
    await startRemoteThreadHandoff(session, frozen.target, now)
    return
  }
  if (
    frozen.role !== "source" ||
    frozen.state !== "frozen" ||
    session.handoffLock?.ticketId !== frozen.ticketId
  ) {
    throw new Error("thread_handoff_offer_not_recoverable")
  }
  const frame = await buildThreadHandoffOffer(session, frozen.target, now, {
    ticketId: frozen.ticketId,
  })
  if (frame.envelope.header.sequenceDigest !== frozen.continuation.sequenceDigest) {
    throw new Error("thread_handoff_source_digest_changed")
  }
  await enqueueThreadHandoffOffer(frozen, frame.envelope, now)
}

/** Run only from an explicit handoff/retry action: the target obtains its own human consent. */
export async function startRemoteThreadHandoff(
  session: ChatSession,
  target: ThreadHandoffTarget,
  now = Date.now(),
  dependencies: { openTarget?: typeof openRemoteHostTarget } = {}
): Promise<ThreadHandoffTicket> {
  if (session.collaboration)
    throw new Error("thread_handoff_shared_session_requires_executor_transfer")
  const remote = await (dependencies.openTarget ?? openRemoteHostTarget)(target.hostRef)
  try {
    const client = new ThreadHandoffClient({
      call: (name, args) => remote.transport.call(name, args),
    })
    let source = session.handoffLock
      ? await getThreadHandoffTicket(session.handoffLock.ticketId, "source")
      : undefined
    if (
      session.handoffLock &&
      (!source ||
        source.target.hostRef !== target.hostRef ||
        !["frozen", "committed"].includes(source.state))
    ) {
      throw new Error("thread_handoff_offer_not_recoverable")
    }
    // A committed source never exports another transcript: retry only completes the target unlock.
    if (source?.state === "committed") {
      const lease = await remote.transport.call<{ token: string }>("host_admin_lease_issue", {
        operations: ["thread_handoff_commit"],
        ttlSeconds: 600,
      })
      await client.commitTarget(
        source.ticketId,
        {
          ticketId: source.ticketId,
          state: "committed",
          sourceHostRef: source.source.hostRef,
          sourceSessionId: source.source.sessionId,
          sequenceDigest: source.continuation.sequenceDigest,
        },
        lease.token
      )
      return source
    }
    const existingTarget = source ? await client.status(source.ticketId, "target") : null
    if (existingTarget && !["preparing", "frozen", "accepted"].includes(existingTarget.state)) {
      throw new Error("thread_handoff_target_not_recoverable")
    }
    let frame: ThreadHandoffOfferFrame | undefined
    let targetTicket = existingTarget
    if (existingTarget?.state !== "accepted") {
      frame = await buildThreadHandoffOffer(
        session,
        target,
        now,
        source ? { ticketId: source.ticketId } : {}
      )
      if (source && source.continuation.sequenceDigest !== frame.envelope.header.sequenceDigest) {
        throw new Error("thread_handoff_source_digest_changed")
      }
      source ??= await offerThreadHandoff(frame.ticket, now)
      const targetSessionId = source.target.sessionId ?? `handoff-${source.ticketId}`
      const attachments = await stageRemoteThreadHandoffAttachments(
        { ...source, target: { ...source.target, sessionId: targetSessionId } },
        remote.transport
      )
      // Store target refs durably; a lost response retries the same content-addressed upload.
      source = await getDb().transaction("rw", getDb().threadHandoffTickets, async () => {
        const current = await getThreadHandoffTicket(source!.ticketId, "source")
        if (!current || current.state !== "frozen")
          throw new Error("thread_handoff_offer_not_recoverable")
        const updated = {
          ...current,
          attachments,
          target: { ...current.target, sessionId: targetSessionId },
        }
        await getDb().threadHandoffTickets.put(updated)
        return updated
      })
      targetTicket = targetTicketFromFrozen(source, source.target.hostRef, now)
      const preflight = await client.preflight(targetTicket)
      source = await getDb().transaction("rw", getDb().threadHandoffTickets, async () => {
        const current = await getThreadHandoffTicket(source!.ticketId, "source")
        if (!current || current.state !== "frozen")
          throw new Error("thread_handoff_offer_not_recoverable")
        const updated = { ...current, preflight }
        await getDb().threadHandoffTickets.put(updated)
        return updated
      })
      if (!preflight.ok) throw new Error("thread_handoff_preflight_blocked")
      targetTicket = { ...targetTicket, preflight }
    }
    if (!source || !targetTicket) throw new Error("thread_handoff_ticket_not_found")
    const lease = await remote.transport.call<{ token: string }>("host_admin_lease_issue", {
      operations: ["thread_handoff_accept", "thread_handoff_commit"],
      ttlSeconds: 600,
    })
    const accepted =
      targetTicket.state === "accepted"
        ? {
            ticket: targetTicket,
            proof: {
              ticketId: targetTicket.ticketId,
              state: "accepted" as const,
              targetHostRef: targetTicket.target.hostRef,
              targetSessionId: targetTicket.target.sessionId!,
              sequenceDigest: targetTicket.continuation.sequenceDigest,
            },
          }
        : await client.accept(targetTicket, frame!.envelope, lease.token)
    const committed = await commitThreadHandoff({
      ticketId: source.ticketId,
      role: "source",
      acceptedProof: accepted.proof,
    })
    await client.commitTarget(source.ticketId, committed.proof as SourceCommitProof, lease.token)
    return committed.ticket
  } finally {
    remote.close()
  }
}
