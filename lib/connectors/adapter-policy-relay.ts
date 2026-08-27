/**
 * `adapter_update_policy` — wire payload → the per-section patches a host applies.
 *
 * This relay is the only way a paired client (a phone, a web companion, or a
 * desktop driving another host) can change how a bot behaves. Until the request
 * schema grew the fields below it could change four things: the legacy mode
 * mirror, mute, and the quiet-hours window. The mobile sheet nonetheless
 * rendered the composition axes and the A2UI switch, sent them, and had the
 * whole request rejected by the contract's `additionalProperties: false` — the
 * local mirror moved, the host never heard, and the next sync pull put the old
 * values back.
 *
 * Two conventions the surface depends on:
 *
 *   - **Absent means "leave it"; `null` means "unpin it".** JSON has no
 *     `undefined`, so omission cannot carry a clear. That is why every optional
 *     field is nullable on the wire rather than merely optional — without it,
 *     an axis pinned once could never be un-pinned from a phone.
 *   - **`undefined` in a Dexie patch removes the key.** Verified against the
 *     Dexie 4 in this repo: `Table.update(id, { pinned: undefined })` deletes
 *     `pinned` rather than storing it. That is what turns a wire `null` into an
 *     actually-unpinned axis, and it is why nothing here hand-rolls a `modify`
 *     pass to unset a field.
 *
 * Patches come back grouped by `AdapterConfigSection` so a relayed change
 * leaves the same audit trail as the desktop card that owns those fields — one
 * `adapter.config_changed` row per section touched, not one blanket row that
 * says "something changed".
 */

import {
  isAgentAuthority,
  isAutonomyLevel,
  isEngagementMode,
} from "@cognia/agent-config-types/agent-composition"

import type { AdapterConfigSection, AdapterInstancePatch } from "@/lib/db/adapter-instances"
import type { ImHostCapabilityId } from "@/lib/db/connector-types"
import type {
  ActiveRunDispatchMode,
  ConnectorMode,
  InboundActivationPolicy,
  TriggerBlocker,
  TriggerPolicy,
  TriggerRule,
} from "@/types/connectors/policy"

export interface AdapterPolicySectionPatch {
  section: AdapterConfigSection
  patch: AdapterInstancePatch
}

export interface AdapterPolicyRelay {
  id: string
  /** Only sections the payload actually spoke about. Never empty-patched. */
  sections: AdapterPolicySectionPatch[]
}

const MODES: readonly ConnectorMode[] = ["auto", "manual", "draft"]
const ACTIVATION_POLICIES: readonly InboundActivationPolicy[] = [
  "mention_each",
  "mention_activates",
  "always",
  "direct_only",
]
const DISPATCH_MODES: readonly ActiveRunDispatchMode[] = ["queue", "steer"]
const HOST_CAPABILITIES: readonly ImHostCapabilityId[] = [
  "computer_use",
  "ocr",
  "goal_driving",
  "schedule_tools",
]

function fail(field: string, expected: string): never {
  throw new Error(`adapter_update_policy.${field} must be ${expected}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function present(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key)
}

function memberOf<T extends string>(values: readonly T[]): (raw: unknown) => raw is T {
  return (raw: unknown): raw is T =>
    typeof raw === "string" && (values as readonly string[]).includes(raw)
}

/**
 * Read a field that may be cleared. `null` on the wire becomes `undefined` in
 * the patch, which is what Dexie removes the key for.
 */
function nullable<T>(
  raw: unknown,
  guard: (value: unknown) => value is T,
  field: string,
  expected: string
): T | undefined {
  if (raw === null) return undefined
  if (!guard(raw)) fail(field, expected)
  return raw
}

function stringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    fail(field, "an array of strings")
  }
  return raw as string[]
}

function nonNegativeInt(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    fail(field, "a non-negative integer")
  }
  return raw
}

function parseTriggerRule(raw: unknown, field: string): TriggerRule {
  if (!isRecord(raw)) fail(field, "an object")
  switch (raw.kind) {
    case "private-default":
    case "self-mention":
    case "reply-to-bot":
      return { kind: raw.kind }
    case "slash-command":
      return { kind: "slash-command", prefixes: stringList(raw.prefixes, `${field}.prefixes`) }
    case "keyword": {
      if (typeof raw.caseInsensitive !== "boolean") fail(`${field}.caseInsensitive`, "a boolean")
      return {
        kind: "keyword",
        words: stringList(raw.words, `${field}.words`),
        caseInsensitive: raw.caseInsensitive,
      }
    }
    case "user-allowlist":
      return { kind: "user-allowlist", userIds: stringList(raw.userIds, `${field}.userIds`) }
    case "channel-allowlist":
      return {
        kind: "channel-allowlist",
        channelIds: stringList(raw.channelIds, `${field}.channelIds`),
      }
    default:
      return fail(
        `${field}.kind`,
        "one of private-default | self-mention | reply-to-bot | slash-command | keyword | user-allowlist | channel-allowlist"
      )
  }
}

function parseTriggerBlocker(raw: unknown, field: string): TriggerBlocker {
  if (!isRecord(raw)) fail(field, "an object")
  switch (raw.kind) {
    case "user-blocklist":
      return { kind: "user-blocklist", userIds: stringList(raw.userIds, `${field}.userIds`) }
    case "channel-blocklist":
      return {
        kind: "channel-blocklist",
        channelIds: stringList(raw.channelIds, `${field}.channelIds`),
      }
    case "keyword-blocklist":
      return { kind: "keyword-blocklist", words: stringList(raw.words, `${field}.words`) }
    case "rate-limit": {
      const blocker: TriggerBlocker = {
        kind: "rate-limit",
        perUserPerMin: nonNegativeInt(raw.perUserPerMin, `${field}.perUserPerMin`),
        perChannelPerMin: nonNegativeInt(raw.perChannelPerMin, `${field}.perChannelPerMin`),
      }
      // Optional by design: a single-tenant install has no workspace ceiling,
      // and writing `0` instead of omitting it would silence the bot entirely.
      if (raw.perTenantPerMin !== undefined && raw.perTenantPerMin !== null) {
        blocker.perTenantPerMin = nonNegativeInt(raw.perTenantPerMin, `${field}.perTenantPerMin`)
      }
      return blocker
    }
    case "cooldown-after-bot-reply":
      return { kind: "cooldown-after-bot-reply", secs: nonNegativeInt(raw.secs, `${field}.secs`) }
    default:
      return fail(
        `${field}.kind`,
        "one of user-blocklist | channel-blocklist | keyword-blocklist | rate-limit | cooldown-after-bot-reply"
      )
  }
}

/**
 * Replaced wholesale, never merged. A trigger rule carries no id and the order
 * of the list is not meaningful (rules are OR'd), so there is nothing stable
 * for a per-rule patch to address — the editor always sends the whole policy.
 */
function parseTriggerPolicy(raw: unknown): TriggerPolicy {
  if (!isRecord(raw)) fail("trigger", "an object")
  if (!Array.isArray(raw.rules)) fail("trigger.rules", "an array")
  if (!Array.isArray(raw.blockers)) fail("trigger.blockers", "an array")
  if (typeof raw.storeUnmatchedInDraftMode !== "boolean") {
    fail("trigger.storeUnmatchedInDraftMode", "a boolean")
  }
  return {
    rules: raw.rules.map((rule, index) => parseTriggerRule(rule, `trigger.rules[${index}]`)),
    blockers: raw.blockers.map((blocker, index) =>
      parseTriggerBlocker(blocker, `trigger.blockers[${index}]`)
    ),
    storeUnmatchedInDraftMode: raw.storeUnmatchedInDraftMode,
  }
}

function parseQuietHours(raw: unknown): { from: string; to: string; tz: string } | undefined {
  if (raw === null) return undefined
  if (!isRecord(raw)) fail("quietHours", "an object or null")
  const { from, to, tz } = raw
  if (typeof from !== "string" || typeof to !== "string" || typeof tz !== "string") {
    fail("quietHours", "an object with string from / to / tz, or null")
  }
  return { from, to, tz }
}

function parseHostCapabilityCeiling(raw: unknown): ImHostCapabilityId[] | undefined {
  if (raw === null) return undefined
  if (!Array.isArray(raw)) fail("hostCapabilityCeiling", "an array or null")
  const isCapability = memberOf(HOST_CAPABILITIES)
  for (const entry of raw) {
    if (!isCapability(entry)) {
      fail("hostCapabilityCeiling", `an array of ${HOST_CAPABILITIES.join(" | ")}`)
    }
  }
  // An EMPTY array is not the same as a cleared one: it clamps every
  // host-owned capability off, where `null` means "no extra clamp at all".
  return raw as ImHostCapabilityId[]
}

/**
 * Turn one relayed payload into the sections a host should write.
 *
 * Throws — rather than dropping the offending field — on anything malformed.
 * A silently discarded rule is a bot that answers messages the operator
 * believed it would ignore, which is exactly the failure a relay must not hide.
 */
export function parseAdapterPolicyRelay(payload: Record<string, unknown>): AdapterPolicyRelay {
  const id = payload.id
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("adapter_update_policy.id is required")
  }

  const behavior: AdapterInstancePatch = {}
  const delivery: AdapterInstancePatch = {}
  const permissions: AdapterInstancePatch = {}
  const trigger: AdapterInstancePatch = {}

  // The legacy mirror. Not nullable: every row carries a mode, and routing
  // still projects axes from it when none are pinned.
  if (present(payload, "defaultMode")) {
    const raw = payload.defaultMode
    if (!memberOf(MODES)(raw)) fail("defaultMode", MODES.join(" | "))
    behavior.defaultMode = raw
  }

  if (present(payload, "defaultAutonomy")) {
    behavior.defaultAutonomy = nullable(
      payload.defaultAutonomy,
      isAutonomyLevel,
      "defaultAutonomy",
      "an autonomy level or null"
    )
  }
  if (present(payload, "defaultEngagement")) {
    behavior.defaultEngagement = nullable(
      payload.defaultEngagement,
      isEngagementMode,
      "defaultEngagement",
      "an engagement mode or null"
    )
  }
  if (present(payload, "defaultAuthority")) {
    behavior.defaultAuthority = nullable(
      payload.defaultAuthority,
      isAgentAuthority,
      "defaultAuthority",
      "an authority level or null"
    )
  }
  if (present(payload, "inboundActivationPolicy")) {
    behavior.inboundActivationPolicy = nullable(
      payload.inboundActivationPolicy,
      memberOf(ACTIVATION_POLICIES),
      "inboundActivationPolicy",
      `${ACTIVATION_POLICIES.join(" | ")} or null`
    )
  }
  if (present(payload, "activeRunDispatchMode")) {
    behavior.activeRunDispatchMode = nullable(
      payload.activeRunDispatchMode,
      memberOf(DISPATCH_MODES),
      "activeRunDispatchMode",
      `${DISPATCH_MODES.join(" | ")} or null`
    )
  }
  if (present(payload, "activationTtlMs")) {
    const raw = payload.activationTtlMs
    behavior.activationTtlMs =
      raw === null
        ? undefined
        : typeof raw === "number" && Number.isInteger(raw) && raw > 0
          ? raw
          : fail("activationTtlMs", "a positive integer or null")
  }
  if (present(payload, "a2uiEnabled")) {
    // Tri-state at the bot scope: `null` is not "off", it restores "whatever
    // this channel supports".
    behavior.a2uiEnabled = nullable(
      payload.a2uiEnabled,
      (value): value is boolean => typeof value === "boolean",
      "a2uiEnabled",
      "a boolean or null"
    )
  }

  if (present(payload, "muted")) {
    if (typeof payload.muted !== "boolean") fail("muted", "a boolean")
    delivery.muted = payload.muted
  }
  if (present(payload, "quietHours")) {
    delivery.quietHours = parseQuietHours(payload.quietHours)
  }

  if (present(payload, "hostCapabilityCeiling")) {
    permissions.hostCapabilityCeiling = parseHostCapabilityCeiling(payload.hostCapabilityCeiling)
  }

  if (present(payload, "trigger")) {
    trigger.trigger = parseTriggerPolicy(payload.trigger)
  }

  const sections: AdapterPolicySectionPatch[] = []
  const push = (section: AdapterConfigSection, patch: AdapterInstancePatch) => {
    if (Object.keys(patch).length > 0) sections.push({ section, patch })
  }
  push("behavior", behavior)
  push("trigger", trigger)
  push("permissions", permissions)
  push("delivery", delivery)
  return { id, sections }
}

/**
 * The patch a relaying client should apply to its own mirror.
 *
 * Derived from the very payload it is about to send, so the local row can only
 * ever show what the host is going to hold. The mobile sheet used to build the
 * two independently and they drifted in both directions: it cleared axes
 * locally that the wire could not carry, and it sent fields the wire rejected
 * — either way the phone reported a policy the bot was not running, until the
 * next sync pull quietly overwrote it.
 *
 * Sections collapse into one patch here because a client mirror has no audit
 * trail to keep them apart; the host is where the per-section breadcrumbs are
 * written.
 */
export function adapterPolicyMirrorPatch(payload: Record<string, unknown>): AdapterInstancePatch {
  return Object.assign({}, ...parseAdapterPolicyRelay(payload).sections.map((s) => s.patch))
}
