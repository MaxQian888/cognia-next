import React from "react"
import { act, render, waitFor } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { App } from "./App"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { CreateSession } from "../hooks/useAgentSession"
import type { TranscriptEntry, TranscriptFs } from "../../agent/transcript"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { UsageInfo } from "../state/types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, model: "claude-x", cwd: "/work" }

const sessionData: Record<string, TranscriptEntry[]> = {
  ses1: [
    { ts: 1, role: "user", content: "resumed question" },
    { ts: 2, role: "assistant", content: "resumed answer" },
  ],
}
const transcriptFs: TranscriptFs = {
  append: () => {},
  mkdirp: () => {},
  read: (p) => {
    const id = p.replace(/.*[\\/]/, "").replace(/\.jsonl$/, "")
    const entries = sessionData[id]
    return entries ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : null
  },
}

const result = (text: string): RunAndCaptureResult => ({
  text,
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
})

/** A fake session whose send streams a scripted answer. */
function fakeSession(answer = "the answer", usage?: UsageInfo) {
  const closed = jest.fn()
  const prompts: string[] = []
  const create: CreateSession = () => ({
    sessionId: "ses-fake",
    async send(prompt, opts) {
      prompts.push(prompt)
      opts.onEvent?.({ type: "text-delta", delta: answer })
      if (usage) opts.onEvent?.({ type: "usage", usage })
      return result(answer)
    },
    close: closed,
  })
  return { create, closed, prompts }
}

function type(text: string) {
  for (const ch of text) act(() => __fireInput(ch))
}

function submit() {
  act(() => __fireInput("", { return: true }))
}

describe("App", () => {
  beforeEach(() => __resetInk())

  it("submits a prompt and renders the streamed answer", async () => {
    const { create } = fakeSession("hello there")
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("hello there"))
    expect(container.textContent).toContain("hi")
  })

  it("Ctrl+R expands collapsed tool output", async () => {
    const create: CreateSession = () => ({
      sessionId: "ses-tool",
      async send(_prompt, opts) {
        opts.onEvent?.({ type: "tool-call", toolName: "bash", input: { command: "ls" } })
        opts.onEvent?.({
          type: "tool-result",
          toolName: "bash",
          input: { command: "ls" },
          result: "SENTINEL_TOOL_OUTPUT",
        })
        return result("done")
      },
      close: jest.fn(),
    })
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("run ls")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // The tool cell renders, but its result is collapsed (hidden) by default.
    await waitFor(() => expect(container.textContent).toContain("bash"))
    expect(container.textContent).not.toContain("SENTINEL_TOOL_OUTPUT")
    // Ctrl+R reveals all tool output.
    act(() => __fireInput("r", { ctrl: true }))
    await waitFor(() => expect(container.textContent).toContain("SENTINEL_TOOL_OUTPUT"))
  })

  it("runs /clear to reset the transcript and wipe the terminal", async () => {
    const { create } = fakeSession("answer one")
    const clearScreen = jest.fn()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        mintId={() => "ses-2"}
        clearScreen={clearScreen}
      />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("answer one"))
    type("/clear")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // The terminal is wiped (Static scrollback won't clear itself) AND state reset.
    expect(clearScreen).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(container.textContent).not.toContain("answer one"))
  })

  it("runs /handoff and shows a notice", async () => {
    const { create } = fakeSession()
    const pushHandoff = jest.fn().mockResolvedValue(undefined)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} pushHandoff={pushHandoff} />
    )
    type("/handoff")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Pushed this session"))
    expect(pushHandoff).toHaveBeenCalledWith("s1")
  })

  it("reports an unknown command", async () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/bogus")
    submit()
    await waitFor(() => expect(container.textContent).toContain("Unknown command /bogus"))
  })

  it("exits on /exit", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    render(<App config={config} sessionId="s1" createSession={create} onExit={onExit} />)
    type("/exit")
    submit()
    expect(onExit).toHaveBeenCalled()
  })

  it("exits on a double Ctrl+C", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    render(
      <App config={config} sessionId="s1" createSession={create} onExit={onExit} now={() => 5000} />
    )
    act(() => __fireInput("c", { ctrl: true }))
    act(() => __fireInput("c", { ctrl: true }))
    expect(onExit).toHaveBeenCalled()
  })

  it("does not exit on a single Ctrl+C", () => {
    const { create } = fakeSession()
    const onExit = jest.fn()
    let t = 0
    render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        onExit={onExit}
        now={() => (t += 5000)}
      />
    )
    act(() => __fireInput("c", { ctrl: true }))
    expect(onExit).not.toHaveBeenCalled()
  })

  it("opens the help overlay on /help", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/help")
    submit()
    expect(container.textContent).toContain("Commands")
  })

  it("opens the usage panel on /usage", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/usage")
    submit()
    expect(container.textContent).toContain("Usage")
  })

  it("opens and applies the model switcher on /model", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/model")
    submit()
    expect(container.textContent).toContain("Switch model")
    act(() => __fireInput("", { return: true })) // select the only model
    expect(container.textContent).not.toContain("Switch model")
  })

  it("opens the mode switcher on /mode", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    // Trailing space closes the palette (`/mode` also prefix-matches `/model`).
    type("/mode ")
    submit()
    expect(container.textContent).toContain("Permission mode")
    expect(container.textContent).toContain("plan")
  })

  it("notes when no models are configured", () => {
    const { create } = fakeSession()
    // A provider with no shared catalog and no configured model → empty list.
    const bare: ResolvedConfig = {
      ...DEFAULT_RESOLVED_CONFIG,
      provider: "uncatalogued",
      cwd: "/work",
    }
    const { container } = render(<App config={bare} sessionId="s1" createSession={create} />)
    type("/model")
    submit()
    expect(container.textContent).toContain("No models configured")
  })

  it("browses and resumes a past session on /sessions", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => ["ses1.jsonl"]}
        transcriptFs={transcriptFs}
      />
    )
    type("/sessions")
    submit()
    expect(container.textContent).toContain("Resume session")
    expect(container.textContent).toContain("resumed question")
    await act(async () => {
      __fireInput("", { return: true }) // resume the highlighted session
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("resumed answer"))
  })

  it("recalls the previous submission with the up arrow", async () => {
    const { create, prompts } = fakeSession("ok")
    render(<App config={config} sessionId="s1" createSession={create} />)
    type("alpha")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Composer is empty again; ↑ recalls "alpha", Enter re-sends it.
    act(() => __fireInput("", { upArrow: true }))
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(prompts).toEqual(["alpha", "alpha"])
  })

  it("re-sends the last message on /retry", async () => {
    const { create, prompts } = fakeSession("ok")
    render(<App config={config} sessionId="s1" createSession={create} />)
    type("first question")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    type("/retry")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(prompts).toEqual(["first question", "first question"])
  })

  it("copies the last reply on /copy", async () => {
    const { create } = fakeSession("the reply text")
    const copyClipboard = jest.fn().mockResolvedValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} copyClipboard={copyClipboard} />
    )
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    type("/copy")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(copyClipboard).toHaveBeenCalledWith("the reply text")
    await waitFor(() => expect(container.textContent).toContain("Copied the last reply"))
  })

  it("shows the working directory on /cwd", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/cwd")
    submit()
    expect(container.textContent).toContain("/work")
  })

  it("lists enabled built-in tools on /tools", () => {
    const { create } = fakeSession()
    const withTools: ResolvedConfig = {
      ...config,
      builtinTools: { ...config.builtinTools, git: true },
    }
    const { container } = render(<App config={withTools} sessionId="s1" createSession={create} />)
    type("/tools")
    submit()
    expect(container.textContent).toContain("git")
  })

  it("shows version + provider on /about", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/about")
    submit()
    expect(container.textContent).toContain("cognia-agent v")
    expect(container.textContent).toContain("anthropic")
  })

  it("renders streamed usage in the footer", async () => {
    const { create } = fakeSession("done", {
      inputTokens: 1000,
      outputTokens: 200,
      totalCostUsd: 0.5,
    })
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("hi")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    // Cost is accumulated from the streamed `usage` event, not left at $0.00.
    await waitFor(() => expect(container.textContent).toContain("$0.50"))
    expect(container.textContent).toContain("1.2k tok")
  })

  it("opens the settings panel on /config", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={() => true} />
    )
    type("/config")
    submit()
    expect(container.textContent).toContain("Settings")
    expect(container.textContent).toContain("Provider")
    expect(container.textContent).toContain("Permission mode")
  })

  it("switches + persists the provider on /provider", async () => {
    const { create } = fakeSession()
    const persistConfig = jest.fn().mockReturnValue(true)
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={persistConfig} />
    )
    type("/provider")
    submit()
    expect(container.textContent).toContain("Switch provider")
    // anthropic is active + first; move down once to "openai" and select it.
    act(() => __fireInput("", { downArrow: true }))
    await act(async () => {
      __fireInput("", { return: true })
      await Promise.resolve()
    })
    expect(persistConfig).toHaveBeenCalledWith("provider", "openai")
    // The unconfigured provider warns how to add a credential.
    await waitFor(() => expect(container.textContent).toContain("No credential"))
  })

  it("drills from the settings panel into the provider switcher", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistConfig={() => true} />
    )
    type("/config")
    submit()
    // First row is Provider; Enter opens the provider switcher.
    act(() => __fireInput("", { return: true }))
    expect(container.textContent).toContain("Switch provider")
  })

  it("routes /goal with no objective to a usage notice", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} persistDb={() => {}} />
    )
    type("/goal")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("Usage: /goal"))
  })

  it("routes /mcp to the no-servers notice when none are configured", async () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        persistDb={() => {}}
        home="/nonexistent-home"
      />
    )
    type("/mcp")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    await waitFor(() => expect(container.textContent).toContain("No MCP servers"))
  })

  it("runs a !command shell-out and shows the output", async () => {
    const { create } = fakeSession()
    const runShell = jest.fn().mockResolvedValue({ stdout: "file-a\nfile-b", stderr: "", code: 0 })
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} runShell={runShell} />
    )
    type("!ls")
    await act(async () => {
      submit()
      await Promise.resolve()
    })
    expect(runShell).toHaveBeenCalledWith("ls", { cwd: "/work" })
    await waitFor(() => expect(container.textContent).toContain("file-a"))
  })

  it("lists the Cognia runtime commands in /help", () => {
    const { create } = fakeSession()
    const { container } = render(<App config={config} sessionId="s1" createSession={create} />)
    type("/help")
    submit()
    expect(container.textContent).toContain("Cognia")
    expect(container.textContent).toContain("/goal")
    expect(container.textContent).toContain("/workflow")
  })

  it("notes when there are no sessions to browse", () => {
    const { create } = fakeSession()
    const { container } = render(
      <App
        config={config}
        sessionId="s1"
        createSession={create}
        home="/home"
        readdir={() => []}
        transcriptFs={transcriptFs}
      />
    )
    type("/sessions")
    submit()
    expect(container.textContent).toContain("No past sessions")
  })
})
