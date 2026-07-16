/**
 * `cognia-agent run "<prompt>"` (or `cognia-agent -p "<prompt>"`) — headless
 * one-shot turn.
 *
 * Flags: --model --provider --cwd --system --allow a,b --yes --timeout
 *        --max-turns --output-format text|json|stream-json (--json ⇒ stream-json)
 *        --plugin-tools --dev-plugins [--dev-plugins-dir <dir>].
 *
 * Prompt sources merge like pi/Claude Code: the positional prompt and piped
 * stdin are both honored (stdin appended as context, or used alone when no
 * positional is given). Output formats:
 *   - text         final assistant text streamed to stdout (default).
 *   - stream-json  every capture event as JSONL + a final `{type:"result"}` line.
 *   - json         a single buffered `{type:"result"}` object (no event lines).
 */

import type { CliConfigFile } from "../config/schema"
import { loadConfig as defaultLoadConfig } from "../config/load"
import { createPermissionGate } from "../agent/permission-gate"
import { runHeadlessTurn as defaultRun } from "../agent/run"
import { maybePushHandoff as defaultPushHandoff } from "./handoff-cmd"
import { boolFlag, numberFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

/** Machine-readable output modes (Claude-Code-aligned triad). */
export type OutputFormat = "text" | "json" | "stream-json"

/** Reject a piped prompt larger than this (Claude Code uses the same 10 MB cap). */
export const MAX_STDIN_BYTES = 10 * 1024 * 1024

export interface RunDeps {
  loadConfig?: (flags?: Partial<CliConfigFile>) => ReturnType<typeof defaultLoadConfig>
  run?: typeof defaultRun
  pushHandoff?: typeof defaultPushHandoff
  out?: OutputSink
  /** Prompt supplied by the caller (the `-p`/bare shorthand reconstructs it from
   * the command + positionals). When set, it replaces the positional join. */
  promptOverride?: string
  /** Read the piped (non-TTY) stdin as the merged prompt source. Defaults to
   * draining `process.stdin` when it is not a TTY, else "". Injected in tests. */
  readStdin?: () => Promise<string>
}

/** Drain piped stdin (non-TTY) to a string; "" on a TTY or when empty. */
async function defaultReadStdin(): Promise<string> {
  const stdin = process.stdin
  if (stdin.isTTY) return ""
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stdin) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_STDIN_BYTES) {
      throw new Error(`piped input exceeds ${MAX_STDIN_BYTES} bytes`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** Resolve the output format from `--output-format`, falling back to `--json`. */
export function resolveOutputFormat(args: ParsedArgs): OutputFormat {
  const raw = stringFlag(args, "output-format")
  if (raw === "text" || raw === "json" || raw === "stream-json") return raw
  if (raw !== undefined) {
    throw new Error(`invalid --output-format "${raw}" (expected text|json|stream-json)`)
  }
  // Back-compat: the original `--json` boolean maps to the streaming form.
  return boolFlag(args, "json") ? "stream-json" : "text"
}

/** Combine the positional/override prompt with piped stdin (pi/Claude merge). */
export function mergePrompt(argPrompt: string, stdin: string): string {
  const a = argPrompt.trim()
  const s = stdin.trim()
  if (a && s) return `${a}\n\n${s}`
  return a || s
}

/** Map run flags onto the config loader's override layer. */
export function runFlagsToOverrides(args: ParsedArgs): Partial<CliConfigFile> {
  const flags: Partial<CliConfigFile> = {}
  const model = stringFlag(args, "model")
  if (model) flags.model = model
  const provider = stringFlag(args, "provider")
  if (provider) flags.provider = provider
  const backend = stringFlag(args, "backend")
  if (backend) flags.agentBackend = backend
  const cwd = stringFlag(args, "cwd")
  if (cwd) flags.cwd = cwd
  const system = stringFlag(args, "system")
  if (system) flags.systemPrompt = system
  const allow = stringFlag(args, "allow")
  if (allow) {
    flags.allowedTools = allow
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  // `--max-turns` bounds the ai-sdk channel's agentic step budget too (the
  // Anthropic channel reads `SendOptions.maxTurns`, patched in `runHeadlessTurn`).
  const maxTurns = numberFlag(args, "max-turns")
  if (maxTurns !== undefined && maxTurns >= 1) flags.aiSdkMaxSteps = Math.floor(maxTurns)
  // Opt-in gate for in-tree plugin tool execution (off by default). Reaches the
  // session through `config.pluginTools`, which `session-runner` reads to
  // bootstrap the plugin runtime + subscribe the `plugin_tool_exec` round-trip.
  if (boolFlag(args, "plugin-tools")) flags.pluginTools = true
  // Dev mode: load the repo's in-tree `plugins/<id>` as live disk plugins. Implies
  // plugin tools (the runtime + round-trip must be active for them to be callable).
  if (boolFlag(args, "dev-plugins")) {
    flags.devPlugins = true
    flags.pluginTools = true
  }
  const devDir = stringFlag(args, "dev-plugins-dir")
  if (devDir) {
    flags.devPluginsDir = devDir
    flags.devPlugins = true
    flags.pluginTools = true
  }
  return flags
}

export async function runCommand(args: ParsedArgs, deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const loadConfig = deps.loadConfig ?? defaultLoadConfig
  const run = deps.run ?? defaultRun

  let format: OutputFormat
  try {
    format = resolveOutputFormat(args)
  } catch (err) {
    out.error((err as Error).message)
    return 2
  }

  const argPrompt =
    deps.promptOverride !== undefined ? deps.promptOverride : args.positionals.join(" ")
  let stdin = ""
  try {
    stdin = await (deps.readStdin ?? defaultReadStdin)()
  } catch (err) {
    out.error(`run: ${(err as Error).message}`)
    return 2
  }
  const prompt = mergePrompt(argPrompt, stdin)
  if (!prompt) {
    out.error('run: a prompt is required — e.g. cognia-agent run "fix the bug" (or pipe via stdin)')
    return 2
  }

  let config: ReturnType<typeof defaultLoadConfig>
  try {
    config = loadConfig(runFlagsToOverrides(args))
  } catch (err) {
    out.error(`config error: ${(err as Error).message}`)
    return 2
  }

  const allowList = (() => {
    const a = stringFlag(args, "allow")
    return a
      ? a
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
  })()
  const gate = createPermissionGate({ yes: boolFlag(args, "yes"), allow: allowList })

  const timeoutRaw = stringFlag(args, "timeout")
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined
  const maxTurns = numberFlag(args, "max-turns")

  const streamEvents = format === "stream-json"
  let streamedText = false
  try {
    const result = await run({
      config,
      prompt,
      gate,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      ...(maxTurns !== undefined && maxTurns >= 1 ? { maxTurns: Math.floor(maxTurns) } : {}),
      onEvent: (event) => {
        if (streamEvents) {
          out.json(event)
          return
        }
        if (format === "text" && event.type === "text-delta" && event.delta) {
          out.write(event.delta)
          streamedText = true
        }
      },
    })

    if (format === "text") {
      // Non-streaming providers emit no text-delta; print the final reply once.
      if (!streamedText) out.write(result.text)
      out.write("\n")
    } else {
      // Both `json` and `stream-json` end with the authoritative result object;
      // `json` emits ONLY this line, `stream-json` appends it after the events.
      out.json({
        type: "result",
        sessionId: result.sessionId,
        text: result.text,
        usage: result.usage,
        sdkSessionId: result.sdkSessionId,
      })
    }

    // --handoff: push this session to a running desktop to continue there.
    if (boolFlag(args, "handoff")) {
      const push = deps.pushHandoff ?? defaultPushHandoff
      await push(result.sessionId, prompt, { out })
    }
    return 0
  } catch (err) {
    out.error(`run failed: ${(err as Error).message}`)
    return 1
  }
}
