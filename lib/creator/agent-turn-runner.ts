/**
 * The real `CreatorTurnRunner` (ADR-0117, Phase 3).
 *
 * Kept apart from `agent-ports.ts` so the prompts and parsers stay testable in
 * the fast node environment; this file pulls in `resolveSendOptions` and the
 * whole send path behind it.
 *
 * Three properties it is responsible for:
 *
 *  1. **Read-only.** Every Creator agent turn runs at `plan` authority with a
 *     read-only tool set. The model proposes; `writeCreatorFile` is the only
 *     thing that writes, and it has its own gates. A generator that could write
 *     directly would bypass the permission diff entirely.
 *  2. **The reviewer gets a fresh session.** A new id per `review` turn, so it
 *     never inherits the generator's conversation. Independent context is the
 *     property that makes the review worth running.
 *  3. **The PII gate fronts the model call.** The prompt embeds user-authored
 *     requirements, which is the same posture as `lib/a2ui/ai-generate.ts` —
 *     the repo's red line is that locally-derived text passes `hasNoLeakingPii`
 *     before it reaches a provider.
 */

import { hasNoLeakingPii } from "@cognia/redact"

import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { ChatSession } from "@cognia/agent-config-types"
import type { CreatorTurnRequest, CreatorTurnRunner } from "./agent-ports"

/** Authority every Creator agent turn runs at. Never widened. */
export const CREATOR_AGENT_AUTHORITY = "plan" as const

/**
 * Read-only core tools the generator and reviewer may use.
 *
 * Pinned to the names in `lib/skills/recording/tool-catalog.ts`; an invented
 * name makes the turn silently tool-less rather than restricted.
 */
export const CREATOR_AGENT_TOOLS: readonly string[] = ["Read", "Glob", "Grep"]

export class CreatorPiiBlockedError extends Error {
  constructor(readonly purpose: CreatorTurnRequest["purpose"]) {
    super(`Creator ${purpose} prompt was blocked by the PII gate and was not sent`)
    this.name = "CreatorPiiBlockedError"
  }
}

function mintSessionId(purpose: CreatorTurnRequest["purpose"]): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
  return `creator-${purpose}-${suffix}`
}

export interface CreatorTurnRunnerOptions {
  signal?: AbortSignal
  /**
   * Session id for the survey and plan turns. Reused across both so the
   * generator keeps its own context; `review` always mints a fresh one
   * regardless of what is passed here.
   */
  authoringSessionId?: string
}

export function createCreatorTurnRunner(options: CreatorTurnRunnerOptions = {}): CreatorTurnRunner {
  const authoringSessionId = options.authoringSessionId ?? mintSessionId("plan")

  return async (request) => {
    if (!hasNoLeakingPii(request.prompt)) {
      throw new CreatorPiiBlockedError(request.purpose)
    }

    // The reviewer is isolated by construction: a new id every time, so there
    // is no way for a caller to accidentally hand it the generator's session.
    const sessionId = request.purpose === "review" ? mintSessionId("review") : authoringSessionId

    const sendOptions = await resolveSendOptions({
      session: { id: sessionId, workingDirectory: request.cwd } as unknown as ChatSession,
      appSettings: useSettingsStore.getState().settings,
    })

    const result = await runAndCaptureAssistantReply(
      sessionId,
      request.prompt,
      {
        ...sendOptions,
        cwd: request.cwd,
        // Re-asserted after the spread so a resolved default can never widen
        // a Creator turn past read-only.
        permissionMode: CREATOR_AGENT_AUTHORITY,
        allowedTools: [...CREATOR_AGENT_TOOLS],
      },
      {
        signal: options.signal,
        execution: { kind: "subagent", label: request.label },
      }
    )

    return result.text
  }
}
