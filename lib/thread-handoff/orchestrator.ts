import type { UIMessage } from "ai"
import type { CanonicalSession, CanonicalTurn } from "@cognia/agent-config-types/canonical-session"
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
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { detectPlatform } from "@/lib/platform/detect"

import { offerThreadHandoff } from "./service"

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

function canonicalTurns(messages: readonly UIMessage[]): CanonicalTurn[] {
  return messages
    .filter(
      (message): message is UIMessage & { role: CanonicalTurn["role"] } =>
        message.role === "user" || message.role === "assistant" || message.role === "system"
    )
    .map((message) => ({
      turnId: message.id,
      role: message.role,
      text: extractPlainText(message.parts),
      ...(typeof message.metadata === "object" &&
      message.metadata !== null &&
      typeof (message.metadata as { createdAt?: unknown }).createdAt === "number"
        ? { at: new Date((message.metadata as { createdAt: number }).createdAt).toISOString() }
        : {}),
    }))
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
  const [messages, deployments] = await Promise.all([
    dependencies.messages ? Promise.resolve(dependencies.messages) : listMessages(session.id),
    dependencies.deployments ? Promise.resolve(dependencies.deployments) : listDeploymentProfiles(),
  ])
  const turns = canonicalTurns(messages)
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
      importFidelity: session.sdkSessionId ? "native-exact" : "structured",
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
      capabilities: ["thread-handoff-v1"],
      hostOperations: [],
      providerRefs,
      models: session.model ? [session.model] : [],
      credentialProfileRefs,
      minProtocolVersion: 1,
    },
    continuation: {
      sourceRuntime: envelope.header.sourceRuntime,
      ...(session.sdkSessionId ? { sdkSessionId: session.sdkSessionId } : {}),
      fidelity: envelope.header.importFidelity,
      sequenceDigest: digest,
      ...(seedTranscript ? { seedTranscript } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
      ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
      ...(session.characterId ? { characterId: session.characterId } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.providerOverride ? { providerOverride: session.providerOverride } : {}),
    },
    attachments: [],
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
