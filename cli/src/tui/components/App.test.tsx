import React from "react"
import { act, render, waitFor } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { App } from "./App"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { CreateSession } from "../hooks/useAgentSession"
import type { TranscriptEntry, TranscriptFs } from "../../agent/transcript"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

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
function fakeSession(answer = "the answer") {
  const closed = jest.fn()
  const create: CreateSession = () => ({
    sessionId: "ses-fake",
    async send(_prompt, opts) {
      opts.onEvent?.({ type: "text-delta", delta: answer })
      return result(answer)
    },
    close: closed,
  })
  return { create, closed }
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

  it("runs /clear to reset the transcript", async () => {
    const { create } = fakeSession("answer one")
    const { container } = render(
      <App config={config} sessionId="s1" createSession={create} mintId={() => "ses-2"} />
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
    const bare: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }
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
