/**
 * Model-backed inline completion — the provider that turns a draft into a
 * predicted continuation.
 *
 * The prompt construction and response cleanup are NOT reimplemented here: they
 * already exist, are already unit-tested, and are already tuned for this exact
 * job in `lib/chat/completion/ghost-prompt.ts`. This module only adapts them to
 * the {@link InlineCompletionProvider} contract, adds the gates a provider owes
 * the engine (PII, minimum length, slash-command suppression), and normalises
 * failure into `[]`.
 *
 * The model call itself is injected as `complete`, which is what makes the same
 * factory serve BOTH halves of "LLM or agent generated":
 *
 *   - pass a one-shot `LlmClient.complete` wrapper → `source: "ai"`;
 *   - pass a function that runs an agent/tool-using turn → `source: "agent"`,
 *     which outranks plain `ai` in {@link INLINE_SOURCE_PRIORITY} because it
 *     had more context to work from.
 *
 * Injecting the call also keeps this module free of provider-resolution and
 * credential concerns, so it is importable from the CLI (which resolves its
 * client through `buildRendererLlmClient`) and the renderer (which resolves
 * through `buildUtilityLlmClient`) without either leaking into the other.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import { buildGhostPrompt, sanitizeGhost } from "../ghost-prompt"
import { commandQuery } from "./command-provider"
import { extendsDraft } from "./rank"
import type {
  InlineCompletionContext,
  InlineCompletionProvider,
  InlineSuggestion,
  InlineSuggestionSource,
} from "./types"

/** Provider id for the built-in single-shot LLM source. */
export const AI_PROVIDER_ID = "builtin:ai"

/** Default minimum trimmed draft length before a model call is worth billing. */
const DEFAULT_MIN_CHARS = 3
/** Confidence reported for a model continuation, absent a better signal. */
const DEFAULT_AI_SCORE = 0.8

/** The model call the provider drives. Returns raw text, or null for "nothing". */
export type InlineCompleteFn = (args: {
  system: string
  prompt: string
  signal: AbortSignal
}) => Promise<string | null>

export interface AiCompletionProviderOptions {
  /** Runs the model. MUST honour `signal`; may throw (errors become `[]`). */
  complete: InlineCompleteFn
  /** Provider id. Defaults to {@link AI_PROVIDER_ID}. */
  id?: string
  /** Human label for settings / diagnostics. Defaults to `"AI"`. */
  label?: string
  /** Badge rendered beside the ghost. Defaults to the label. */
  detail?: string
  /**
   * Ranking source. `"ai"` for a single-shot completion, `"agent"` when
   * `complete` runs a tool-using agent turn. Defaults to `"ai"`.
   */
  source?: Extract<InlineSuggestionSource, "ai" | "agent">
  /** PII gate applied to the built prompt. Defaults to the shared redactor. */
  isPiiSafe?: (text: string) => boolean
  /** Minimum trimmed draft length. Defaults to 3. */
  minChars?: number
  /** Confidence reported on the suggestion. Defaults to 0.8. */
  score?: number
}

/**
 * Build a model-backed provider. Asynchronous — the engine debounces and caches
 * it rather than calling it per keystroke.
 */
export function createAiCompletionProvider(
  options: AiCompletionProviderOptions
): InlineCompletionProvider {
  const {
    complete,
    id = AI_PROVIDER_ID,
    label = "AI",
    detail = label,
    source = "ai",
    isPiiSafe = hasNoLeakingPii,
    minChars = DEFAULT_MIN_CHARS,
    score = DEFAULT_AI_SCORE,
  } = options

  return {
    id,
    label,
    priority: 30,
    sync: false,
    async getCompletions(
      context: InlineCompletionContext,
      signal: AbortSignal
    ): Promise<InlineSuggestion[]> {
      const { draft } = context
      if (draft.trim().length < minChars) return []
      // A lone `/token` is a command, not prose — the command provider and the
      // palette both handle it, and asking a model to continue it produces
      // confident nonsense. Suppress rather than compete.
      if (commandQuery(draft) !== null) return []
      if (signal.aborted) return []

      const { system, prompt } = buildGhostPrompt({
        draft,
        recentMessages: context.recentMessages,
      })
      // The gate runs on the assembled prompt, so it covers the draft AND the
      // conversation context that would travel with it.
      if (!isPiiSafe(prompt)) return []

      let raw: string | null
      try {
        raw = await complete({ system, prompt, signal })
      } catch {
        return []
      }
      if (signal.aborted || raw === null) return []

      const suffix = sanitizeGhost(raw, draft)
      if (suffix === null) return []
      const text = draft + suffix
      // `sanitizeGhost` already strips an echoed prefix, but a model that
      // returns pure whitespace would still yield a no-op "completion".
      if (!extendsDraft(text, draft)) return []

      return [{ text, source, providerId: id, detail, score }]
    },
  }
}
