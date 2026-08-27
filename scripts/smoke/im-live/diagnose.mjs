// Turn the two independent observations into a verdict and a shortlist.
//
// The runner can see exactly two things: whether the prompt reached the model
// fixture, and what the target bot posted back into the conversation. It
// cannot read the app's Dexie audit rows — those live in the desktop
// renderer. So instead of guessing a single cause, this maps the 2×2 to a
// verdict plus the candidate causes worth checking, each with where to look.
//
// The row that matters most is "no fixture hit, but a reply appeared": the
// loop worked, but the answer came from the user's real provider rather than
// the fixture. That is both a failed test and real token spend, so it gets its
// own status instead of being folded into FAIL.

import { containsMarker } from "./marker.mjs"

export const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  TIMEOUT: "TIMEOUT",
  MODEL_NOT_INTERCEPTED: "MODEL_NOT_INTERCEPTED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  DOCTOR_FAILED: "DOCTOR_FAILED",
})

/** Non-zero exit for anything that is not a clean pass or an absent platform. */
export const FAILING_STATUSES = Object.freeze([
  STATUS.FAIL,
  STATUS.TIMEOUT,
  STATUS.MODEL_NOT_INTERCEPTED,
  STATUS.DOCTOR_FAILED,
])

/**
 * Candidate causes for "the message never reached the model".
 *
 * Ordered most-likely-first for a harness that was working yesterday. Each
 * names the gate in product code so the operator can read the actual rule
 * rather than trust this list.
 */
const INBOUND_NEVER_ARRIVED = [
  {
    code: "transport_not_connected",
    detail:
      "The target adapter's transport is not connected, so the platform never delivered the event.",
    where: "Check the adapter's Health badge in Settings → Connections.",
  },
  {
    code: "sibling_identity_unknown",
    detail:
      "The sibling-bot anti-loop gate failed closed: another ENABLED adapter of the same platform " +
      "has no confirmed identity, so the driver's message could not be proven to be a human's. " +
      "The message is recorded in history but no AI turn runs.",
    where:
      "lib/connectors/bus.ts step 9.6 + lib/connectors/sibling-bots.ts. Disable or " +
      "successfully start the other same-platform adapter, then retry.",
  },
  {
    code: "at_mention_required",
    detail:
      "Group messages only admit a turn when the bot is @-mentioned or the message replies to " +
      "one of the bot's own messages.",
    where:
      "lib/connectors/conversation-admission.ts — confirm the probe really mentioned the target bot.",
  },
  {
    code: "auto_mode_off",
    detail:
      "The target conversation is not in an auto-reply mode, so the turn is stored rather than run.",
    where: "The conversation's mode in the app's Inbox.",
  },
  {
    code: "chat_allow_or_block_list",
    detail: "The test conversation is outside chatAllowlist, or listed in chatBlocklist.",
    where: "lib/connectors/at-gate.ts gateInboundEvent.",
  },
  {
    code: "quiet_hours",
    detail: "The adapter is muted or inside its configured quiet hours.",
    where: "lib/connectors/outbound-runner.ts isInQuietHours.",
  },
  {
    code: "pii_blocked",
    detail: "The PII gate refused to send the prompt to a model and wrote an audit row instead.",
    where: 'lib/connectors/ai-loop/safe-send-prompt.ts — audit reason "pii_blocked".',
  },
]

const MODEL_NOT_INTERCEPTED_CAUSES = [
  {
    code: "vault_provider_overrides_base_url",
    detail:
      "A provider configured in the app's vault supplied its own base URL (or an OAuth bearer), " +
      "which overrides the ANTHROPIC_BASE_URL that pnpm im:test:target injected.",
    where:
      "src-tauri/src/claude/host.rs inject_provider_env. Clear the custom Base URL for the " +
      "active provider, or point it at the fixture, then restart the target.",
  },
  {
    code: "frozen_execution_spec_rebuilds_env",
    detail:
      "The turn carried a frozen execution spec, so the claude-code subprocess environment was " +
      "rebuilt from an allowlist and the inherited ANTHROPIC_BASE_URL was dropped.",
    where: "sidecar/dispatch/subprocess-env.mjs ENV_ALLOWLIST (see the COMPAT GATE comment).",
  },
  {
    code: "target_started_without_the_fixture",
    detail:
      "The app under test was started with plain `pnpm tauri dev` instead of `pnpm im:test:target`.",
    where: "Restart it with `pnpm im:test:target`.",
  },
]

const OUTBOUND_FAILED = [
  {
    code: "outbound_deadlettered",
    detail: "The reply was produced but its outbound job failed or dead-lettered.",
    where: "lib/connectors/outbound-runner.ts + the adapter's Activity log.",
  },
  {
    code: "outbound_permission",
    detail: "The target bot lacks permission to post into this conversation.",
    where: "The platform's app/bot permission settings for this chat.",
  },
  {
    code: "outbound_rate_limited",
    detail: "The platform throttled the reply, or the adapter's circuit breaker is open.",
    where: "lib/connectors/circuit-breaker.ts and the adapter's rate-limit tuning.",
  },
]

/**
 * @param {{ fixtureHit: object|null, replies: Array<{ text?: string }>, marker: string }} input
 * @returns {{ status: string, summary: string, causes: Array<{code:string,detail:string,where:string}>, markerReplyCount: number, extraReplyCount: number }}
 */
export function diagnoseTurn({ fixtureHit, replies = [], marker }) {
  const markerReplies = replies.filter((reply) => containsMarker(reply?.text ?? "", marker))
  const extraReplyCount = replies.length - markerReplies.length
  const base = { markerReplyCount: markerReplies.length, extraReplyCount }

  if (!fixtureHit) {
    if (replies.length === 0) {
      return {
        ...base,
        status: STATUS.TIMEOUT,
        summary:
          "The prompt never reached the model fixture and the target bot never replied — " +
          "the inbound message was dropped before the AI turn.",
        causes: INBOUND_NEVER_ARRIVED,
      }
    }
    return {
      ...base,
      status: STATUS.MODEL_NOT_INTERCEPTED,
      summary:
        "The target bot replied, but the model fixture never saw the prompt: this turn was " +
        "answered by a REAL model and billed accordingly. Fix the routing before trusting any result.",
      causes: MODEL_NOT_INTERCEPTED_CAUSES,
    }
  }

  if (replies.length === 0) {
    return {
      ...base,
      status: STATUS.FAIL,
      summary:
        "The model fixture answered, but no reply reached the conversation — outbound failed.",
      causes: OUTBOUND_FAILED,
    }
  }

  if (markerReplies.length === 0) {
    return {
      ...base,
      status: STATUS.FAIL,
      summary:
        `The target bot replied ${replies.length} time(s), but no reply carried this run's marker — ` +
        "the reply belongs to a different turn (a concurrent consumer, or a crossed conversation).",
      causes: [
        {
          code: "reply_marker_mismatch",
          detail: "Another runner or a human may be driving the same conversation.",
          where: "Check for a second `pnpm im:test:live` against this chat, then re-run.",
        },
      ],
    }
  }

  if (markerReplies.length > 1) {
    return {
      ...base,
      status: STATUS.FAIL,
      summary:
        `The target bot answered this turn ${markerReplies.length} times — the inbound event was ` +
        "consumed more than once, or two bots are answering each other.",
      causes: [
        {
          code: "duplicate_consumption",
          detail: "Inbound dedup did not collapse a redelivered event into one side effect.",
          where:
            "lib/db/connector-inbound-jobs.ts (durable job) and lib/connectors/dedup.ts (ledger).",
        },
        {
          code: "bot_interplay_loop",
          detail: "Two adapters in the chat are replying to each other.",
          where: "lib/connectors/bus.ts step 9.6 siblingBotPolicy / botInterplayBudget.",
        },
      ],
    }
  }

  return {
    ...base,
    status: STATUS.PASS,
    summary: "The prompt reached the model fixture and exactly one marked reply came back.",
    causes: [],
  }
}

/** Human-readable block for stderr. Values are already redacted by the caller. */
export function formatDiagnosis(diagnosis) {
  const lines = [`${diagnosis.status}: ${diagnosis.summary}`]
  if (diagnosis.causes.length > 0) lines.push("  candidate causes:")
  for (const cause of diagnosis.causes) {
    lines.push(`    - [${cause.code}] ${cause.detail}`)
    lines.push(`      → ${cause.where}`)
  }
  return lines.join("\n")
}
