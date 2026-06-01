import {
  __resetBuiltinCompletionProvidersForTesting,
  buildAutocompleteContext,
  ensureBuiltinCompletionProviders,
} from "./builtins"
import { __resetCompletionRegistryForTesting, getCompletions } from "./registry"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { TerminalCompletionContext } from "./types"

function ctx(over: Partial<TerminalCompletionContext> = {}): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "bash",
    shellPath: "/bin/bash",
    cwd: "/x",
    input: "git ",
    cursor: 4,
    recentCommands: ["git status"],
    platform: "linux",
    ...over,
  }
}

const signal = new AbortController().signal

beforeEach(() => {
  __resetCompletionRegistryForTesting()
  __resetBuiltinCompletionProvidersForTesting()
})

describe("buildAutocompleteContext", () => {
  it("derives the shell kind and mirrors the cursor to input end", () => {
    const c = buildAutocompleteContext({
      sessionId: "s9",
      shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      cwd: "/repo",
      recentCommands: ["ls"],
      input: "Get-",
      platform: "windows",
    })
    expect(c.shell).toBe("pwsh")
    expect(c.cursor).toBe(4)
    expect(c.sessionId).toBe("s9")
  })
})

describe("ensureBuiltinCompletionProviders", () => {
  function fakeClient(reply: string): LlmClient {
    return { complete: async () => reply }
  }

  it("registers history + ai providers (idempotently)", () => {
    const deps = { getSettings: () => ({ source: "both" as const }), buildClient: () => null }
    ensureBuiltinCompletionProviders(deps)
    ensureBuiltinCompletionProviders(deps) // second call is a no-op
    // history (offline) should answer even with no client
    return getCompletions(ctx(), signal).then((out) => {
      expect(out.map((s) => s.text)).toContain("git status")
    })
  })

  it("source='ai' suppresses the history provider", async () => {
    ensureBuiltinCompletionProviders({
      getSettings: () => ({ source: "ai" }),
      buildClient: () => fakeClient("git stash"),
    })
    const out = await getCompletions(ctx(), signal)
    expect(out.map((s) => s.source)).not.toContain("history")
    expect(out.map((s) => s.text)).toContain("git stash")
  })

  it("source='history' suppresses the AI provider", async () => {
    let clientCalls = 0
    ensureBuiltinCompletionProviders({
      getSettings: () => ({ source: "history" }),
      buildClient: () => {
        clientCalls++
        return fakeClient("git stash")
      },
    })
    const out = await getCompletions(ctx(), signal)
    expect(out.map((s) => s.source)).toEqual(["history"])
    expect(clientCalls).toBe(0)
  })
})
