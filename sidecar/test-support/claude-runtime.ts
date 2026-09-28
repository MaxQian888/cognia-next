import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { SendOptions } from "../src/shared/wire/inbound.ts"
import type { RuntimeDeps } from "../src/runtimes/claude-agent-sdk/runtime-types.ts"
import { dispatchAnthropic } from "../src/runtimes/claude-agent-sdk/index.ts"

/** Inspect the real dispatcher with a local, injected SDK query. */
export function captureClaudeRuntime(
  sendOptions: SendOptions,
  query: NonNullable<RuntimeDeps["query"]>
) {
  let options!: Options
  const events: Record<string, unknown>[] = []
  const session = dispatchAnthropic(
    {
      sessionId: "test-session",
      firstPrompt: "hello",
      sendOptions: { toolSurface: "none", ...sendOptions },
      emit: (event) => {
        events.push(event)
      },
      log() {},
    },
    {
      query: (params) => {
        options = params.options
        return query(params)
      },
    }
  )
  return { session, options, events }
}
