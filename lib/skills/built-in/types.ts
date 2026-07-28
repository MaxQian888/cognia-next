/**
 * Built-in skill contracts (ADR-0026).
 *
 * A "built-in skill" is a code-reviewed first-party MCP tool the chat
 * assistant can call. Distinct from:
 *   - user-installable Skills (`lib/db/skills.ts`) — untrusted-content,
 *     prompt-only, NOT executable tools.
 *   - plugin tools (`lib/plugin/...`) — third-party loadable plugins
 *     that contribute tools via `ctx.agent.registerTool()`.
 *
 * Built-in skills live in-tree under `lib/skills/built-in/<family>/` and
 * self-register at module load via `registerBuiltInSkill()`. The renderer
 * holds the credentials and audit trail; the sidecar sees them as
 * synthetic MCP tools whose execution proxies back to the renderer via
 * the existing plugin-tools IPC channel.
 *
 * Trust model (matches ADR-0026):
 *   - `"read"`         skills: `imAccess: "always"`, no HITL, PII gate + audit only.
 *   - `"write"`        skills: HITL via A2UI confirm card by default;
 *                      `ConversationOverrideRow.requireHitlForWrites = false` opts out.
 *   - `"destructive"`  skills: HITL always; channel must opt-in via
 *                      `ConversationOverrideRow.allowedBuiltInSkillIds`.
 */

import type { z, ZodTypeAny } from "zod"

import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { Capability } from "@/types/connectors/capability"
import type {
  BuiltInSkillMutation,
  PlatformSkillCapability,
} from "@/types/connectors/skill-capability"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

export type { BuiltInSkillMutation, PlatformSkillCapability }

/**
 * IM access tier for a built-in skill.
 *
 *   - `"always"`   — assistant may invoke from any session (including IM
 *                    auto-mode) when `allowedBuiltInSkillIds` permits it.
 *                    Default for `mutation === "read"`.
 *   - `"opt-in"`   — channel must explicitly list the skill id in
 *                    `ConversationOverrideRow.allowedBuiltInSkillIds`.
 *                    Default for `mutation === "destructive"`.
 *   - `"readonly"` — exposed in IM only when channel sets
 *                    `allowedBuiltInSkillIds` (any value other than `[]`).
 *                    Reserved for future heuristics; v1 skills don't use this.
 *   - `"blocked"`  — never exposed in IM, only in desktop in-app chat.
 *                    Reserved for skills that should never round-trip
 *                    through a connector callback.
 */
export type BuiltInSkillImAccess = "always" | "readonly" | "opt-in" | "blocked"

/**
 * Bilingual labels follow the existing `i18n/messages/{en,zh-CN}.json`
 * pair convention. Settings UI reads the active locale; system prompts
 * default to English.
 */
export interface BilingualString {
  en: string
  "zh-CN": string
}

export interface BuiltInSkillContext {
  /** The chat session this invocation belongs to. */
  sessionId: string
  /**
   * Effective working directory resolved from the session or its linked
   * workspace. Filesystem-backed desktop skills are confined to this root.
   */
  workspaceRoot?: string
  /** Platform binding when the session is connector-bound. */
  imBinding?: {
    adapterId: string
    platform: PlatformKind
    conversationKey: string
  }
  /** Per-conversation override row, if any — drives HITL / allowlist gates. */
  imOverrideRow?: ConversationOverrideRow
  /**
   * Whether the dispatcher should bypass HITL. Set to `true` when re-firing
   * a skill in response to a user clicking "Confirm" on the A2UI confirm card.
   * The bus path sets this; assistant-driven first invocations never set it.
   */
  hitlBypass?: boolean
  /** Wall-clock for audit rows; defaults to `Date.now()`. */
  now?: number
}

/**
 * Result envelope returned by `runBuiltInSkill`. Three terminal shapes:
 *
 *   - `ok`              — skill executed; `data` is the JSON-safe result.
 *   - `pending_hitl`    — confirm card was sent; assistant should wait for
 *                         the callback. `bindingId` is the binding row id
 *                         the bus will resolve on callback arrival.
 *   - `denied`          — gate fired before execution; `reason` is a
 *                         machine-readable token (`pii_blocked`,
 *                         `not_allowed_for_channel`, `destructive_opt_in_required`).
 *   - `error`           — execution attempted but failed; `message` carries
 *                         the (PII-redacted) error.
 */
export type BuiltInSkillResult =
  | { status: "ok"; data: unknown }
  | { status: "pending_hitl"; bindingId: string; surfaceId: string }
  | { status: "denied"; reason: string; message: string }
  | { status: "error"; message: string }

/**
 * A single built-in skill. Implementations under
 * `lib/skills/built-in/<family>/<skill>.ts` call `registerBuiltInSkill()`
 * at module load with a frozen `BuiltInSkill` value.
 *
 * `inputSchema` is a Zod schema — it doubles as runtime arg validation
 * AND as the MCP tool's JSON-Schema (rendered via `zod-to-json-schema`
 * in `manifest.ts`). Keep schemas tight — overly-permissive shapes
 * widen the PII surface unnecessarily.
 */
export interface BuiltInSkill<Args extends ZodTypeAny = ZodTypeAny> {
  /** Stable globally-unique id, e.g. `"lark.calendar.list_events"`. */
  id: string
  /** Family grouping, e.g. `"lark.calendar"`. */
  family: string
  /** Bilingual display label for settings UI + prompt injection. */
  label: BilingualString
  /** Bilingual description shown in settings UI + MCP tool description. */
  description: BilingualString
  /** Adapters this skill is exposed on. `"any"` = cross-platform. */
  platforms: readonly PlatformKind[] | "any"
  /**
   * Channel capabilities the skill requires. The manifest filter drops
   * the skill from a channel that doesn't declare every entry — e.g. a
   * Lark calendar-create skill requires `["rich-card.lark"]` so the
   * HITL confirm card can render.
   */
  requires?: readonly Capability[]
  mutation: BuiltInSkillMutation
  imAccess: BuiltInSkillImAccess
  /**
   * MCP tool name as the assistant sees it, e.g. `"lark_calendar_list_events"`.
   * MUST be a valid JSON identifier; the manifest builder uses this verbatim.
   * Convention: family + skill suffix joined with `_`.
   */
  mcpToolName: string
  /** Zod schema validating the args the assistant passes to `execute`. */
  inputSchema: Args
  /**
   * Top-level arg fields that INTENTIONALLY carry contact identifiers
   * (emails / phone numbers / name queries) destined for the platform's OWN
   * directory API — e.g. `im.resolve_contact`'s lookup keys. The
   * dispatcher's serialized-args PII scan excludes exactly these fields
   * (they would otherwise hard-block the skill's entire purpose: the email
   * detector fires on every lookup); every other field is still scanned,
   * and the values remain visible in the HITL surface where one exists.
   * Use sparingly and only for identifier-lookup fields — never for free
   * text that leaves the platform's tenant.
   */
  piiArgFields?: readonly string[]
  /**
   * Skill body. Receives validated args + ctx. MUST NOT touch the DOM,
   * Tauri, or React. May call `execFile` to lark-cli, may hit Lark
   * OpenAPI directly, may read from Dexie via `lib/db/*` helpers.
   */
  execute: (args: z.infer<Args>, ctx: BuiltInSkillContext) => Promise<unknown>
  /**
   * Build the A2UI confirm surface for HITL. Required when
   * `mutation !== "read"`; the dispatcher refuses to register a write
   * or destructive skill without this. The surface MUST include two
   * Button components with action ids `"confirm"` and `"cancel"` so
   * the dispatcher's binding lookup can resolve the click.
   */
  hitlSurface?: (args: z.infer<Args>) => A2UISegmentContent
}
