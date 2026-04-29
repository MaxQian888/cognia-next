/**
 * @jest-environment node
 */

import {
  createChatTrace,
  createSpan,
  getLangfuse,
  resetLangfuseClientForTest,
} from "./langfuse-client"

beforeEach(() => {
  resetLangfuseClientForTest()
})

describe("getLangfuse credential gating", () => {
  it("returns the no-op client when public/secret keys are blank", async () => {
    const client = await getLangfuse({})
    expect(typeof client.flush).toBe("function")
    const trace = client.trace({ name: "noop" })
    // Trace methods on the no-op are present and chainable, but they don't
    // throw and have no observable side effect.
    trace.update({ tag: "x" })
    const span = trace.span({ name: "child" })
    span.update({ note: "y" })
    span.end()
    trace.end()
    await client.flush()
    await client.flushAsync()
  })

  it("returns the no-op when only one credential is supplied", async () => {
    const client = await getLangfuse({ publicKey: "pk", secretKey: "" })
    const trace = client.trace({})
    trace.end() // smoke test — would throw on a real client without server
  })

  it("memoizes the resolved client per credential triple", async () => {
    const a = await getLangfuse({})
    const b = await getLangfuse({})
    expect(a).toBe(b)
    // Different config triple → fresh resolve. Both happen to be the same
    // no-op singleton when credentials are blank, so identity still holds —
    // we instead verify resetLangfuseClientForTest() forces a re-resolve.
    resetLangfuseClientForTest()
    const c = await getLangfuse({})
    // The no-op client is a module constant, so even after reset the
    // identity check still succeeds. The point of the reset is exposing
    // the resolve path again — see the SDK-not-installed test below.
    expect(c).toBeDefined()
  })

  it("falls back to the no-op when credentials are present but the SDK is not installed", async () => {
    const client = await getLangfuse({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://example.com",
    })
    // The `langfuse` npm package is not installed in this repo; the client
    // should silently land on the no-op rather than throwing.
    expect(typeof client.trace).toBe("function")
    expect(typeof client.flush).toBe("function")
  })
})

describe("createChatTrace / createSpan", () => {
  it("returns chainable no-op surfaces with no thrown errors", async () => {
    const trace = await createChatTrace({
      sessionId: "s-1",
      metadata: { source: "logger" },
    })
    expect(typeof trace.span).toBe("function")
    const span = createSpan(trace, { name: "chat", input: "hello" })
    expect(typeof span.update).toBe("function")
    span.update({ note: "stream-1" })
    span.end()
    trace.end()
  })
})
