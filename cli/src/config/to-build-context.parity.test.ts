/**
 * @jest-environment node
 *
 * End-to-end parity: a CLI-shaped ctx run through the REAL `resolveSendOptions`
 * must produce a correctly-credentialed SendOptions — proving the CLI reuses
 * the desktop assembly rather than diverging. Uses a tmp cwd so project
 * instruction discovery finds nothing.
 */
import os from "node:os"

import { resolveSendOptions } from "@/lib/claude/build-options"

import { toBuildContext } from "./to-build-context"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "./schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"

function cfg(p: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: {},
    cwd: os.tmpdir(),
    ...p,
  }
}

describe("resolveSendOptions(toBuildContext(...)) — ai-sdk provider", () => {
  it("resolves provider + credentials + model + cwd from CLI config", async () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      config: cfg({
        provider: "openai",
        model: "gpt-4o-mini",
        providers: { openai: { apiKey: "sk-openai" } },
        cwd: os.tmpdir(),
      }),
    })
    const opts = await resolveSendOptions(ctx)
    expect(opts.provider).toBe("openai")
    expect(opts.model).toBe("gpt-4o-mini")
    expect(opts.providerCredentials?.apiKey).toBe("sk-openai")
    expect(opts.cwd).toBe(os.tmpdir())
    expect(opts.builtinTools?.coreFiles).toBe(true)
  })

  it("forwards the native-Anthropic api key as env", async () => {
    const ctx = toBuildContext({
      sessionId: "s2",
      config: cfg({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        providers: { anthropic: { apiKey: "sk-ant" } },
      }),
    })
    const opts = await resolveSendOptions(ctx)
    expect(opts.provider).toBe("anthropic")
    expect(opts.env?.ANTHROPIC_API_KEY).toBe("sk-ant")
  })
})
