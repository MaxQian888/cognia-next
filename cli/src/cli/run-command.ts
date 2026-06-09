/**
 * `cognia-agent run "<prompt>"` — headless one-shot turn.
 *
 * Flags: --model --provider --cwd --system --allow a,b --yes --json --timeout.
 * Default output streams the assistant text to stdout; `--json` emits the
 * capture stream + a final `{type:"result"}` line for scripting/CI.
 */

import type { CliConfigFile } from "../config/schema"
import { loadConfig as defaultLoadConfig } from "../config/load"
import { createPermissionGate } from "../agent/permission-gate"
import { runHeadlessTurn as defaultRun } from "../agent/run"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface RunDeps {
  loadConfig?: (flags?: Partial<CliConfigFile>) => ReturnType<typeof defaultLoadConfig>
  run?: typeof defaultRun
  out?: OutputSink
}

/** Map run flags onto the config loader's override layer. */
export function runFlagsToOverrides(args: ParsedArgs): Partial<CliConfigFile> {
  const flags: Partial<CliConfigFile> = {}
  const model = stringFlag(args, "model")
  if (model) flags.model = model
  const provider = stringFlag(args, "provider")
  if (provider) flags.provider = provider
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
  return flags
}

export async function runCommand(args: ParsedArgs, deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const loadConfig = deps.loadConfig ?? defaultLoadConfig
  const run = deps.run ?? defaultRun

  const prompt = args.positionals.join(" ").trim()
  if (!prompt) {
    out.error('run: a prompt is required — e.g. cognia-agent run "fix the bug"')
    return 2
  }

  let config: ReturnType<typeof defaultLoadConfig>
  try {
    config = loadConfig(runFlagsToOverrides(args))
  } catch (err) {
    out.error(`config error: ${(err as Error).message}`)
    return 2
  }

  const json = boolFlag(args, "json")
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

  let streamedText = false
  try {
    const result = await run({
      config,
      prompt,
      gate,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      onEvent: (event) => {
        if (json) {
          out.json(event)
          return
        }
        if (event.type === "text-delta" && event.delta) {
          out.write(event.delta)
          streamedText = true
        }
      },
    })

    if (json) {
      out.json({
        type: "result",
        sessionId: result.sessionId,
        text: result.text,
        usage: result.usage,
        sdkSessionId: result.sdkSessionId,
      })
    } else {
      // Non-streaming providers emit no text-delta; print the final reply once.
      if (!streamedText) out.write(result.text)
      out.write("\n")
    }
    return 0
  } catch (err) {
    out.error(`run failed: ${(err as Error).message}`)
    return 1
  }
}
