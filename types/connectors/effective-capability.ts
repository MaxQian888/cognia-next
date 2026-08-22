import type { Capability } from "./capability"
import type { ChannelKind } from "./event"
import type { PlatformKind } from "./platform-kind"
import type { ConnectorRuntimeCapabilityMatrix } from "./runtime-capability"

/**
 * Why a capability the platform declares is not usable for one adapter
 * instance (optionally, in one conversation scene).
 *
 * Each reason names a DIFFERENT kind of evidence, because the fix differs:
 *
 * - `transport_unsupported` — the instance's chosen transport has no channel
 *   for it (Discord presence is a gateway op, so a webhook-mode instance can
 *   never send one). Fix: change the transport, if the platform allows.
 * - `missing_oauth_scope` — the recorded OAuth grant
 *   (`settings.connectedScopes`, written by `lib/connectors/oauth-scope-audit.ts`)
 *   does not include any scope this capability needs. Fix: re-authorize.
 * - `upstream_impl_unsupported` — the probed upstream implementation does not
 *   implement the action (OneBot: `implMetadata.features`, written by the
 *   `get_version_info` probe). Fix: change or upgrade the upstream.
 * - `instance_setting_off` — a per-instance setting turns the platform feature
 *   off (Slack: `assistantAppEnabled`). Fix: change the setting.
 * - `scene_unsupported` — the platform only offers the capability in another
 *   conversation scene (QQ reactions are guild-channel only). Not fixable;
 *   it is a property of where the conversation lives.
 */
export const CAPABILITY_SUPPRESSION_REASONS = [
  "transport_unsupported",
  "missing_oauth_scope",
  "upstream_impl_unsupported",
  "instance_setting_off",
  "scene_unsupported",
] as const

export type CapabilitySuppressionReason = (typeof CAPABILITY_SUPPRESSION_REASONS)[number]

/** One declared capability that this instance/scene cannot actually serve. */
export interface CapabilitySuppression {
  capability: Capability
  reason: CapabilitySuppressionReason
  /**
   * Machine-readable specifics for the reason: the scopes that would have
   * satisfied it, the upstream feature token, the setting name, the scenes
   * where the capability does exist, or the transports that carry it.
   *
   * Rendered verbatim by the capability matrix card, so it must stay free of
   * secrets — scope names, feature tokens and setting KEYS only, never values.
   */
  detail: string
}

/**
 * What one adapter instance can actually do, and what it only claims to.
 *
 * `declared` is the platform-wide static list (`getPlatformCapabilities`, or a
 * live adapter's `meta.capabilities`). `capabilities` is that list minus every
 * entry in `suppressed`. Callers gating UI, model tools, or delivery MUST read
 * `capabilities`; `declared` is kept only so a surface can explain the
 * difference to the user.
 */
export interface EffectiveCapabilitySnapshot {
  platform: PlatformKind
  /** Present when the snapshot was resolved for a concrete instance row. */
  adapterId?: string
  /** Present when the snapshot was resolved for one conversation scene. */
  scopeKind?: ChannelKind
  declared: readonly Capability[]
  capabilities: readonly Capability[]
  suppressed: readonly CapabilitySuppression[]
  runtime: ConnectorRuntimeCapabilityMatrix
}
