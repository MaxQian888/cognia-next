jest.mock("@/lib/browser/client", () => ({
  browserClient: { embedRefFor: jest.fn() },
}))

import type { BrowserEngine } from "@/lib/browser/agent-engine"
import { browserClient } from "@/lib/browser/client"
import type { RecordedFlow, RecordedStep, RecordedTarget } from "@/lib/browser/recording/protocol"
import { replayFlow } from "@/lib/browser/recording/replayer"

const refFor = browserClient.embedRefFor as jest.Mock

type EngineMock = { [K in keyof BrowserEngine]: jest.Mock } & BrowserEngine

function engineMock(over: Partial<Record<keyof BrowserEngine, jest.Mock>> = {}): EngineMock {
  const ok = { ok: true, error: null, generation: 1 }
  return {
    navigate: jest.fn().mockResolvedValue(undefined),
    snapshot: jest.fn(),
    act: jest.fn().mockResolvedValue(ok),
    pressKey: jest.fn().mockResolvedValue(ok),
    scroll: jest.fn(),
    evaluate: jest.fn(),
    readConsole: jest.fn(),
    readNetwork: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    reload: jest.fn(),
    stop: jest.fn(),
    getPage: jest.fn(),
    waitForText: jest.fn().mockResolvedValue({ ok: true, timedOut: false }),
    waitForSelector: jest.fn(),
    waitForNetworkIdle: jest.fn(),
    waitForLoad: jest.fn().mockResolvedValue({ ok: true, timedOut: false }),
    screenshot: jest.fn(),
    ...over,
  } as EngineMock
}

function target(selector = "#submit"): RecordedTarget {
  return { selector, role: "button", name: "Sign in", domPath: "form > button" }
}

function flow(steps: RecordedStep[], over: Partial<RecordedFlow> = {}): RecordedFlow {
  return {
    id: "f1",
    name: "login",
    baseUrl: "http://localhost:3000",
    createdAt: 0,
    updatedAt: 0,
    steps,
    ...over,
  }
}

beforeEach(() => {
  refFor.mockReset().mockResolvedValue("e7")
})

describe("replayFlow", () => {
  it("navigates and waits for the document it asked for", async () => {
    const engine = engineMock()
    const res = await replayFlow(flow([{ act: "navigate", at: 1, url: "/login" }]), engine)
    expect(res.ok).toBe(true)
    expect(engine.navigate).toHaveBeenCalledWith("http://localhost:3000/login")
    expect(engine.waitForLoad).toHaveBeenCalledWith({ targetUrl: "http://localhost:3000/login" })
  })

  it("resolves the recorded selector to a live ref and acts by ref", async () => {
    const engine = engineMock()
    await replayFlow(flow([{ act: "click", at: 1, target: target() }]), engine)
    expect(refFor).toHaveBeenCalledWith("#submit")
    expect(engine.act).toHaveBeenCalledWith("e7", "click", {})
  })

  it("settles after a click, so the next step sees the document it produced", async () => {
    const engine = engineMock()
    await replayFlow(flow([{ act: "click", at: 1, target: target() }]), engine)
    expect(engine.waitForLoad).toHaveBeenCalledWith({ timeoutMs: 3000 })
  })

  it("forwards click modifiers", async () => {
    const engine = engineMock()
    await replayFlow(flow([{ act: "click", at: 1, target: target(), modifiers: ["ctrl"] }]), engine)
    expect(engine.act).toHaveBeenCalledWith("e7", "click", { modifiers: ["ctrl"] })
  })

  it("replays double-click, hover, and scroll events", async () => {
    const engine = engineMock({ scroll: jest.fn().mockResolvedValue({ ok: true }) })
    await replayFlow(
      flow([
        { act: "double_click", at: 1, target: target(), modifiers: ["shift"] },
        { act: "hover", at: 2, target: target("#menu") },
        { act: "scroll", at: 3, direction: "down", amount: 240 },
      ]),
      engine
    )

    expect(engine.act).toHaveBeenNthCalledWith(1, "e7", "double_click", {
      modifiers: ["shift"],
    })
    expect(engine.act).toHaveBeenNthCalledWith(2, "e7", "hover", {})
    expect(engine.scroll).toHaveBeenCalledWith({ direction: "down", amount: 240 })
  })

  it("reports a rejected scroll event", async () => {
    const engine = engineMock({
      scroll: jest.fn().mockResolvedValue({ ok: false, error: "scroll blocked" }),
    })

    const result = await replayFlow(
      flow([{ act: "scroll", at: 1, direction: "up", amount: 120 }]),
      engine
    )

    expect(result.ok).toBe(false)
    expect(result.steps[0].error).toBe("scroll blocked")
  })

  // The arg NAME is the whole contract, and this mock is the only thing checking
  // it: the real overlay is a Tauri init script that jest cannot reach, and it
  // coerces a missing `args.text` to "" and still returns `{ ok: true }`. So a
  // wrong name here is a fill that types nothing and reports success — invisible
  // to every assertion except this one. `fill` reads `args.text`
  // (overlay.injected.js `performAct`), matching the canonical tool contract
  // (`browser_fill_form` sends `{ text }`, plugins/browser-tools/src/index.ts).
  it("fills a plain field with its recorded value under the overlay's arg name", async () => {
    const engine = engineMock()
    await replayFlow(
      flow([{ act: "fill", at: 1, target: target("#email"), value: "a@b.c" }]),
      engine
    )
    expect(engine.act).toHaveBeenCalledWith("e7", "fill", { text: "a@b.c" })
  })

  // `select` genuinely reads `args.value` — the overlay's arg names are per
  // action, not uniform, so this must NOT be renamed alongside `fill`.
  it("selects a recorded option", async () => {
    const engine = engineMock()
    await replayFlow(
      flow([{ act: "select", at: 1, target: target("#plan"), value: "pro" }]),
      engine
    )
    expect(engine.act).toHaveBeenCalledWith("e7", "select", { value: "pro" })
  })

  it("never sends a fill under a name the overlay ignores", async () => {
    const engine = engineMock()
    await replayFlow(
      flow([{ act: "fill", at: 1, target: target("#email"), value: "a@b.c" }]),
      engine
    )
    const args = engine.act.mock.calls[0][2] as Record<string, unknown>
    expect(args).not.toHaveProperty("value")
  })

  it("presses a key on the recorded target", async () => {
    const engine = engineMock()
    await replayFlow(flow([{ act: "press_key", at: 1, key: "Enter", target: target() }]), engine)
    expect(engine.pressKey).toHaveBeenCalledWith("Enter", "e7")
  })

  it("presses a targetless key without resolving a ref", async () => {
    const engine = engineMock()
    await replayFlow(flow([{ act: "press_key", at: 1, key: "Escape" }]), engine)
    expect(refFor).not.toHaveBeenCalled()
    expect(engine.pressKey).toHaveBeenCalledWith("Escape", undefined)
  })

  it("asserts a wait_for step against the live page", async () => {
    const engine = engineMock()
    const res = await replayFlow(flow([{ act: "wait_for", at: 1, text: "Welcome" }]), engine)
    expect(res.ok).toBe(true)
    expect(engine.waitForText).toHaveBeenCalledWith("Welcome", { timeoutMs: 5000 })
  })

  it("reports every step through onStep in order", async () => {
    const engine = engineMock()
    const seen: number[] = []
    await replayFlow(
      flow([
        { act: "navigate", at: 1, url: "/login" },
        { act: "click", at: 2, target: target() },
      ]),
      engine,
      { onStep: (r) => seen.push(r.index) }
    )
    expect(seen).toEqual([0, 1])
  })
})

describe("failure handling", () => {
  it("fails the step when the recorded element is gone", async () => {
    refFor.mockResolvedValue("")
    const engine = engineMock()
    const res = await replayFlow(flow([{ act: "click", at: 1, target: target() }]), engine)
    expect(res.ok).toBe(false)
    expect(res.steps[0].error).toBe("no element matches #submit")
    expect(engine.act).not.toHaveBeenCalled()
  })

  it("surfaces the engine's own error", async () => {
    const engine = engineMock({
      act: jest.fn().mockResolvedValue({ ok: false, error: "element is disabled", generation: 1 }),
    })
    const res = await replayFlow(flow([{ act: "click", at: 1, target: target() }]), engine)
    expect(res.steps[0].error).toBe("element is disabled")
  })

  it("stops at the first failure rather than cascading", async () => {
    refFor.mockResolvedValueOnce("")
    const engine = engineMock()
    const res = await replayFlow(
      flow([
        { act: "click", at: 1, target: target("#gone") },
        { act: "click", at: 2, target: target("#next") },
      ]),
      engine
    )
    expect(res.ok).toBe(false)
    expect(res.steps).toHaveLength(1)
    expect(engine.act).not.toHaveBeenCalled()
  })

  it("fails a timed-out assertion with the text it wanted", async () => {
    const engine = engineMock({
      waitForText: jest.fn().mockResolvedValue({ ok: false, timedOut: true }),
    })
    const res = await replayFlow(flow([{ act: "wait_for", at: 1, text: "Welcome" }]), engine)
    expect(res.steps[0].error).toBe('timed out waiting for "Welcome"')
  })

  it("reports a thrown error rather than rejecting", async () => {
    const engine = engineMock({ navigate: jest.fn().mockRejectedValue(new Error("pane closed")) })
    const res = await replayFlow(flow([{ act: "navigate", at: 1, url: "/x" }]), engine)
    expect(res.ok).toBe(false)
    expect(res.steps[0].error).toBe("pane closed")
  })
})

// Recording never captures a password, so replay must be handed one. Typing an
// empty string into a credential field would look like a login that "ran" and
// silently failed.
describe("secrets", () => {
  const secretStep: RecordedStep = {
    act: "fill",
    at: 1,
    target: { selector: "#pw", role: "textbox", name: "Password", domPath: "form > input" },
    value: "",
    secret: true,
  }

  it("fills a secret field from the supplied map", async () => {
    const engine = engineMock()
    const res = await replayFlow(flow([secretStep]), engine, { secrets: { PASSWORD: "hunter2" } })
    expect(res.ok).toBe(true)
    expect(engine.act).toHaveBeenCalledWith("e7", "fill", { text: "hunter2" })
  })

  it("fails loudly when the secret was not supplied", async () => {
    const engine = engineMock()
    const res = await replayFlow(flow([secretStep]), engine)
    expect(res.ok).toBe(false)
    expect(res.steps[0].error).toContain('missing secret "PASSWORD"')
    expect(engine.act).not.toHaveBeenCalled()
  })

  it("does not consult the secrets map for a normal field", async () => {
    const engine = engineMock()
    await replayFlow(
      flow([{ act: "fill", at: 1, target: target("#email"), value: "a@b.c" }]),
      engine
    )
    expect(engine.act).toHaveBeenCalledWith("e7", "fill", { text: "a@b.c" })
  })
})

describe("abort", () => {
  it("stops before the next step when signalled", async () => {
    const controller = new AbortController()
    const engine = engineMock({
      navigate: jest.fn().mockImplementation(() => {
        controller.abort()
        return Promise.resolve()
      }),
    })
    const res = await replayFlow(
      flow([
        { act: "navigate", at: 1, url: "/a" },
        { act: "click", at: 2, target: target() },
      ]),
      engine,
      { signal: controller.signal }
    )
    expect(res.ok).toBe(false)
    expect(res.steps[1]).toMatchObject({ index: 1, ok: false, error: "replay stopped" })
    expect(engine.act).not.toHaveBeenCalled()
  })

  it("runs to completion when never aborted", async () => {
    const controller = new AbortController()
    const engine = engineMock()
    const res = await replayFlow(flow([{ act: "click", at: 1, target: target() }]), engine, {
      signal: controller.signal,
    })
    expect(res.ok).toBe(true)
  })
})
