/**
 * Which model a conversation runs on, as the conversation LIST names it.
 *
 * The desktop rail, the phone drawer and the conversation filters each
 * resolved this as `session.model → character.model → defaultModel →
 * claude-sonnet-5`, which only describes Cognia's built-in lane. A
 * conversation an external agent runs (Claude Code, Codex, Kimi, a
 * configuration the paired Host owns) keeps its model somewhere else entirely
 * — `externalAgentModels`, its gateway link, or nowhere because the agent runs
 * its own default — so every such row fell through to the hardcoded default
 * and the whole list read "Claude Sonnet 5". The composer's model chip already
 * resolved the lane first (`components/chat/composer/model-picker.tsx`); this
 * is the same answer, pure, for a list of rows.
 *
 * Pure: the caller hands in this device's runtime refs and agent names.
 */

import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import {
  externalAgentIdFromProviderId,
  isExternalAgentProviderId,
  resolveExternalAgentModelSelection,
} from "@/lib/ai/agent/external/session/session-models"
import { getProviderDisplayName } from "@/lib/ai/icons"
import { resolveModelDisplayName } from "@/lib/ai/model-options"
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import type { Character, ChatSession } from "@cognia/agent-config-types"

export interface SessionModelContext {
  character?: Pick<Character, "model" | "providerId">
  /** The lane this device recorded for the session (`sessionRuntimeRefs[id]`), if any. */
  sessionRuntimeRef?: AgentRuntimeRef
  /** This device's default lane: what an unrecorded conversation's next turn runs on. */
  defaultRuntimeRef?: AgentRuntimeRef
  defaultModel?: string
  /**
   * Desktop-only in settings sync, so a paired phone never has it. Absent, a
   * built-in model is named without a provider rather than as Anthropic's.
   */
  defaultProvider?: string
  /** An external agent's display name, from this device's agent store. */
  agentNameOf?: (agentId: string) => string | undefined
}

export type SessionModelIdentity =
  | {
      lane: "builtin"
      modelId: string
      providerId?: string
    }
  | {
      lane: "agent"
      agentId: string
      agentName?: string
      /** Absent: the agent runs its own default, which only the agent knows. */
      modelId?: string
      /** Set for a Cognia model the agent runs through the gateway. */
      providerId?: string
    }

interface AgentLane {
  agentId: string
  name?: string
}

function laneOfRef(ref: AgentRuntimeRef): AgentLane | null {
  if (ref.kind === "external") return { agentId: ref.agentId }
  if (ref.kind === "host") return { agentId: ref.configId, ...(ref.name ? { name: ref.name } : {}) }
  return null
}

/**
 * The external agent a conversation runs on, or `null` for the built-in lane.
 *
 * This device's own record wins. Without one, the conversation's synced link
 * to an agent (`externalAgentSession`, or the legacy provider marker) is
 * better evidence than this device's default lane: a conversation started on
 * the desktop never recorded a lane on the phone. With neither, the device
 * default is what the next turn would run on, which is what the composer chip
 * says too.
 */
export function sessionAgentLane(
  session: Pick<ChatSession, "externalAgentSession" | "providerOverride">,
  context: Pick<SessionModelContext, "sessionRuntimeRef" | "defaultRuntimeRef">
): AgentLane | null {
  if (context.sessionRuntimeRef) return laneOfRef(context.sessionRuntimeRef)
  const linked =
    session.externalAgentSession?.agentId ?? externalAgentIdFromProviderId(session.providerOverride)
  if (linked) return { agentId: linked }
  return context.defaultRuntimeRef ? laneOfRef(context.defaultRuntimeRef) : null
}

export function resolveSessionModelIdentity(
  session: ChatSession,
  context: SessionModelContext
): SessionModelIdentity {
  const lane = sessionAgentLane(session, context)
  if (lane) {
    const selection = resolveExternalAgentModelSelection({
      agentId: lane.agentId,
      session,
      appDefaults: { defaultModel: context.defaultModel, defaultProvider: context.defaultProvider },
    })
    const agentName = context.agentNameOf?.(lane.agentId) ?? lane.name
    const base = {
      lane: "agent" as const,
      agentId: lane.agentId,
      ...(agentName ? { agentName } : {}),
    }
    const choice = selection.choice
    if (choice?.kind === "cognia") {
      return { ...base, modelId: choice.binding.modelId, providerId: choice.binding.providerId }
    }
    // A native choice with no model id is "the agent's own default".
    if (choice?.kind === "native" && choice.modelId) return { ...base, modelId: choice.modelId }
    return base
  }

  // The built-in lane. A provider marker left on the row by an earlier agent
  // turn names that agent's model, not one of ours.
  const marked = isExternalAgentProviderId(session.providerOverride)
  const configured =
    (marked ? undefined : session.model) ?? context.character?.model ?? context.defaultModel
  const providerId =
    (marked ? undefined : session.providerOverride) ??
    context.character?.providerId ??
    context.defaultProvider ??
    // The last resort names a model, so it names that model's provider too.
    (configured ? undefined : "anthropic")
  return {
    lane: "builtin",
    modelId: configured ?? ANTHROPIC_DEFAULT_MODEL,
    ...(providerId ? { providerId } : {}),
  }
}

/** The row's model and provider labels for an identity. */
export function sessionModelLabels(identity: SessionModelIdentity): {
  model?: string
  provider?: string
} {
  const provider = identity.providerId ? getProviderDisplayName(identity.providerId) : undefined
  if (identity.lane === "builtin") {
    return {
      model: resolveModelDisplayName(identity.providerId, identity.modelId),
      ...(provider ? { provider } : {}),
    }
  }
  // An agent on its own default model: the agent is the honest answer, and
  // naming a model it may not be running is the bug this module exists for.
  const model = identity.modelId
    ? resolveModelDisplayName(identity.providerId, identity.modelId)
    : identity.agentName
  const providerLabel = provider ?? identity.agentName
  return {
    ...(model ? { model } : {}),
    ...(providerLabel ? { provider: providerLabel } : {}),
  }
}
