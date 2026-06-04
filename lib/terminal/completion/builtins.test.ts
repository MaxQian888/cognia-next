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

  /** Legacy-shaped settings: only history/AI active. */
  const legacy = (source: "both" | "ai" | "history") => ({
    source,
    path: false,
    exe: false,
    spec: false,
  })

  it("registers the providers (idempotently)", () => {
    const deps = { getSettings: () => legacy("both"), buildClient: () => null }
    ensureBuiltinCompletionProviders(deps)
    ensureBuiltinCompletionProviders(deps) // second call is a no-op
    // history (offline) should answer even with no client
    return getCompletions(ctx(), signal).then((out) => {
      expect(out.map((s) => s.text)).toContain("git status")
    })
  })

  it("source='ai' suppresses the history provider", async () => {
    ensureBuiltinCompletionProviders({
      getSettings: () => legacy("ai"),
      buildClient: () => fakeClient("git stash"),
    })
    const out = await getCompletions(ctx(), signal)
    expect(out.map((s) => s.source)).not.toContain("history")
    expect(out.map((s) => s.text)).toContain("git stash")
  })

  it("source='history' suppresses the AI provider", async () => {
    let clientCalls = 0
    ensureBuiltinCompletionProviders({
      getSettings: () => legacy("history"),
      buildClient: () => {
        clientCalls++
        return fakeClient("git stash")
      },
    })
    const out = await getCompletions(ctx(), signal)
    expect(out.map((s) => s.source)).toEqual(["history"])
    expect(clientCalls).toBe(0)
  })

  it("registers the spec provider, gated by the spec toggle", async () => {
    let spec = true
    ensureBuiltinCompletionProviders({
      getSettings: () => ({ source: "history", path: false, exe: false, spec }),
      buildClient: () => null,
    })
    const withSpec = await getCompletions(ctx({ input: "git ch", cursor: 6 }), signal)
    expect(withSpec.map((s) => s.source)).toContain("spec")
    spec = false
    const without = await getCompletions(ctx({ input: "git ch", cursor: 6 }), signal)
    expect(without.map((s) => s.source)).not.toContain("spec")
  })

  it("registers the path and exe providers behind injected desktop deps", async () => {
    ensureBuiltinCompletionProviders({
      getSettings: () => ({ source: "history", path: true, exe: true, spec: false }),
      buildClient: () => null,
      pathDeps: {
        isDesktop: () => true,
        invoke: async () => [{ name: "src", isDir: true }],
      },
      exeDeps: {
        isDesktop: () => true,
        invoke: async () => ["gitk"],
      },
    })
    const pathOut = await getCompletions(
      ctx({ input: "cd s", cursor: 4, recentCommands: [] }),
      signal
    )
    expect(pathOut.map((s) => s.source)).toContain("path")
    const exeOut = await getCompletions(
      ctx({ input: "git", cursor: 3, recentCommands: [] }),
      signal
    )
    expect(exeOut.map((s) => s.source)).toContain("exe")
  })

  it("path/exe toggles gate their providers", async () => {
    const pathInvoke = jest.fn(async () => [{ name: "src", isDir: true }])
    const exeInvoke = jest.fn(async () => ["gitk"])
    ensureBuiltinCompletionProviders({
      getSettings: () => ({ source: "history", path: false, exe: false, spec: false }),
      buildClient: () => null,
      pathDeps: { isDesktop: () => true, invoke: pathInvoke },
      exeDeps: { isDesktop: () => true, invoke: exeInvoke },
    })
    await getCompletions(ctx({ input: "cd s", cursor: 4 }), signal)
    await getCompletions(ctx({ input: "git", cursor: 3 }), signal)
    expect(pathInvoke).not.toHaveBeenCalled()
    expect(exeInvoke).not.toHaveBeenCalled()
  })
})
