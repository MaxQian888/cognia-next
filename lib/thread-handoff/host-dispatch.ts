import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import type { CredentialReference } from "@cognia/provider-types/provider-profile"

import { getThreadHandoffTicket } from "@/lib/db/thread-handoff-tickets"
import { completeHostDispatch } from "@/lib/db/host-dispatch-queue"
import { getDb } from "@/lib/db/schema"
import { getAllProjects } from "@/lib/db/projects"
import { listDeploymentProfiles, listProviderProfiles } from "@/lib/db/provider-profiles"
import { parseUploadRef } from "@/lib/db/session-attachment-uploads"
import { detectLocalCapabilities } from "@/lib/platform/capabilities"
import { detectPlatform } from "@/lib/platform/detect"
import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"

import {
  abortThreadHandoff,
  acceptThreadHandoff,
  commitThreadHandoff,
  offerThreadHandoff,
  preflightThreadHandoff,
  type AcceptedThreadHandoffProof,
  type SourceCommitProof,
  type ThreadHandoffPreflightEnvironment,
} from "./service"

export const THREAD_HANDOFF_COMMANDS = [
  "thread_handoff_offer",
  "thread_handoff_preflight",
  "thread_handoff_accept",
  "thread_handoff_commit",
  "thread_handoff_abort",
  "thread_handoff_status",
] as const

export type ThreadHandoffCommand = (typeof THREAD_HANDOFF_COMMANDS)[number]

export function isThreadHandoffCommand(value: string): value is ThreadHandoffCommand {
  return (THREAD_HANDOFF_COMMANDS as readonly string[]).includes(value)
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

export async function buildThreadHandoffPreflightEnvironment(
  ticket: ThreadHandoffTicket
): Promise<ThreadHandoffPreflightEnvironment> {
  const platform = detectPlatform()
  const [providers, deployments, projects] = await Promise.all([
    listProviderProfiles(),
    listDeploymentProfiles(),
    getAllProjects(),
  ])
  const manifest = buildLocalHostFeatureManifest({ platform })
  const attachmentRefs: string[] = []
  for (const attachment of ticket.attachments) {
    const uploadId = parseUploadRef(attachment.ref)
    if (!uploadId) continue
    const row = await getDb().sessionAttachmentUploads.get(uploadId)
    if (row?.status === "committed" && attachment.ref) attachmentRefs.push(attachment.ref)
  }

  // One detection, three reads: three calls could disagree if detection ever
  // stops being pure, and a preflight that reports capabilities inconsistent
  // with its own `nativeRuntimeAvailable` is worse than a slow one.
  const capabilities = [...detectLocalCapabilities()]

  return {
    capabilities,
    hostOperations: manifest.operations
      .filter((operation) => operation.healthy)
      .map((operation) => ({ feature: operation.feature, operation: operation.name })),
    providerRefs: [
      ...providers.map((profile) => profile.id),
      ...deployments.flatMap((deployment) =>
        [deployment.id, deployment.providerRef, deployment.legacyProviderId].filter(
          (value): value is string => typeof value === "string"
        )
      ),
    ],
    models: deployments.flatMap((deployment) =>
      deployment.models.flatMap((model) =>
        [model.id, model.upstreamId, model.canonicalModelRef].filter(
          (value): value is string => typeof value === "string"
        )
      )
    ),
    credentialProfileRefs: deployments.flatMap((deployment) =>
      deployment.credentialProfileRef ? [credentialRefId(deployment.credentialProfileRef)] : []
    ),
    workspaceRefs: projects.flatMap((project) =>
      [project.id, project.path].filter((value): value is string => typeof value === "string")
    ),
    attachmentRefs,
    protocolVersion: manifest.protocol.max,
    nativeRuntimeAvailable: capabilities.includes("sidecar") || capabilities.includes("shell"),
  }
}

export interface ThreadHandoffHostDispatchDependencies {
  importSession: (envelope: CanonicalSession, sessionId: string) => Promise<void>
  preflightEnvironment?: (ticket: ThreadHandoffTicket) => Promise<ThreadHandoffPreflightEnvironment>
  now?: () => number
}

export async function dispatchThreadHandoffCommand(
  command: ThreadHandoffCommand,
  payload: Record<string, unknown>,
  deps: ThreadHandoffHostDispatchDependencies
): Promise<unknown> {
  const now = deps.now?.() ?? Date.now()
  switch (command) {
    case "thread_handoff_offer":
      return offerThreadHandoff(payload.ticket as ThreadHandoffTicket, now)
    case "thread_handoff_preflight": {
      const ticket = payload.ticket as ThreadHandoffTicket
      const environment = await (
        deps.preflightEnvironment ?? buildThreadHandoffPreflightEnvironment
      )(ticket)
      return preflightThreadHandoff(ticket, environment, now)
    }
    case "thread_handoff_accept": {
      const offered = payload.ticket as ThreadHandoffTicket
      // NEVER trust the preflight that arrived on the wire. It is a statement
      // about THIS host's providers, credentials, workspaces, protocol version
      // and attachments, so only this host can make it — a peer that sends
      // `preflight: { ok: true }` would otherwise walk straight past every
      // check `buildThreadHandoffPreflightEnvironment` exists to run.
      const environment = await (
        deps.preflightEnvironment ?? buildThreadHandoffPreflightEnvironment
      )(offered)
      const preflight = preflightThreadHandoff(offered, environment, now)
      return acceptThreadHandoff(
        {
          ticket: { ...offered, preflight },
          envelope: payload.envelope as CanonicalSession,
        },
        { now, importSession: deps.importSession }
      )
    }
    case "thread_handoff_commit": {
      if (payload.role === "source") {
        const committed = await commitThreadHandoff({
          ticketId: payload.ticketId as string,
          role: "source",
          acceptedProof: payload.acceptedProof as AcceptedThreadHandoffProof,
          at: now,
        })
        await completeHostDispatch(payload.ticketId as string, now)
        return committed
      }
      return commitThreadHandoff({
        ticketId: payload.ticketId as string,
        role: "target",
        sourceCommitProof: payload.sourceCommitProof as SourceCommitProof,
        at: now,
      })
    }
    case "thread_handoff_abort":
      return abortThreadHandoff({
        ticketId: payload.ticketId as string,
        role: payload.role as "source" | "target",
        peerDisposition: payload.peerDisposition as "not-accepted" | "deleted" | undefined,
        at: now,
      })
    case "thread_handoff_status":
      return (
        (await getThreadHandoffTicket(
          payload.ticketId as string,
          payload.role as "source" | "target"
        )) ?? null
      )
  }
}
