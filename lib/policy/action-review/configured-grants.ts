/**
 * The recipient lists a person configured: the `policy` grants (ADR-0239).
 *
 * Three lists exist, and only a person writes any of them:
 *
 * - A connector instance's `outboundRecipients` (`adapter:<id>`): any delivery
 *   through that bot account, whoever makes it, may reach these recipients
 *   with nobody watching. Looked up for every plan, from the targets' channel.
 * - A conversation's `proactivePush` opt-in (`proactive-push:<key>`), set in
 *   the conversation's override form: the conversation itself.
 * - A Bot installation's `outboundRecipients` (`bot:<id>`): only that Bot's
 *   runs. An agent-turn Bot passes it with its turn ({@link botRecipientGrants});
 *   a handler Bot's own plugin code is covered while its run is live
 *   ({@link beginBotOutboundRun}).
 *
 * A lookup that fails grants nothing: the plan then asks, drafts or parks,
 * never sends on a failure.
 */

import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"
import type { OutboundPolicyGrantList } from "./plan-context"
import { outboundFingerprint, type OutboundTarget } from "./outbound-targets"

export interface ConfiguredGrantDeps {
  /** A connector instance's recipient list. Default: the `adapterInstances` row. */
  adapterRecipients?: (adapterId: string) => Promise<readonly OutboundRecipientGrant[] | undefined>
  /** Whether a conversation opted into proactive pushes. Default: its override row. */
  proactivePush?: (conversationKey: string) => Promise<boolean>
}

/** The fingerprints a configured list grants, under the ref that names the list. */
export function recipientGrantList(
  policyRef: string,
  grants: readonly OutboundRecipientGrant[] | undefined
): OutboundPolicyGrantList | undefined {
  if (!grants || grants.length === 0) return undefined
  return { policyRef, fingerprints: grants.map((grant) => outboundFingerprint(grant.recipient)) }
}

/** A Bot installation's list, for the runs it starts. */
export function botRecipientGrants(installation: {
  id: string
  outboundRecipients?: readonly OutboundRecipientGrant[]
}): OutboundPolicyGrantList[] {
  const list = recipientGrantList(`bot:${installation.id}`, installation.outboundRecipients)
  return list ? [list] : []
}

/**
 * A list entry for a target a person picked, or `undefined` for one no list
 * may hold (a public link, an unnamed recipient). Build the target with
 * `conversationTarget` / `personTarget` / `mailTarget` so the entry is in the
 * engine's normalized form.
 */
export function recipientGrant(
  target: OutboundTarget,
  now: number = Date.now()
): OutboundRecipientGrant | undefined {
  if (target.kind !== "conversation" && target.kind !== "person" && target.kind !== "mail") {
    return undefined
  }
  return {
    recipient: { kind: target.kind, channel: target.channel, recipient: target.recipient },
    addedAt: now,
    addedBy: "local-user",
  }
}

/** Whether a list already holds this recipient. */
export function listsRecipient(
  grants: readonly OutboundRecipientGrant[],
  target: Pick<OutboundTarget, "channel" | "recipient">
): boolean {
  return grants.some(
    (grant) =>
      grant.recipient.channel === target.channel && grant.recipient.recipient === target.recipient
  )
}

async function defaultAdapterRecipients(
  adapterId: string
): Promise<readonly OutboundRecipientGrant[] | undefined> {
  const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
  return (await getAdapterInstance(adapterId))?.outboundRecipients
}

async function defaultProactivePush(conversationKey: string): Promise<boolean> {
  const { readForResolution } = await import("@/lib/db/conversation-overrides")
  return (await readForResolution(conversationKey))?.proactivePush === true
}

/** The conversation key a conversation target names, thread dropped. */
function conversationKeyOf(target: OutboundTarget): string | undefined {
  return target.kind === "conversation" ? target.recipient.replace(/^conv:/, "") : undefined
}

/**
 * The lists that could grant these targets: each connector instance they go
 * through, and each conversation's proactive-push opt-in. `conversationKeys`
 * adds keys the caller knows the delivery uses (a thread's key), so an opt-in
 * set on a thread counts for a delivery into that thread.
 */
export async function configuredPolicyGrants(
  targets: readonly OutboundTarget[],
  options: { conversationKeys?: readonly string[] } & ConfiguredGrantDeps = {}
): Promise<OutboundPolicyGrantList[]> {
  const adapterRecipients = options.adapterRecipients ?? defaultAdapterRecipients
  const proactivePush = options.proactivePush ?? defaultProactivePush
  const lists: OutboundPolicyGrantList[] = []

  const channels = new Set(
    targets
      .filter((target) => target.kind === "conversation" || target.kind === "person")
      .map((target) => target.channel)
  )
  for (const adapterId of channels) {
    try {
      const list = recipientGrantList(`adapter:${adapterId}`, await adapterRecipients(adapterId))
      if (list) lists.push(list)
    } catch {
      // Grants nothing; the plan asks instead.
    }
  }

  for (const target of targets) {
    const key = conversationKeyOf(target)
    if (!key) continue
    const keys = new Set([key, ...(options.conversationKeys ?? [])])
    for (const candidate of keys) {
      try {
        if (await proactivePush(candidate)) {
          lists.push({
            policyRef: `proactive-push:${candidate}`,
            fingerprints: [outboundFingerprint(target)],
          })
          break
        }
      } catch {
        // Grants nothing; the plan asks instead.
      }
    }
  }
  return lists
}

// ── Handler Bots: the run's plugin code ─────────────────────────────────────

interface LiveBotRun {
  pluginId: string
  installationId: string
  lists: readonly OutboundPolicyGrantList[]
}

const liveBotRuns = new Map<string, LiveBotRun>()

/**
 * Record that a handler Bot of `pluginId` is running: until the returned
 * function is called, that plugin's own deliveries (`ctx.connectors`) may reach
 * the installation's recipients. Keyed by run, so overlapping runs of two
 * installations each count, and ending one leaves the other.
 */
export function beginBotOutboundRun(
  runId: string,
  run: {
    pluginId: string
    installation: { id: string; outboundRecipients?: readonly OutboundRecipientGrant[] }
  }
): () => void {
  const lists = botRecipientGrants(run.installation)
  if (lists.length === 0) return () => undefined
  liveBotRuns.set(runId, {
    pluginId: run.pluginId,
    installationId: run.installation.id,
    lists,
  })
  return () => {
    liveBotRuns.delete(runId)
  }
}

/** The installation lists of `pluginId`'s handler Bots running right now. */
export function runningBotGrantsOf(pluginId: string): OutboundPolicyGrantList[] {
  const lists: OutboundPolicyGrantList[] = []
  for (const run of liveBotRuns.values()) {
    if (run.pluginId === pluginId) lists.push(...run.lists)
  }
  return lists
}

export function __resetRunningBotGrantsForTesting(): void {
  liveBotRuns.clear()
}
