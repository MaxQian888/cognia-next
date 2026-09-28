import { errorMessage, type HookHandler, type HookOutcome, type HookDeps } from "../kernel/types.ts"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import { runCommandHandler, runCommandDetached } from "./command.ts"
import { runWebhookHandler } from "./webhook.ts"
import { runPluginHookHandler } from "./plugin.ts"
import { parseZeroExitOutput } from "../kernel/decision.ts"
import { HOOK_PII_BLOCK_REASON, handlerPolicyClass } from "../kernel/types.ts"

export function runHandler(
  handler: HookHandler | null | undefined,
  payloadJson: string,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
  deps: HookDeps = {}
): Promise<HookOutcome> {
  if (!handler || typeof handler !== "object") {
    return Promise.resolve({ warning: "invalid hook handler configuration" })
  }
  if (handler.type === "command" && typeof handler.command === "string") {
    if (handler.async === true) {
      // Fire-and-forget: spawn detached and resolve immediately — the child
      // may still be running when the turn ends, by design.
      return Promise.resolve(
        runCommandDetached({ ...handler, command: handler.command }, payloadJson, cwd, deps)
      )
    }
    return runCommandHandler(handler.command, handler.timeout, payloadJson, signal, cwd)
  }
  if ((handler.type === "http" || handler.type === "webhook") && typeof handler.url === "string") {
    return runWebhookHandler(handler.url, handler.headers, handler.timeout, payloadJson, signal)
  }
  if (handler.type === "plugin") {
    // The settings.json ⇄ plugin bridge. Redact before the payload leaves the
    // sidecar: a plugin handler is third-party code, so it gets the same
    // outbound treatment as an HTTP hook rather than the raw turn.
    const redactedPayloadJson = redactText(payloadJson).redacted
    if (!hasNoLeakingPiiDeep(redactedPayloadJson)) {
      return Promise.resolve({ block: HOOK_PII_BLOCK_REASON })
    }
    return runPluginHookHandler(handler, redactedPayloadJson, {
      emit: deps.emitRaw,
      sessionId: deps.sessionId,
      pendingPluginHookCalls: deps.pendingPluginHookCalls,
      newId: deps.newId,
    }).catch((e) => ({ warning: `plugin hook failed: ${errorMessage(e)}` }))
  }
  if (
    (handler.type === "prompt" || handler.type === "agent" || handler.type === "mcp_tool") &&
    typeof deps.executeNativeHandler === "function"
  ) {
    const redactedPayloadJson = redactText(payloadJson).redacted
    if (!hasNoLeakingPiiDeep(redactedPayloadJson)) {
      return Promise.resolve({ block: HOOK_PII_BLOCK_REASON })
    }
    return Promise.resolve()
      .then(() =>
        deps.executeNativeHandler!(handler, redactedPayloadJson, {
          signal,
          depth: deps.hookDepth ?? 0,
        })
      )
      .then((result) => {
        if (result && typeof result.output === "string") return parseZeroExitOutput(result.output)
        return result ?? {}
      })
      .catch((error) => ({
        warning: `hook ${handler.type} failed: ${errorMessage(error)}`,
      }))
  }
  if (handler.type === "prompt" || handler.type === "agent" || handler.type === "mcp_tool") {
    return Promise.resolve({ warning: `hook ${handler.type} runtime adapter unavailable` })
  }
  return Promise.resolve({})
}

export function applyFailurePolicy(
  handler: HookHandler | null | undefined,
  outcome: HookOutcome
): HookOutcome {
  if (handlerPolicyClass(handler) !== "managed" || !outcome?.warning || outcome.block) {
    return outcome
  }
  return { ...outcome, block: `Managed hook failed closed: ${outcome.warning}` }
}
