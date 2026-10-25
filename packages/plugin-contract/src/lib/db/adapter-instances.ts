/**
 * The plugin contract's share of `lib/db/adapter-instances.ts`, which re-exports these.
 */
import type { AdapterInstanceRow } from "./connector-types"

/**
 * `mediaModelPolicy` is optional on the way in and required on the row: this
 * function is the single place the default is applied, so a caller that forgets
 * it gets the safe value rather than an instance with no policy at all.
 */
export type AdapterInstanceInput = Omit<
  AdapterInstanceRow,
  // `owner` has its own writer, `setAdapterInstanceOwner`; `outboundRecipients`
  // has `setAdapterOutboundRecipients` (ADR-0239).
  "id" | "createdAt" | "updatedAt" | "mediaModelPolicy" | "owner" | "outboundRecipients"
> & { mediaModelPolicy?: AdapterInstanceRow["mediaModelPolicy"] }

export type AdapterInstancePatch = Partial<
  Pick<
    AdapterInstanceRow,
    | "displayName"
    | "enabled"
    | "transportMode"
    | "settings"
    | "credentialsRef"
    | "trigger"
    | "defaultCharacterId"
    | "defaultMode"
    | "webhookPath"
    | "publicUrl"
    | "quietHours"
    | "muted"
    | "lastKnownCapabilities"
    | "implMetadata"
    // v45 (im-refactored-crayon) — Lark guardrails + whoami cache.
    | "atResponseStrategy"
    | "inboundActivationPolicy"
    | "activeRunDispatchMode"
    | "activationTtlMs"
    | "deliveryReadiness"
    | "chatAllowlist"
    | "chatBlocklist"
    | "lastWhoamiAt"
    | "lastWhoamiResult"
    // v178 — confirmed platform identity (sibling-bot guard) and the media
    // policy gate. `userTokenStoredAt` was dropped: nothing read it.
    | "selfIdentity"
    | "mediaModelPolicy"
    | "plugin"
    // Cross-provider help / welcome card settings.
    | "welcomeCardEnabled"
    | "helpTriggers"
    | "welcomeText"
    // In-chat control-command permission gate (control-plane).
    | "controlCommands"
    // Token-usage presence config + runner state (usage-status-runner and
    // the UsagePresence settings form already write these — the whitelist
    // had silently lagged, tripping tsc at both call sites).
    | "presence"
    | "presenceState"
    // v106 (W1 multi-bot) — instance-level AI binding defaults.
    | "defaultTeamId"
    | "defaultWorkflowId"
    | "defaultModel"
    | "defaultProvider"
    | "defaultReasoning"
    | "builtInSkillCeiling"
    | "hostCapabilityCeiling"
    | "requireHitlForWrites"
    // v106 (W2 chat management) — scopes observed missing at runtime.
    | "lastMissingScopes"
    // v107 (W3 multi-bot) — declarative inbound dispatch rules.
    | "dispatchRules"
    // W5 (multi-bot same-group) — sibling-bot inbound guard.
    | "siblingBotPolicy"
    | "botInterplayBudget"
    // Multi-bot outbound: per-bot throttle/breaker tuning + circuit-open
    // failover targets (settings OutboundTuning card).
    | "outboundTuning"
    // ADR-0009 §3A.3 — bot-wide reply-quoting default (settings
    // ReplyQuotingDefault card).
    | "replyQuoting"
    // Bot-wide A2UI switch (tri-state — see the row's docblock).
    | "a2uiEnabled"
    | "failoverAdapterIds"
    // Multi-bot outbound: rate-limit spillover targets (load balancing).
    | "balanceAdapterIds"
    // Slice 1B — bot-wide response SLA + escalation chain defaults.
    | "defaultSlaResponseMinutes"
    | "defaultEscalation"
    // ADR-0117 — bot-wide composition axes. The row has carried these since
    // the axis model landed, but the whitelist did not, so they could not be
    // written even programmatically: the only values a conversation ever saw
    // were the ones derived from `defaultMode`.
    | "defaultAutonomy"
    | "defaultEngagement"
    | "defaultAuthority"
  >
>
