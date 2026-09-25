/**
 * System-1 decisions (ADR-0194) — typed questions answered in one pass by a
 * decision model, never by free-text generation.
 *
 * The wire format is the TypeSafe "decisions" protocol (`POST {model, state,
 * questions}` → `{answers}`), which the local laya engine speaks too, so one
 * request shape serves the remote endpoints (OpenRouter `alpha/decisions`,
 * `/v1/systemone` gateways) and the laya plugin provider alike.
 *
 * Three question types:
 * - `noul`   — yes/no; answer is P(true) in 0..1.
 * - `choice` — pick one criteria key; answer carries a probability per key.
 * - `score`  — ordered levels; answer is the expected level (0 = first).
 */

export type DecisionQuestionType = "noul" | "choice" | "score"

export interface NoulQuestion {
  type: "noul"
  instructions: string
  /** Optional descriptions of what true / false mean. */
  criteria?: { true?: string; false?: string }
}

export interface ChoiceQuestion {
  type: "choice"
  instructions: string
  /** Option key → description. 2..255 entries. */
  criteria: Record<string, string>
}

export interface ScoreQuestion {
  type: "score"
  instructions: string
  /** Level descriptions, lowest first. At least 2. */
  criteria: string[]
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Questions keyed by answer id. */
export type DecisionQuestions = Record<string, DecisionQuestion>

/** Any JSON the questions reference by field name (e.g. `post`, `chat`). */
export type DecisionState = string | readonly unknown[] | { readonly [key: string]: unknown }

export interface DecisionRequest {
  state: DecisionState
  questions: DecisionQuestions
  /**
   * Path to a list inside `state` whose OLDEST entries a budget-limited
   * provider may drop first (e.g. `["chat", "messages"]`). Without it a local
   * encoder truncates the serialized state from the tail — for a chat that
   * silently drops the newest messages.
   */
  stateTrim?: string[]
}

export interface NoulAnswer {
  type: "noul"
  /** P(true), 0..1. */
  noul: number
  confidence?: number
}

export interface ChoiceAnswer {
  type: "choice"
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export interface ScoreAnswer {
  type: "score"
  /** Expected level, 0 = first criteria entry. */
  score: number
  /** Number of levels the question offered. */
  levels: number
  confidence: number
  probabilities?: Record<string, number>
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type DecisionAnswers = Record<string, DecisionAnswer>

/** What a local encoder cut from one question's head (instructions + options). */
export interface DecisionQuestionTruncation {
  instructionTokens: number
  instructionTokensKept: number
  optionsClipped: number
}

export interface DecisionRouting {
  /** Checkpoint / model that answered. */
  model: string
  reason?: string
}

export interface DecisionSuccess {
  ok: true
  providerId: string
  answers: DecisionAnswers
  latencyMs: number
  routing?: DecisionRouting
  /** Per-question head truncation, only for questions that lost tokens. */
  truncation?: Record<string, DecisionQuestionTruncation>
  /** How many oldest `stateTrim` entries were dropped to fit. */
  stateTrimmed?: number
  /** The state still overflowed after trimming; its tail was cut. */
  stateTruncated?: boolean
  /** PII values the host replaced with placeholders before sending. */
  redactions?: number
}

export const DECISION_ERROR_KINDS = [
  /** No provider selected, or the selected one is not installed. */
  "no_provider",
  /** Provider exists but cannot answer right now (model loading / failed). */
  "provider_unavailable",
  /** The remote endpoint has no URL / model / key configured. */
  "not_configured",
  /** The request (state / questions / stateTrim) is malformed. */
  "invalid_request",
  /** PII survived redaction; nothing was sent. */
  "pii",
  /** Transport failure reaching a remote endpoint. */
  "network",
  /** Remote endpoint answered with a non-2xx status. */
  "http_status",
  /** Web shell cannot reach a non-CORS endpoint. */
  "cors_unreachable",
  "timeout",
  "aborted",
  /** The calling plugin owns the selected provider (would recurse). */
  "recursive_provider",
  /** The provider failed in a way it could not classify. */
  "provider_error",
] as const

export type DecisionErrorKind = (typeof DECISION_ERROR_KINDS)[number]

export interface DecisionError {
  kind: DecisionErrorKind
  message: string
  /** HTTP status for `http_status`. */
  status?: number
}

export interface DecisionFailure {
  ok: false
  providerId?: string
  error: DecisionError
}

export type DecisionResult = DecisionSuccess | DecisionFailure

/**
 * A provider's raw reply. Providers return an envelope instead of throwing:
 * python-backed providers cross an RPC where exceptions arrive as bare strings,
 * so a typed error kind has to travel as data. The host normalizes `answers`
 * and maps unknown error kinds to `provider_error`.
 */
export type DecisionProviderResponse =
  | {
      ok: true
      answers: Record<string, unknown>
      latencyMs?: number
      routing?: unknown
      truncation?: unknown
      stateTrimmed?: number
      stateTruncated?: boolean
    }
  | {
      ok: false
      error: { kind: string; message: string; status?: number }
    }

/** Token budgets a local encoder packs questions into (see laya build_sequence). */
export interface DecisionProviderLimits {
  /** Instructions + rendered options per question. */
  headTokens?: number
  /** Whole sequence including the state. */
  inputTokens?: number
  /** Per-option cap. */
  optionTokens?: number
}

export interface DecisionProviderStatus {
  ready: boolean
  loading?: boolean
  /** Human-readable reason when not ready. */
  message?: string
}

/**
 * A decision backend. Descriptive fields are plain data — a python-backed
 * provider hands them over once, via `describe()`, at registration.
 */
export interface DecisionProvider {
  /** Registry id. Plugin providers are `<pluginId>:<id>`. */
  id: string
  label: string
  /** Plugin i18n key for `label` (resolved with `resolvePluginLabel`). */
  labelKey?: string
  /** Owning plugin; absent for host built-ins. */
  pluginId?: string
  /**
   * Where the provider says it runs. Display-only: the host redacts and
   * PII-gates every request regardless, because a plugin's claim to be local
   * is not something the host can verify.
   */
  locality: "local" | "remote"
  /** Answers carry calibrated probabilities (not model self-reports). */
  calibrated: boolean
  limits?: DecisionProviderLimits
  /**
   * Answer the questions. `options.signal` is best-effort: in-process
   * providers honor it; a python-backed provider cannot be interrupted across
   * the RPC, so the host races the signal instead.
   */
  decide(
    request: DecisionRequest,
    options?: { signal?: AbortSignal }
  ): Promise<DecisionProviderResponse>
  status?(): Promise<DecisionProviderStatus> | DecisionProviderStatus
}

/** Plain-data view of a provider for pickers and plugin listings. */
export interface DecisionProviderInfo {
  id: string
  label: string
  labelKey?: string
  pluginId?: string
  locality: "local" | "remote"
  calibrated: boolean
  limits?: DecisionProviderLimits
}

/** Remote decisions endpoints with a known URL + default model. */
export const DECISION_HTTP_PRESET_IDS = [
  "openrouter",
  "bocha",
  "typesafe",
  "vercel",
  "zen",
  "custom",
] as const

export type DecisionHttpPresetId = (typeof DECISION_HTTP_PRESET_IDS)[number]

/** `AppSettings.decisions` — which provider answers, and the remote endpoint. */
export interface DecisionSettings {
  /** Selected provider id; absent = no provider (features that need one stay inert). */
  providerId?: string
  /** Built-in remote endpoint config. The API key lives in the keyring. */
  http?: {
    preset: DecisionHttpPresetId
    /** Full POST URL; required for `custom`, overrides the preset URL otherwise. */
    url?: string
    /** Model id; falls back to the preset default. */
    model?: string
  }
}
