// Nested Claude Agent SDK options carried on `SendOptions.claudeAgentSdk`
// (ADR-0090 SDK-parity plan §2.1).
//
// Why a nested block instead of more flat `SendOptions` fields: the SDK's
// `Options` has 63 fields and the sidecar builds its `query()` call from an
// explicit allowlist. Every new capability therefore needed a flat field, a
// line in the allowlist, and nothing telling anyone the two had diverged.
// Grouping them under one versioned key means the whole SDK-specific surface
// travels together, is validated in one place, and is obviously *SDK* config
// rather than something the AI-SDK or external rails should try to honour.
//
// Three rules hold for everything in here:
//
//   1. **Serialisable only.** This rides renderer -> Rust -> sidecar as JSON.
//      `hooks`, `canUseTool`, `onElicitation`, `onUserDialog`, `sessionStore`,
//      `stderr` and `spawnClaudeCodeProcess` are functions or objects with
//      methods; they are constructed IN the sidecar. What crosses the wire is a
//      descriptor saying whether and how to build one.
//   2. **No secrets.** Same constraint as `ResolvedAgentExecutionSpec`
//      (ADR-0090 §4): ids and references, never key material.
//   3. **Nothing that can spawn or read arbitrary host state.** `executable`,
//      `executableArgs`, `pathToClaudeCodeExecutable`, `debugFile`,
//      `spawnClaudeCodeProcess` and raw settings paths are host-only: they come
//      from trusted managed host config, never from a renderer payload. They
//      are deliberately absent from this type — absence is the enforcement.

/** `plugins` entry. Paths are canonicalised and root-checked host-side. */
export interface ClaudeAgentSdkPluginRef {
  type: "local"
  path: string
  skipMcpDiscovery?: boolean
}

/**
 * Sandbox settings, layered ON TOP of the sidecar's own workspace confinement
 * (`builtin-tools/confinement.mjs`) rather than replacing it. Two independent
 * gates is the intent: the SDK sandbox constrains the subprocess, confinement
 * constrains the tools Cognia itself serves.
 */
export interface ClaudeAgentSdkSandboxV1 {
  enabled?: boolean
  /** Refuse to run rather than silently continuing unsandboxed. */
  failIfUnavailable?: boolean
  autoAllowBashIfSandboxed?: boolean
  allowUnsandboxedCommands?: boolean
  network?: {
    allowedDomains?: string[]
    deniedDomains?: string[]
    strictAllowlist?: boolean
    allowLocalBinding?: boolean
    allowUnixSockets?: string[]
    allowAllUnixSockets?: boolean
  }
  filesystem?: {
    allowRead?: string[]
    denyRead?: string[]
    allowWrite?: string[]
    denyWrite?: string[]
    disabled?: boolean
  }
  credentials?: {
    /** Deny-listed credential FILES — paths only, never contents. */
    files?: Array<{ path: string; mode: "deny" }>
    /** Env vars the sandbox hides or masks. Names only, never values. */
    envVars?: Array<{ name: string; mode: "deny" | "mask"; injectHosts?: string[] }>
    allowPlaintextInject?: boolean
  }
  excludedCommands?: string[]
}

/**
 * Descriptor for the SDK `sessionStore`. The store itself is a live object with
 * `append` / `load` methods and is built in the sidecar against the Rust host
 * (ADR-0090: host_rpc, so headless and companion get it for free).
 *
 * `backend` is an enum, not a path: a renderer must not be able to name where
 * session data lands.
 */
export interface ClaudeAgentSdkSessionStoreRef {
  backend: "host-sqlite"
  /** Persisted namespace for resume after cwd changes; null selects the default namespace. */
  workspace?: string | null
  /**
   * `eager` fsyncs each append. Costlier, but the only setting under which a
   * crash cannot lose the tail of a session.
   */
  flush?: "batched" | "eager"
}

/**
 * Serialisable Claude Agent SDK options.
 *
 * `version` is a literal so an older sidecar can reject a shape it does not
 * understand instead of silently ignoring half of it — the same reason
 * `ResolvedAgentExecutionSpec` carries `specVersion`.
 */
export interface ClaudeAgentSdkOptionsV1 {
  version: 1

  // ---- structured output ----------------------------------------------------
  /**
   * The schema MUST be JSON Schema draft-07; the SDK rejects newer drafts. From
   * Zod: `z.toJSONSchema(s, { target: "draft-7" })`.
   */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> }

  // ---- session --------------------------------------------------------------
  sessionId?: string
  /** Resume the most recent session. Mutually exclusive with `resume`/`sessionId`. */
  continue?: boolean
  /** Message uuid to resume *at*, for partial replay. */
  resumeSessionAt?: string
  /**
   * Prompt uuid for the turn intentionally discarded by `resumeSessionAt`.
   * The SDK rejects the truncating resume when unrelated entries would also
   * be dropped, allowing callers to recover without silently losing history.
   */
  resumeDropsTurn?: string
  persistSession?: boolean
  title?: string
  sessionStore?: ClaudeAgentSdkSessionStoreRef

  /** Host-side warm-process pooling; not forwarded as an SDK `Options` field. */
  prewarm?: { enabled: boolean }

  // ---- checkpointing --------------------------------------------------------
  /**
   * File checkpointing. Requires user messages to carry uuids, which only
   * happens with `extraArgs: { 'replay-user-messages': null }` — the sidecar
   * adds that automatically rather than making every caller remember it.
   */
  enableFileCheckpointing?: boolean

  // ---- permissions ----------------------------------------------------------
  /**
   * Skip ALL permission prompts. Honoured only when `permissionMode` is
   * `bypassPermissions` AND the host policy plus an explicit user confirmation
   * both allow it; otherwise the turn fails closed. Setting it here is a
   * request, never a grant.
   */
  allowDangerouslySkipPermissions?: boolean
  permissionPromptToolName?: string
  planModeInstructions?: string
  permissionPrompts?: "host" | "none"
  perTaskStopAffordance?: boolean

  /** Current SDK thinking configuration; overrides the legacy token budget. */
  thinking?:
    | { type: "disabled" }
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
  /** Set snapshot=false when the host updates instructions between turns. */
  systemPrompt?:
    | string
    | string[]
    | { type: "custom"; prompt: string | string[]; snapshot?: boolean }
    | {
        type: "preset"
        preset: "claude_code"
        append?: string
        excludeDynamicSections?: boolean
        snapshot?: boolean
      }

  // ---- extension surfaces ---------------------------------------------------
  plugins?: ClaudeAgentSdkPluginRef[]
  pluginDelivery?: "argv" | "initialize"
  skills?: string[] | "all"
  toolAliases?: Record<string, string>
  toolConfig?: { askUserQuestion?: { previewFormat?: "markdown" | "html" } }
  tools?: string[] | { type: "preset"; preset: "claude_code" }

  // ---- interaction descriptors (callbacks are built sidecar-side) -----------
  /** MCP elicitation round-trips. */
  elicitation?: { enabled: boolean }
  /** Runtime-initiated dialogs. `kinds` maps to `supportedDialogKinds`. */
  userDialog?: { enabled: boolean; kinds?: string[] }

  // ---- observability --------------------------------------------------------
  includeHookEvents?: boolean
  agentProgressSummaries?: boolean
  promptSuggestions?: boolean

  // ---- limits ---------------------------------------------------------------
  taskBudget?: { total: number }
  loadTimeoutMs?: number

  // ---- sandbox --------------------------------------------------------------
  sandbox?: ClaudeAgentSdkSandboxV1

  // ---- escape hatches -------------------------------------------------------
  betas?: string[]
  /**
   * Raw CLI flags. Deliberately last and deliberately narrow: only explicitly
   * reviewed, content-free flags are accepted. Every other flag could reach
   * SDK behaviour this contract does not model.
   */
  extraArgs?: Record<string, string | null>
}

/** Raw CLI flags reviewed as not loading content or granting capabilities. */
const ALLOWED_EXTRA_ARGS = new Set(["verbose", "replay-user-messages"])

type Shape =
  | "string"
  | "boolean"
  | "number"
  | "record"
  | "nullable-string"
  | readonly Shape[]
  | { readonly [key: string]: Shape }
const stringArray: Shape = ["string"]
const optionShape: Record<keyof ClaudeAgentSdkOptionsV1, Shape> = {
  version: "number",
  outputFormat: { type: "string", schema: "record" },
  sessionId: "string",
  continue: "boolean",
  resumeSessionAt: "string",
  resumeDropsTurn: "string",
  persistSession: "boolean",
  title: "string",
  sessionStore: { backend: "string", flush: "string", workspace: "nullable-string" },
  prewarm: { enabled: "boolean" },
  enableFileCheckpointing: "boolean",
  allowDangerouslySkipPermissions: "boolean",
  permissionPromptToolName: "string",
  planModeInstructions: "string",
  permissionPrompts: "string",
  perTaskStopAffordance: "boolean",
  pluginDelivery: "string",
  thinking: "record",
  systemPrompt: "record",
  skills: "record",
  tools: "record",
  plugins: [{ type: "string", path: "string", skipMcpDiscovery: "boolean" }],
  toolAliases: "record",
  toolConfig: { askUserQuestion: { previewFormat: "string" } },
  elicitation: { enabled: "boolean" },
  userDialog: { enabled: "boolean", kinds: stringArray },
  includeHookEvents: "boolean",
  agentProgressSummaries: "boolean",
  promptSuggestions: "boolean",
  taskBudget: { total: "number" },
  loadTimeoutMs: "number",
  betas: stringArray,
  extraArgs: "record",
  sandbox: {
    enabled: "boolean",
    failIfUnavailable: "boolean",
    autoAllowBashIfSandboxed: "boolean",
    allowUnsandboxedCommands: "boolean",
    network: {
      allowedDomains: stringArray,
      deniedDomains: stringArray,
      strictAllowlist: "boolean",
      allowLocalBinding: "boolean",
      allowUnixSockets: stringArray,
      allowAllUnixSockets: "boolean",
    },
    filesystem: {
      allowRead: stringArray,
      denyRead: stringArray,
      allowWrite: stringArray,
      denyWrite: stringArray,
      disabled: "boolean",
    },
    credentials: {
      files: [{ path: "string", mode: "string" }],
      envVars: [{ name: "string", mode: "string", injectHosts: stringArray }],
      allowPlaintextInject: "boolean",
    },
    excludedCommands: stringArray,
  },
}

/** Reject unknown keys at the serialized boundary, including nested descriptors. */
function validateShape(value: unknown, shape: Shape, path: string, errors: string[]): void {
  if (typeof shape === "string") {
    if (shape === "nullable-string") {
      if (value !== null && typeof value !== "string")
        errors.push(`${path} must be a string or null`)
      return
    }
    if (
      shape === "record"
        ? !isRecord(value)
        : typeof value !== shape || (shape === "number" && !Number.isFinite(value))
    ) {
      errors.push(`${path} must be ${shape === "record" ? "an object" : `a ${shape}`}`)
    }
  } else if (Array.isArray(shape)) {
    if (!Array.isArray(value)) errors.push(`${path} must be an array`)
    else value.forEach((item, index) => validateShape(item, shape[0], `${path}[${index}]`, errors))
  } else if (!isRecord(value)) errors.push(`${path} must be an object`)
  else
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const child = Object.hasOwn(shape, key) ? (shape as Record<string, Shape>)[key] : undefined
      if (child === undefined) errors.push(`${path}.${key} is unsupported`)
      else validateShape(item, child, `${path}.${key}`, errors)
    }
}

/** Result of {@link validateClaudeAgentSdkOptions}. */
export interface ClaudeAgentSdkOptionsValidation {
  ok: boolean
  /** Hard failures. Non-empty means the turn must not start. */
  errors: string[]
  /**
   * Survivable conflicts, recorded so the caller can see which of two settings
   * won instead of guessing from behaviour.
   */
  warnings: string[]
}

/** Legacy flat fields the nested block overlaps with, for conflict detection. */
export interface ClaudeAgentSdkFlatContext {
  resume?: string
  forkSession?: boolean
  permissionMode?: string
  /** True once host policy AND an explicit user confirmation both passed. */
  bypassConfirmed?: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

// ---- structured output: the RESULT half -------------------------------------

/**
 * Outcome of a turn that ran with `outputFormat: { type: "json_schema" }`.
 *
 * Only `"ok"` means the caller got its typed value. The other three exist
 * separately because they need different handling and the SDK does not
 * distinguish them for you:
 *
 *  - `missing` — the SDK reported `subtype: "success"`, `is_error: false`, and
 *    no `structured_output`. The model answered in prose instead of the schema
 *    and the run "succeeded". Treating this as success is the trap: the caller
 *    then reads `undefined` out of a turn it believes worked.
 *  - `retries-exhausted` — `subtype: "error_max_structured_output_retries"`.
 *    The SDK re-asked and the model never conformed. Distinguishable from
 *    `missing` only by subtype, and worth distinguishing: a schema the model
 *    cannot satisfy is a schema problem, whereas `missing` is usually a prompt
 *    problem.
 *  - `turn-incomplete` — the turn ended on a ceiling or an execution error
 *    (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`)
 *    before structured output could exist. Reporting that as `missing` would
 *    blame the schema for a budget that ran out.
 */
export type StructuredOutcomeStatus = "ok" | "missing" | "retries-exhausted" | "turn-incomplete"

export interface StructuredOutcome {
  status: StructuredOutcomeStatus
  /**
   * The parsed value. Present only for `"ok"`, and `unknown` because only the
   * caller knows the schema it supplied.
   */
  output?: unknown
}

/** The subset of a result message this classification reads. */
export interface StructuredOutcomeInput {
  subtype?: string
  is_error?: boolean
  structured_output?: unknown
}

/**
 * Classify how a turn's structured output ended.
 *
 * Returns `null` when the turn never asked for structured output — there is no
 * outcome to report, and synthesising a `"missing"` for every ordinary chat
 * turn would make the status meaningless.
 *
 * `requested` has to be passed in because the result message does not say
 * whether a schema was supplied: `structured_output: undefined` looks identical
 * on a turn that wanted a value and a turn that never did. The caller who set
 * `outputFormat` is the only one who knows.
 *
 * The raw text is deliberately NOT carried here. It reaches consumers two ways
 * already — `SDKResultMessage.result` for the renderer, and the `text-delta`
 * events for the canonical log — and copying it into this outcome would put a
 * third copy of every answer into the event stream.
 */
export function classifyStructuredOutcome(
  result: StructuredOutcomeInput,
  requested: boolean
): StructuredOutcome | null {
  if (!requested) return null
  if (result.subtype === "error_max_structured_output_retries") {
    return { status: "retries-exhausted" }
  }
  if (result.subtype !== "success" || result.is_error === true) {
    return { status: "turn-incomplete" }
  }
  return result.structured_output === undefined
    ? { status: "missing" }
    : { status: "ok", output: result.structured_output }
}

/**
 * Whether a `claudeAgentSdk` block asks for structured output.
 *
 * One definition so the sidecar's mapper, the renderer and the tests cannot
 * drift on what "requested" means — the classification above is only as good as
 * the flag it is handed.
 */
export function expectsStructuredOutput(nested: unknown): boolean {
  return isRecord(nested) && isRecord(nested.outputFormat) && nested.outputFormat.type !== undefined
}

/**
 * Validate the nested block against itself and against the flat fields.
 *
 * The SDK throws on most of these combinations too — but it throws after
 * spawning the subprocess, i.e. after the turn has begun. ADR-0090 constraint 3
 * says capability gaps fail before any model spend, and a contradictory session
 * configuration is the same class of problem: cheaper and clearer to reject
 * here than to surface as a subprocess crash.
 */
export function validateClaudeAgentSdkOptions(
  value: unknown,
  flat: ClaudeAgentSdkFlatContext = {}
): ClaudeAgentSdkOptionsValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isRecord(value)) {
    return { ok: false, errors: ["claudeAgentSdk must be an object"], warnings }
  }
  if (value.version !== 1) {
    return { ok: false, errors: ["claudeAgentSdk.version must be 1"], warnings }
  }

  const { thinking, systemPrompt, skills, tools, ...plain } = value
  validateShape(plain, optionShape, "claudeAgentSdk", errors)
  const oneOf = (v: unknown, choices: unknown[], path: string) => {
    if (v !== undefined && !choices.includes(v))
      errors.push(`${path} must be one of ${choices.join(", ")}`)
  }
  if (thinking !== undefined) {
    const kind = isRecord(thinking) ? thinking.type : undefined
    oneOf(kind ?? null, ["disabled", "adaptive", "enabled"], "claudeAgentSdk.thinking.type")
    validateShape(
      thinking,
      kind === "disabled"
        ? { type: "string" }
        : kind === "adaptive"
          ? { type: "string", display: "string" }
          : { type: "string", display: "string", budgetTokens: "number" },
      "claudeAgentSdk.thinking",
      errors
    )
    if (isRecord(thinking)) {
      oneOf(thinking.display, ["summarized", "omitted"], "claudeAgentSdk.thinking.display")
      if (
        thinking.budgetTokens !== undefined &&
        (!Number.isInteger(thinking.budgetTokens) || Number(thinking.budgetTokens) <= 0)
      )
        errors.push("claudeAgentSdk.thinking.budgetTokens must be a positive integer")
    }
  }
  if (systemPrompt !== undefined) {
    if (typeof systemPrompt === "string" || Array.isArray(systemPrompt)) {
      validateShape(
        systemPrompt,
        typeof systemPrompt === "string" ? "string" : stringArray,
        "claudeAgentSdk.systemPrompt",
        errors
      )
    } else {
      const kind = isRecord(systemPrompt) ? systemPrompt.type : undefined
      oneOf(kind ?? null, ["custom", "preset"], "claudeAgentSdk.systemPrompt.type")
      const shape =
        kind === "custom"
          ? { type: "string", snapshot: "boolean" }
          : {
              type: "string",
              preset: "string",
              append: "string",
              snapshot: "boolean",
              excludeDynamicSections: "boolean",
            }
      const candidate =
        isRecord(systemPrompt) && kind === "custom"
          ? Object.fromEntries(Object.entries(systemPrompt).filter(([key]) => key !== "prompt"))
          : systemPrompt
      validateShape(candidate, shape as Shape, "claudeAgentSdk.systemPrompt", errors)
      if (isRecord(systemPrompt)) {
        if (kind === "custom")
          validateShape(
            systemPrompt.prompt,
            Array.isArray(systemPrompt.prompt) ? stringArray : "string",
            "claudeAgentSdk.systemPrompt.prompt",
            errors
          )
        else
          oneOf(systemPrompt.preset ?? null, ["claude_code"], "claudeAgentSdk.systemPrompt.preset")
      }
    }
  }
  if (skills !== undefined && skills !== "all")
    validateShape(skills, stringArray, "claudeAgentSdk.skills", errors)
  if (tools !== undefined) {
    validateShape(
      tools,
      Array.isArray(tools) ? stringArray : { type: "string", preset: "string" },
      "claudeAgentSdk.tools",
      errors
    )
    if (isRecord(tools)) {
      oneOf(tools.type ?? null, ["preset"], "claudeAgentSdk.tools.type")
      oneOf(tools.preset ?? null, ["claude_code"], "claudeAgentSdk.tools.preset")
    }
  }
  oneOf(value.permissionPrompts, ["host", "none"], "claudeAgentSdk.permissionPrompts")
  oneOf(value.pluginDelivery, ["argv", "initialize"], "claudeAgentSdk.pluginDelivery")
  if (errors.length) return { ok: false, errors, warnings }

  const opts = value as unknown as ClaudeAgentSdkOptionsV1
  oneOf(opts.sessionStore?.flush, ["batched", "eager"], "claudeAgentSdk.sessionStore.flush")
  oneOf(
    opts.toolConfig?.askUserQuestion?.previewFormat,
    ["markdown", "html"],
    "claudeAgentSdk.toolConfig.askUserQuestion.previewFormat"
  )
  for (const [key, item] of Object.entries(opts.toolAliases ?? {})) {
    if (typeof item !== "string") errors.push(`claudeAgentSdk.toolAliases.${key} must be a string`)
  }
  for (const item of opts.sandbox?.credentials?.files ?? []) {
    if (!item.path) errors.push("claudeAgentSdk.sandbox.credentials.files requires path")
    oneOf(item.mode ?? null, ["deny"], "claudeAgentSdk.sandbox.credentials.files.mode")
  }
  for (const item of opts.sandbox?.credentials?.envVars ?? []) {
    if (!item.name) errors.push("claudeAgentSdk.sandbox.credentials.envVars requires name")
    oneOf(item.mode ?? null, ["deny", "mask"], "claudeAgentSdk.sandbox.credentials.envVars.mode")
  }

  // ---- session-shape contradictions ------------------------------------------
  if (opts.sessionStore) {
    if (opts.persistSession === false) {
      errors.push(
        "claudeAgentSdk.sessionStore requires persistSession — a store with persistence " +
          "off would be written to and never read back"
      )
    }
    if (opts.enableFileCheckpointing) {
      errors.push(
        "claudeAgentSdk.sessionStore and enableFileCheckpointing are mutually exclusive: " +
          "the SDK owns checkpoint storage and cannot mirror it into a custom store"
      )
    }
    if (opts.sessionStore.backend !== "host-sqlite") {
      errors.push(`claudeAgentSdk.sessionStore.backend "${opts.sessionStore.backend}" is unknown`)
    }
  }

  const resumeSignals = [
    opts.continue ? "continue" : null,
    opts.sessionId ? "sessionId" : null,
    flat.resume ? "resume" : null,
  ].filter(Boolean) as string[]
  if (resumeSignals.length > 1) {
    errors.push(`conflicting session continuation: ${resumeSignals.join(" + ")} — pick exactly one`)
  }
  if (opts.resumeSessionAt && resumeSignals.length === 0) {
    errors.push("claudeAgentSdk.resumeSessionAt needs a session to resume (resume or sessionId)")
  }
  if (opts.resumeDropsTurn && !opts.resumeSessionAt) {
    errors.push("claudeAgentSdk.resumeDropsTurn requires resumeSessionAt")
  }
  if (flat.forkSession && !flat.resume) {
    errors.push("forkSession requires resume — there is nothing to fork from")
  }

  // ---- dangerous permissions -------------------------------------------------
  if (opts.allowDangerouslySkipPermissions) {
    if (flat.permissionMode !== "bypassPermissions") {
      errors.push(
        "allowDangerouslySkipPermissions requires permissionMode 'bypassPermissions'; " +
          `got '${flat.permissionMode ?? "default"}'`
      )
    }
    if (!flat.bypassConfirmed) {
      errors.push(
        "allowDangerouslySkipPermissions was requested without a confirmed host policy + " +
          "user confirmation — refusing to skip every permission prompt"
      )
    }
  }

  // ---- structured output -----------------------------------------------------
  if (opts.outputFormat) {
    if (opts.outputFormat.type !== "json_schema") {
      errors.push(`claudeAgentSdk.outputFormat.type "${opts.outputFormat.type}" is unsupported`)
    } else if (!isRecord(opts.outputFormat.schema)) {
      errors.push("claudeAgentSdk.outputFormat.schema must be a JSON Schema object")
    } else {
      const declared = opts.outputFormat.schema.$schema
      // The SDK accepts draft-07 only. Catching it here turns a mid-turn
      // rejection into a configuration error naming the exact fix.
      if (typeof declared === "string" && !declared.includes("draft-07")) {
        errors.push(
          `claudeAgentSdk.outputFormat.schema declares ${declared}; the SDK requires ` +
            'JSON Schema draft-07 (Zod: z.toJSONSchema(s, { target: "draft-7" }))'
        )
      }
    }
  }

  // ---- plugins / skills ------------------------------------------------------
  for (const plugin of opts.plugins ?? []) {
    if (plugin?.type !== "local") {
      errors.push(`claudeAgentSdk.plugins: unsupported plugin type "${plugin?.type}"`)
    } else if (typeof plugin.path !== "string" || plugin.path.length === 0) {
      errors.push("claudeAgentSdk.plugins: every entry needs a non-empty path")
    }
  }
  if (opts.skills !== undefined && opts.skills !== "all" && !Array.isArray(opts.skills)) {
    errors.push('claudeAgentSdk.skills must be a string array or "all"')
  }

  // ---- limits ----------------------------------------------------------------
  if (opts.taskBudget && !(opts.taskBudget.total > 0)) {
    errors.push("claudeAgentSdk.taskBudget.total must be a positive number")
  }
  if (opts.loadTimeoutMs !== undefined && !(opts.loadTimeoutMs > 0)) {
    errors.push("claudeAgentSdk.loadTimeoutMs must be a positive number")
  }

  // ---- escape hatch ----------------------------------------------------------
  for (const key of Object.keys(opts.extraArgs ?? {})) {
    if (opts.extraArgs?.[key] !== null && typeof opts.extraArgs?.[key] !== "string")
      errors.push(`claudeAgentSdk.extraArgs["${key}"] must be a string or null`)
    if (!ALLOWED_EXTRA_ARGS.has(key)) {
      errors.push(
        `claudeAgentSdk.extraArgs["${key}"] is refused: only reviewed, content-free ` +
          "CLI flags are allowed"
      )
    }
  }
  if (opts.enableFileCheckpointing && opts.extraArgs?.["replay-user-messages"] !== undefined) {
    warnings.push(
      'extraArgs["replay-user-messages"] is managed by the host when file checkpointing is ' +
        "on; the caller-supplied value is ignored"
    )
  }

  // ---- overlaps with the flat fields -----------------------------------------
  if (opts.sessionId && flat.resume) {
    // Already an error above; no second warning about the same pair.
  } else if (opts.tools && Array.isArray(opts.tools) && opts.tools.length === 0) {
    warnings.push("claudeAgentSdk.tools is an empty array — the turn will have no tools at all")
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Serializable MCP configurations accepted by an SDK subagent. */
export type AgentMcpServerConfig = (
  | {
      type?: "stdio"
      command: string
      args?: string[]
      env?: Record<string, string>
      alwaysLoad?: boolean
    }
  | {
      type: "sse" | "http"
      url: string
      headers?: Record<string, string>
      alwaysLoad?: boolean
      tools?: Array<{
        name: string
        permission_policy?: "always_allow" | "always_ask" | "always_deny"
        org_max_permission?: "allow" | "ask" | "blocked"
      }>
    }
  | { type: "sdk"; name: string }
) & { timeout?: number }

/** Renderer-to-host MCP configs contain only serializable external transports. */
export type McpServerWireConfig = Exclude<AgentMcpServerConfig, { type: "sdk" }> & {
  cwd?: string
  allowPrivateNetwork?: boolean
}

/** Shared SDK subagent definition, including Cognia renderer dispatch metadata. */
export interface AgentDefinition {
  /** Natural-language description shown to the dispatcher agent. */
  description: string
  /** System prompt the subagent runs with. */
  prompt: string
  /** Allowlist of tool names; omit to inherit the parent's tools. */
  tools?: string[]
  /** Tools to explicitly disallow. */
  disallowedTools?: string[]
  /** Model alias (`opus` / `sonnet` / `haiku`) or full id; defaults to the parent's model. */
  model?: string
  /**
   * Provider id this subagent runs on (`anthropic` / `openai` / `deepseek` / …).
   * Honored by the renderer dispatch path (`executeAgent` / `runCliSubagent`),
   * which can route a subagent to a DIFFERENT provider than the parent session.
   * NOTE: the SDK-native Task tool (Anthropic channel) ignores this — cross-
   * provider runs flow through the `dispatch_agent` plugin tool, not native Task.
   */
  provider?: string
  /** Max round-trips before the SDK stops looping the subagent. */
  maxTurns?: number
  /**
   * Reasoning effort dial. The SDK also accepts a raw integer here; the named
   * levels are what every Cognia surface offers, so the union stays named.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  /**
   * Display colour for this agent's rows and badges, so parallel runs are
   * telling apart at a glance (Claude Code and OpenCode `color:` parity). A
   * palette name or `#rrggbb`, normalised by `lib/claude/agents/agent-color`.
   * Never sent to the model.
   */
  color?: string

  // ---- SDK fields with no Cognia-side equivalent -----------------------------

  /**
   * Run this agent as a fire-and-forget background task when invoked, instead
   * of blocking the turn. The dispatching turn continues immediately and a
   * `task_notification` arrives when the agent settles.
   */
  background?: boolean
  /**
   * Scope for auto-loading this agent's memory files:
   * `user` → `~/.claude/agent-memory/<agentType>/`,
   * `project` → `.claude/agent-memory/<agentType>/`,
   * `local` → `.claude/agent-memory-local/<agentType>/`.
   * Unset means no memory is loaded — the SDK does not pick a default.
   */
  memory?: "user" | "project" | "local"
  /** Permission mode for this agent's tool calls, overriding the session's. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"
  /**
   * Agent type auto-spawned as a background OBSERVER whenever this agent runs.
   * The observer gets read-only activity digests and reports through the
   * ObserverReport tool; it never participates in the task itself.
   */
  observer?: string
  /** Extra postamble appended to each digest sent to {@link observer}. Blank is ignored. */
  observerMessage?: string
  /** Skill names preloaded into the agent's context. */
  skills?: string[]
  /**
   * Auto-submitted as the first user turn when this agent is the MAIN thread
   * agent (i.e. via `@agent`), prepended to anything the user typed. Slash
   * commands in it are processed. Ignored when the agent is dispatched as a
   * subagent rather than being the main thread.
   */
  initialPrompt?: string
  /**
   * MCP servers this agent may reach: either a server name already known to
   * the session, or an inline process-transport config.
   *
   * Distinct from {@link mcpServerIds}, which is the Cognia-side list used
   * when routing to an EXTERNAL agent preset. Both can be set; they are read
   * by different dispatch paths.
   */
  mcpServers?: Array<string | Record<string, AgentMcpServerConfig>>
  /** Experimental: critical reminder appended to this agent's system prompt. */
  criticalSystemReminder_EXPERIMENTAL?: string
  /**
   * Optional external-agent preset id backing this subagent (Thread A2). When
   * set, `dispatchSubagent` routes the run to the external CLI agent via the
   * {@link ExternalAgentManager} instead of the built-in executor; `prompt` /
   * `tools` remain advisory (the dispatcher still advertises the def by
   * `description`). Honored at execute-time only.
   */
  externalPresetId?: string
  /**
   * MCP server ids/names forwarded into the external agent's ACP session when
   * this subagent runs on an external preset (see {@link PluginSubagentDef}).
   * Ignored by the built-in executor. Honored at execute-time only.
   */
  mcpServerIds?: string[]
  /**
   * Opt this subagent into nested dispatch — when it runs, expose the
   * `dispatch_agent` tool so it can dispatch further subagents (up to the
   * effective depth cap). Default `false` (leaf). Gated by app-level
   * `subagentNesting.enabled`.
   */
  allowNesting?: boolean
  /** Per-subagent override of the max nesting level (combined via `min`). */
  maxDepth?: number
  /**
   * Hide from UI pickers / @-mention autocomplete while staying dispatchable
   * (OpenCode `hidden` semantics). Model-facing discovery is unaffected.
   */
  hidden?: boolean
  /** Fully off: excluded from dispatch, discovery, and every picker. */
  disabled?: boolean
}
