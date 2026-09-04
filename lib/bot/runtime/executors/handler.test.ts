import type { BotExecutorContext } from "./types"
import { BotExecutorUnavailableError } from "./types"
import { runHandlerBot } from "./handler"

function ctx(overrides: Partial<BotExecutorContext> = {}): BotExecutorContext {
  return {
    runId: "run_1",
    installationId: "boti_1",
    botId: "acme:digest",
    event: {} as BotExecutorContext["event"],
    config: {},
    signal: new AbortController().signal,
    step: {} as BotExecutorContext["step"],
    log: jest.fn(),
    progress: jest.fn(),
    installation: {} as BotExecutorContext["installation"],
    definition: {
      id: "acme:digest",
      name: "Digest",
      version: "1.0.0",
      executor: "handler",
      triggers: [],
      source: "plugin",
    },
    composition: { selection: { presetId: "standard" }, provenance: {} } as never,
    policy: {},
    ...overrides,
  }
}

describe("runHandlerBot", () => {
  it("passes the context straight through to the plugin's handler", async () => {
    const handler = jest.fn().mockResolvedValue({ summary: "done" })
    const context = ctx({
      definition: { ...ctx().definition, handler },
    })

    expect(await runHandlerBot(context)).toEqual({ summary: "done" })
    expect(handler).toHaveBeenCalledWith(context)
  })

  it("reports unavailable, not failed, when the module never resolved", async () => {
    // Retrying the same delivery will not make a disabled plugin appear.
    await expect(runHandlerBot(ctx())).rejects.toThrow(BotExecutorUnavailableError)
  })
})
