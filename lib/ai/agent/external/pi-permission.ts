/**
 * Permission matrix for Pi's NATIVE tools (ADR-0119).
 *
 * Cognia's own projected tools are gated by the tool-host broker's
 * `authorize()`. Pi's built-in `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash`
 * never touch that path — they execute inside the Pi process — so the bundled
 * Cognia extension intercepts them via `pi.on("tool_call")`.
 *
 * The policy is computed HERE, in the app, where it is typechecked and tested,
 * and handed to the extension as data. The extension performs a lookup and
 * owns no policy of its own: `sidecar/` is outside both the root tsconfig and
 * Jest, so any decision logic living there would be permanently unverified and
 * free to drift from this table.
 *
 * Two layers enforce the restrictive modes, deliberately:
 *   1. this table, applied per call by the extension, and
 *   2. Pi's own `--tools` allowlist pinned at spawn (see `processToolFloor`),
 *      which holds even if the extension never loads.
 */

/** Pi's built-in tools, as reported by `pi --help` and `tool-policy.ts`. */
export const PI_BUILTIN_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const
export type PiBuiltinTool = (typeof PI_BUILTIN_TOOLS)[number]

/** Tools that only observe. Safe to auto-allow in every mode but `dontAsk`. */
export const PI_READ_ONLY_TOOLS: readonly PiBuiltinTool[] = ["read", "grep", "find", "ls"]
/** Tools that change files. */
export const PI_EDIT_TOOLS: readonly PiBuiltinTool[] = ["edit", "write"]

export type PiToolDecision =
  /** Run it without asking. */
  | "allow"
  /** Surface a confirmation to the user before running. */
  | "ask"
  /** Refuse, with no prompt — the mode has already decided. */
  | "deny"

/**
 * The resolved per-tool decisions for one session.
 *
 * Serialized to the extension verbatim, so it is plain data with no functions
 * and no behaviour to reimplement on the other side.
 */
export interface PiToolPolicy {
  /** Echoed for diagnostics; the extension never re-derives from it. */
  mode: string
  decisions: Record<string, PiToolDecision>
  /** Applied to any tool absent from `decisions` — an extension-provided tool. */
  fallback: PiToolDecision
}

/**
 * Resolve the native-tool policy for a permission mode.
 *
 * `allowedTools` is consulted only under `dontAsk`, matching
 * `SessionCreateOptions.allowedTools` and the ACP semantics of that mode:
 * pre-approved tools run silently, everything else is refused WITHOUT a
 * prompt. Asking there would defeat the mode's entire purpose.
 */
export function resolvePiToolPolicy(
  mode: string | undefined,
  allowedTools: readonly string[] = []
): PiToolPolicy {
  const decisions: Record<string, PiToolDecision> = {}
  const set = (tools: readonly string[], decision: PiToolDecision) => {
    for (const tool of tools) decisions[tool] = decision
  }

  switch (mode) {
    case "bypassPermissions":
      // Still inside the strict sandbox — "bypass" means no prompts, never
      // no containment (ADR-0077).
      set(PI_BUILTIN_TOOLS, "allow")
      return { mode: "bypassPermissions", decisions, fallback: "allow" }

    case "acceptEdits":
      set(PI_READ_ONLY_TOOLS, "allow")
      set(PI_EDIT_TOOLS, "allow")
      // A shell can do everything `edit` can and more, so accepting edits is
      // not consent to arbitrary commands.
      decisions.bash = "ask"
      return { mode: "acceptEdits", decisions, fallback: "ask" }

    case "plan":
      set(PI_READ_ONLY_TOOLS, "allow")
      set(PI_EDIT_TOOLS, "deny")
      // Denied rather than asked: plan mode's promise is that nothing changes,
      // and a prompt the user can accept would break that promise.
      decisions.bash = "deny"
      return { mode: "plan", decisions, fallback: "deny" }

    case "dontAsk": {
      const preapproved = new Set(allowedTools)
      for (const tool of PI_BUILTIN_TOOLS) {
        decisions[tool] = preapproved.has(tool) ? "allow" : "deny"
      }
      return { mode: "dontAsk", decisions, fallback: "deny" }
    }

    default:
      set(PI_READ_ONLY_TOOLS, "allow")
      set(PI_EDIT_TOOLS, "ask")
      decisions.bash = "ask"
      return { mode: "default", decisions, fallback: "ask" }
  }
}

/** Look up one tool's decision, falling back for unknown/extension tools. */
export function decidePiTool(policy: PiToolPolicy, toolName: string): PiToolDecision {
  return policy.decisions[toolName] ?? policy.fallback
}

/** Env var carrying the serialized policy to the bundled extension. */
export const PI_TOOL_POLICY_ENV = "COGNIA_TOOLHOST_PI_POLICY"

export function encodePiToolPolicy(policy: PiToolPolicy): string {
  return JSON.stringify(policy)
}

/**
 * The reading of an unreadable policy: deny everything.
 *
 * Not `plan`. `plan` still grants `read`/`grep`/`find`/`ls`, which is a real
 * capability handed out on the strength of input we just failed to parse. The
 * shipped extension — the component that actually enforces this — has always
 * denied everything here, so the app-side decoder claiming to "mirror" it while
 * granting four tools was a documented equivalence that did not hold.
 */
const UNREADABLE_POLICY: PiToolPolicy = { mode: "unreadable", decisions: {}, fallback: "deny" }

/**
 * Parse a serialized policy, falling back to the most restrictive reading.
 *
 * Fail-closed by construction: a policy that cannot be read must not become
 * "allow everything", and must not quietly become "allow the read-only set"
 * either. Kept byte-for-byte in step with `readPolicy` in
 * `sidecar/pi-extension/cognia-pi-extension.ts`, which the parity test in this
 * module's spec pins.
 */
export function decodePiToolPolicy(raw: string | undefined): PiToolPolicy {
  if (!raw) return UNREADABLE_POLICY
  try {
    const parsed = JSON.parse(raw) as Partial<PiToolPolicy>
    if (!parsed || typeof parsed !== "object" || typeof parsed.decisions !== "object") {
      return UNREADABLE_POLICY
    }
    const decisions: Record<string, PiToolDecision> = {}
    for (const [tool, decision] of Object.entries(parsed.decisions ?? {})) {
      if (decision === "allow" || decision === "ask" || decision === "deny") {
        decisions[tool] = decision
      }
    }
    const fallback =
      parsed.fallback === "allow" || parsed.fallback === "ask" || parsed.fallback === "deny"
        ? parsed.fallback
        : "deny"
    return { mode: typeof parsed.mode === "string" ? parsed.mode : "unknown", decisions, fallback }
  } catch {
    return UNREADABLE_POLICY
  }
}

// ============================================================================
// Native-tool approval marker
// ============================================================================

/**
 * Versioned marker that distinguishes a Cognia NATIVE-TOOL APPROVAL from any
 * other dialog an extension might raise.
 *
 * Both matter, but they are different things and must reach different UI. An
 * approval is "may this agent run `bash`?", which belongs in the existing tool
 * approval dialog with its allow/deny/allow-always affordances and its audit
 * trail. A `confirm`/`select`/`input` from some other extension is just a
 * question, and belongs in the generic elicitation surface.
 *
 * Pi's `confirm` request carries only `{id, method, title, message}` — there is
 * no metadata field — so the marker has to ride inside one of the strings. It
 * goes in `title` rather than `message` because the elicitation fallback
 * renders `message` to the user: if a future Cognia emits `v2` and this build
 * does not recognise it, the dialog degrades to a readable question instead of
 * showing the user a marker string.
 *
 * Versioned because the mapper matches it EXACTLY. An unrecognised version must
 * fall through to elicitation rather than be interpreted as an approval by a
 * build that does not understand its payload.
 */
export const PI_PERMISSION_MARKER = "cognia-permission/v1"

/** The payload a native-tool approval carries alongside the marker. */
export interface PiPermissionMarkerPayload {
  /** The Pi native tool being requested, e.g. `bash` / `write`. */
  tool: string
  /** The permission mode that produced the `ask`, for the audit trail. */
  mode: string
  /**
   * The call's own arguments, when they fit.
   *
   * Without them the approval read "Allow bash?" and nothing else: the command
   * about to run was not on screen, and for `write`/`edit` neither was the
   * change. Every other agent Cognia drives sends its tool input with the
   * request, so this is the field that lets Pi's approval render the same
   * summary and the same diff instead of a bare tool name.
   *
   * Optional because it is carried inside a dialog title, which is not the
   * place for an unbounded payload — see {@link PI_PERMISSION_INPUT_LIMIT}. A
   * caller that drops it still gets the human-readable message.
   */
  input?: Record<string, unknown>
}

/**
 * How much serialized tool input an approval may carry.
 *
 * The arguments ride inside a dialog title on Pi's stdio wire, so a 5 MB file
 * body would push a single frame through the transport for a preview nobody
 * can read. Past this the input is dropped and the prompt falls back to the
 * message the extension wrote, which names the tool and its target.
 */
export const PI_PERMISSION_INPUT_LIMIT = 16_000

/** Build the `title` for a native-tool approval dialog. */
export function encodePiPermissionTitle(payload: PiPermissionMarkerPayload): string {
  return `${PI_PERMISSION_MARKER} ${JSON.stringify(withBoundedInput(payload))}`
}

/**
 * Drop the tool input when it does not fit the title.
 *
 * Fails toward a smaller prompt, never toward an unsendable frame: an approval
 * that cannot be transmitted blocks the tool with no way for the user to answer.
 */
export function withBoundedInput(payload: PiPermissionMarkerPayload): PiPermissionMarkerPayload {
  if (!payload.input) return payload
  let serialized: string
  try {
    serialized = JSON.stringify(payload.input)
  } catch {
    // Circular or otherwise unserializable: the message still describes the call.
    const { input: _dropped, ...rest } = payload
    return rest
  }
  if (serialized.length <= PI_PERMISSION_INPUT_LIMIT) return payload
  const { input: _tooBig, ...rest } = payload
  return rest
}

/**
 * Read a native-tool approval back out of a dialog title, or `undefined` when
 * this is an ordinary extension dialog.
 *
 * Fails closed into "not an approval": anything it cannot parse stays an
 * elicitation, which asks the user a question rather than silently granting a
 * tool.
 */
export function decodePiPermissionTitle(title: unknown): PiPermissionMarkerPayload | undefined {
  if (typeof title !== "string") return undefined
  if (!title.startsWith(`${PI_PERMISSION_MARKER} `)) return undefined
  try {
    const parsed = JSON.parse(title.slice(PI_PERMISSION_MARKER.length + 1)) as unknown
    if (!parsed || typeof parsed !== "object") return undefined
    const { tool, mode, input } = parsed as Partial<PiPermissionMarkerPayload>
    if (typeof tool !== "string" || !tool) return undefined
    return {
      tool,
      mode: typeof mode === "string" ? mode : "unknown",
      // An older extension sends no input at all, and a hostile one could send
      // anything: only a plain object becomes tool arguments.
      ...(input && typeof input === "object" && !Array.isArray(input)
        ? { input: input as Record<string, unknown> }
        : {}),
    }
  } catch {
    return undefined
  }
}
