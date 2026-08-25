// The `run_code` tool — the entire model-visible surface of the Code
// presentation (ADR-0117, Phase 4).
//
// In Code presentation the model is offered this one tool plus a `.d.ts` for
// the read-only SDK. Every `cognia.*` call inside the program re-enters the
// host's normal tool registry through `callTool`, so argument validation,
// permissions, confinement, logging and the canonical event stream all still
// apply. There is no path from generated code to a tool implementation that
// skips them.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { SandboxUnavailableError, probeSandbox, runCodeProgram } from "./supervisor.mjs"
import { generateSdkDeclaration } from "./sdk-declaration.mjs"

export const RUN_CODE_TOOL_NAME = "run_code"

const runCodeShape = {
  source: z
    .string()
    .describe(
      "JavaScript to run in the read-only sandbox. Runs as an async function body, " +
        "so top-level `await` and `return` both work. Call tools via `cognia.<tool>(input)`."
    ),
}

/**
 * Build the `run_code` tool definition.
 *
 * @param {object} deps
 * @param {(name: string, input: unknown) => Promise<unknown>} deps.callTool
 * @param {() => { canSpawnProcess: boolean, strictSandbox: boolean }} [deps.probe]
 * @param {Array<{ name: string, description?: string, inputSchema?: object }>} [deps.sdkTools]
 *        The eligible tools, for the generated SDK declaration. Empty means the
 *        description carries no API — the model then has a tool it cannot use,
 *        so callers should always pass this.
 */
export function createRunCodeTool({ callTool, probe = probeSandbox, sdkTools = [] }) {
  const description =
    "Run read-only JavaScript against the typed tool SDK. Cannot write, spawn, or reach the network." +
    (sdkTools.length > 0 ? `\n\n${generateSdkDeclaration(sdkTools)}` : "")

  return tool(RUN_CODE_TOOL_NAME, description, runCodeShape, async (args) => {
    try {
      const outcome = await runCodeProgram({
        source: String(args?.source ?? ""),
        callTool,
        probe: probe(),
      })

      if (outcome.ok) {
        return toolText({
          result: outcome.result,
          callsUsed: outcome.callsUsed,
          ...(outcome.logs.length > 0 ? { logs: outcome.logs } : {}),
        })
      }

      // A limit hit is reported with the ceiling that was reached, so the
      // model can shrink the program rather than retrying the same one.
      return toolText(
        {
          error: outcome.error,
          ...(outcome.limit ? { limit: outcome.limit } : {}),
          callsUsed: outcome.callsUsed,
          ...(outcome.logs.length > 0 ? { logs: outcome.logs } : {}),
        },
        {
          isError: true,
          // A ceiling, not a mistake in the call: repeating the same program
          // hits the same ceiling.
          failure: { kind: "resource-exhausted", retryable: false },
        }
      )
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        // Fail closed, and say so plainly. There is deliberately no degraded
        // path here: an unsandboxed fallback is the one outcome this feature
        // must never produce.
        return toolError(
          `Code mode is unavailable on this host because a strict sandbox could not be established (${error.reason}). ` +
            "There is no unsandboxed fallback; use the native tools instead.",
          RUN_CODE_TOOL_NAME
        )
      }
      return toolError(error, RUN_CODE_TOOL_NAME)
    }
  })
}

/**
 * The tool defs for the Code presentation: `run_code` and nothing else.
 *
 * Returns an empty array when the host cannot sandbox, so a Code-mode turn on
 * an unsupported host has no executor to reach at all rather than one that
 * refuses per call.
 */
export function codeModeToolDefs(deps) {
  const probe = (deps.probe ?? probeSandbox)()
  if (!probe.canSpawnProcess || !probe.strictSandbox) return []
  return [createRunCodeTool(deps)]
}

export { generateSdkDeclaration } from "./sdk-declaration.mjs"

// The SDK declaration is generated HERE, from `sdk-declaration.mjs`, because
// this is the only layer that has the tools' real `inputSchema`. The renderer
// only ever sees tool names, so a generator there would have had to invent
// signatures — and generated code that type-checks against an invented
// signature is worse than no declaration at all.
