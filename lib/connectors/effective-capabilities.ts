/**
 * The single authority on what an adapter INSTANCE can actually do.
 *
 * `getPlatformCapabilities()` answers a different question — what the platform's
 * adapter module implements — and its own docblock warns that a declared flag
 * "is platform-wide; a few are SCENE-LIMITED at the wire and the adapter throws
 * `unsupported` (or silently no-ops for `typing`) outside the scene". Until now
 * that warning was prose: every caller (the model's tool manifest, the inbox's
 * "load earlier" button, the reply-quoting decision) read the platform list and
 * inferred "works everywhere". The instance-level truth existed but was
 * unreachable —
 *
 *   • Slack persists its granted OAuth scopes on `settings.connectedScopes`
 *     (`lib/connectors/oauth-scope-audit.ts`) and only ever RENDERED them, so a
 *     workspace that never granted `files:write` still advertised `send.file`
 *     and failed at delivery with `missing_scope`.
 *   • OneBot probes its upstream and persists `implMetadata.features` with a
 *     comment saying "the capability matrix view can show what the upstream
 *     supports" — but nothing projected it, so a Lagrange instance advertised
 *     `send.reaction` that only NapCat/LLOneBot implement.
 *   • Slack's `typing` is a documented no-op unless `assistantAppEnabled`, and
 *     the adapter said so in a comment ending "there is no per-instance
 *     capability projection".
 *
 * This module is that projection. It reads only data the instance already
 * carries, so it needs no network and no live adapter build.
 *
 * ## Fail-open, deliberately
 *
 * Absent evidence never suppresses. A Slack bot configured with a hand-pasted
 * token has no `connectedScopes`; a OneBot instance whose best-effort probe
 * failed has no `implMetadata`. Suppressing on absence would disable working
 * bots on the strength of a missing record. Evidence we HAVE is trusted;
 * evidence we lack is not invented.
 *
 * That is the opposite of the media gate (`lib/connectors/media-model-gate.ts`),
 * which blocks whenever policy cannot be determined — and the asymmetry is
 * intended. There, an undetermined answer risks sending private bytes to a
 * cloud model; here, it only risks a call the platform would have rejected
 * anyway, with a determinate error the adapter already raises.
 *
 * ## Granularity
 *
 * Resolution is (instance × conversation scene). Conditions narrower than that
 * stay where they are enforced: DingTalk can only recall messages sent through
 * its proactive endpoints (a property of the individual message id), and WeChat
 * OA's 48-hour customer-service window is a property of the recipient's last
 * inbound. Neither is knowable here, so neither is modelled here — the adapters
 * keep raising them.
 */

import type { AdapterImplMetadata, AdapterInstanceRow } from "@/lib/db/connector-types"
import type { Capability } from "@/types/connectors/capability"
import type { ChannelKind } from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type {
  CapabilitySuppression,
  EffectiveCapabilitySnapshot,
} from "@/types/connectors/effective-capability"
import type { ConnectorRuntimeCapabilityMatrix } from "@/types/connectors/runtime-capability"
import { connectorRuntimeCapabilitiesForScope } from "@/types/connectors/runtime-capability"
import type { ConnectedScopes } from "./oauth-scope-audit"
import { getPlatformCapabilities } from "./platform-capabilities"

/**
 * OAuth scopes that satisfy a capability, as ANY-OF sets.
 *
 * Only Slack is listed, and only for capabilities whose required scope is
 * named by Slack's own API reference for the endpoint the adapter calls
 * (`files.getUploadURLExternal` → `files:write` is even quoted in
 * `adapters/slack/index.ts`). Guessing a scope would produce the exact failure
 * this module exists to remove: a confident wrong answer about what a bot can
 * do. `presence.status` is therefore absent — the adapter calls
 * `users.profile.set`, whose bot-token scope requirement we have not verified.
 *
 * Lark is absent for a structural reason, not an unverified one: Lark's
 * `connectedScopes` come from the *user* send-as grant, while bot capabilities
 * are granted as app permissions in the Lark console. Projecting one onto the
 * other would suppress capabilities the bot really has.
 */
const OAUTH_SCOPE_REQUIREMENTS: Partial<
  Record<PlatformKind, Partial<Record<Capability, readonly string[]>>>
> = {
  slack: {
    "send.text": ["chat:write"],
    "send.markdown": ["chat:write"],
    "send.mention": ["chat:write"],
    "send.reply": ["chat:write"],
    "send.thread": ["chat:write"],
    "send.card": ["chat:write"],
    "send.a2ui": ["chat:write"],
    "rich-card.slack": ["chat:write"],
    "rich-markdown.slack": ["chat:write"],
    edit: ["chat:write"],
    delete: ["chat:write"],
    "send.image": ["files:write"],
    "send.file": ["files:write"],
    "send.reaction": ["reactions:write"],
    pin: ["pins:write"],
    "history.fetch": ["channels:history", "groups:history", "im:history", "mpim:history"],
  },
}

/**
 * OneBot capabilities that need a non-standard upstream action, keyed by the
 * feature token `probeUpstreamImpl` records. The adapter already refuses these
 * calls when the token is missing (`adapters/onebot/index.ts`); projecting the
 * same table here is what stops the tool being OFFERED in the first place.
 */
const ONEBOT_FEATURE_REQUIREMENTS: Partial<Record<Capability, string>> = {
  "send.reaction": "set_msg_emoji_like",
  "send.file": "upload_group_file",
}

/** Instance settings that must be truthy for a capability to work at all. */
const INSTANCE_SETTING_REQUIREMENTS: Partial<
  Record<PlatformKind, Partial<Record<Capability, string>>>
> = {
  // Slack has no typing API for ordinary bots — only Assistant Apps get
  // `assistant.threads.setStatus`. Without the setting `setTyping` logs and
  // returns.
  slack: { typing: "assistantAppEnabled" },
}

/**
 * Scenes in which a capability exists at all. Applied only when the caller
 * knows the scene; an instance-level snapshot keeps the capability, because
 * "this bot can react somewhere" is the honest instance-level answer.
 */
const SCENE_REQUIREMENTS: Partial<
  Record<PlatformKind, Partial<Record<Capability, readonly ChannelKind[]>>>
> = {
  "qq-official": {
    // `msg_type: 6 input_notify` is a C2C-only passive reply.
    typing: ["private"],
    // Reactions exist only in the guild channel scene; the adapter throws
    // `unsupported` for every other decoded scene.
    "send.reaction": ["channel"],
  },
  slack: {
    // `assistant.threads.setStatus` needs a thread_ts; Slack answers
    // `not_supported` without one, so the adapter skips non-thread scopes.
    typing: ["thread"],
  },
}

export interface EffectiveCapabilityInput {
  platform: PlatformKind
  /**
   * The capability set to project. Defaults to the platform's static table.
   * Pass a live adapter's `meta.capabilities` when one is built — a plugin
   * connector's declared set is not in the built-in table.
   */
  declared?: readonly Capability[]
  /** `AdapterInstanceRow.settings` — holds `connectedScopes` and feature flags. */
  settings?: Record<string, unknown>
  /** `AdapterInstanceRow.implMetadata` — the OneBot upstream probe result. */
  implMetadata?: AdapterImplMetadata
  adapterId?: string
  /** The conversation scene, when resolving for one conversation. */
  scopeKind?: ChannelKind
  /**
   * A live adapter's own `runtimeCapabilities`, when one is built. Adapters
   * that refine the matrix per instance (Slack) already computed it; using it
   * keeps the live and static answers from disagreeing.
   */
  runtime?: ConnectorRuntimeCapabilityMatrix
}

function readConnectedScopes(settings: Record<string, unknown> | undefined): string[] | null {
  const raw = settings?.["connectedScopes"] as ConnectedScopes | undefined
  if (!raw || !Array.isArray(raw.scopes) || raw.scopes.length === 0) return null
  return raw.scopes.filter((scope): scope is string => typeof scope === "string")
}

/**
 * Refine the platform runtime matrix with per-instance settings.
 *
 * Slack's live adapter already does this; doing it here too means a caller
 * holding only a row (a settings page, the capability matrix) is told the same
 * thing as a caller holding a built adapter, instead of being told Slack
 * streams text when this install cannot.
 */
function refineRuntime(
  base: ConnectorRuntimeCapabilityMatrix,
  platform: PlatformKind,
  settings: Record<string, unknown> | undefined
): ConnectorRuntimeCapabilityMatrix {
  if (platform !== "slack") return base
  const assistant = settings?.["assistantAppEnabled"] === true
  return {
    ...base,
    textStreaming: assistant,
    componentMutation: assistant,
    suggestedPrompts: assistant,
  }
}

/**
 * Project one instance's real capability set.
 *
 * Rules are evaluated in the order the reasons are declared in
 * `CAPABILITY_SUPPRESSION_REASONS`, and the FIRST match wins, so a capability
 * appears at most once in `suppressed` and `capabilities` stays exactly
 * `declared` minus `suppressed`.
 */
export function effectiveCapabilities(
  input: EffectiveCapabilityInput
): EffectiveCapabilitySnapshot {
  const declared = input.declared ?? getPlatformCapabilities(input.platform)
  const grantedScopes = readConnectedScopes(input.settings)
  const upstreamFeatures = input.implMetadata?.features
  const suppressed: CapabilitySuppression[] = []

  for (const capability of declared) {
    const requiredScopes = OAUTH_SCOPE_REQUIREMENTS[input.platform]?.[capability]
    if (grantedScopes && requiredScopes && !requiredScopes.some((s) => grantedScopes.includes(s))) {
      suppressed.push({
        capability,
        reason: "missing_oauth_scope",
        detail: requiredScopes.join(" | "),
      })
      continue
    }

    const requiredFeature =
      input.platform === "onebot" ? ONEBOT_FEATURE_REQUIREMENTS[capability] : undefined
    if (upstreamFeatures && requiredFeature && !upstreamFeatures.includes(requiredFeature)) {
      suppressed.push({
        capability,
        reason: "upstream_impl_unsupported",
        detail: requiredFeature,
      })
      continue
    }

    const requiredSetting = INSTANCE_SETTING_REQUIREMENTS[input.platform]?.[capability]
    if (requiredSetting && input.settings?.[requiredSetting] !== true) {
      suppressed.push({
        capability,
        reason: "instance_setting_off",
        detail: requiredSetting,
      })
      continue
    }

    const allowedScenes = SCENE_REQUIREMENTS[input.platform]?.[capability]
    if (input.scopeKind && allowedScenes && !allowedScenes.includes(input.scopeKind)) {
      suppressed.push({
        capability,
        reason: "scene_unsupported",
        detail: allowedScenes.join(" | "),
      })
    }
  }

  const blocked = new Set(suppressed.map((entry) => entry.capability))
  const base =
    input.runtime ??
    connectorRuntimeCapabilitiesForScope(input.platform, input.scopeKind ?? "group")
  return {
    platform: input.platform,
    adapterId: input.adapterId,
    scopeKind: input.scopeKind,
    declared,
    capabilities: declared.filter((capability) => !blocked.has(capability)),
    suppressed,
    runtime: input.runtime ? base : refineRuntime(base, input.platform, input.settings),
  }
}

/** Convenience: project straight from a stored instance row. */
export function effectiveCapabilitiesForRow(
  row: Pick<AdapterInstanceRow, "id" | "type" | "settings" | "implMetadata">,
  options?: { declared?: readonly Capability[]; scopeKind?: ChannelKind }
): EffectiveCapabilitySnapshot {
  return effectiveCapabilities({
    platform: row.type,
    adapterId: row.id,
    settings: row.settings,
    implMetadata: row.implMetadata,
    declared: options?.declared,
    scopeKind: options?.scopeKind,
  })
}

/** Whether the instance can serve `capability` right now. */
export function hasEffectiveCapability(
  snapshot: EffectiveCapabilitySnapshot,
  capability: Capability
): boolean {
  return snapshot.capabilities.includes(capability)
}

/** Why `capability` is unavailable, or `undefined` when it is available (or never declared). */
export function suppressionFor(
  snapshot: EffectiveCapabilitySnapshot,
  capability: Capability
): CapabilitySuppression | undefined {
  return snapshot.suppressed.find((entry) => entry.capability === capability)
}

/**
 * Stable fingerprint of everything that shapes a snapshot. Callers that MEMOIZE
 * a projection (the built-in skill manifest cache in `lib/claude/build-options.ts`)
 * must key on this: capabilities used to be static per platform, so that cache
 * legitimately keyed on the platform alone. They are not static any more, and a
 * key that ignores the instance would serve one bot's tool list to another.
 */
export function capabilityFingerprint(input: EffectiveCapabilityInput): string {
  const scopes = readConnectedScopes(input.settings)?.join(",") ?? ""
  const features = input.implMetadata?.features?.join(",") ?? ""
  const assistant = input.settings?.["assistantAppEnabled"] === true ? "1" : "0"
  return [input.platform, input.scopeKind ?? "", scopes, features, assistant].join("|")
}
