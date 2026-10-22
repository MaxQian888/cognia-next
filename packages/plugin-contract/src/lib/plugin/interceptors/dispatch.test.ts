/**
 * The interceptor dispatcher, against the ten rules in ADR-0189 §6.3.
 *
 * The `around` block is the regression suite for the chat-middleware defect the
 * design review reproduced: the old runner called `next(req)` again after a
 * middleware timed out or threw, so a middleware that had ALREADY delegated
 * produced two downstream calls for one user turn. The table below is the same
 * five scenarios, and every one of them must now show exactly one.
 */

import {
  dispatchAround,
  dispatchGuard,
  dispatchObserve,
  dispatchTransform,
  requireGuardPass,
  InterceptorInvariantError,
  InterceptorShortCircuitError,
  __resetInterceptorDispatchForTesting,
} from "./dispatch"
import { InterceptorFailClosedError, InterceptorGuardDeniedError } from "./types"
import type {
  InterceptorFailurePolicy,
  InterceptorRegistration,
  InterceptorSemantic,
} from "./types"

function registration(
  overrides: Partial<InterceptorRegistration> & { handler: InterceptorRegistration["handler"] }
): InterceptorRegistration {
  return {
    registrationId: "r1",
    pluginId: "p1",
    pluginInstanceId: "p1#1",
    generation: 1,
    realmId: "global",
    pointId: "model.request.invoke",
    semantic: "around" as InterceptorSemantic,
    trustTier: "community",
    order: {},
    timeoutMs: 50,
    source: "interceptors",
    runtime: "frontend",
    ...overrides,
  }
}

const context = { operationId: "op-1" }

beforeEach(() => {
  __resetInterceptorDispatchForTesting()
})

describe("dispatchAround — the downstream operation runs exactly once", () => {
  it("runs the terminal once on the happy path", async () => {
    const terminal = jest.fn(async () => "downstream")
    const chain = [
      registration({
        handler: (async (input: string, next: (value?: string) => Promise<string>) =>
          `wrapped(${await next(input)})`) as never,
      }),
    ]

    const { result, report } = await dispatchAround<string, string>(
      "model.request.invoke",
      "in",
      terminal,
      { ...context, chain }
    )

    expect(terminal).toHaveBeenCalledTimes(1)
    expect(result).toBe("wrapped(downstream)")
    expect(report.succeeded).toEqual(["r1"])
  })

  it("does NOT re-run the terminal when the handler throws AFTER delegating", async () => {
    // The old runner's bug: `await next()` resolved, the middleware then threw
    // in its post-processing, and the recovery path called `next(req)` again.
    const terminal = jest.fn(async () => "downstream")
    const chain = [
      registration({
        handler: (async (input: string, next: (value?: string) => Promise<string>) => {
          await next(input)
          throw new Error("post-processing blew up")
        }) as never,
      }),
    ]

    const { result } = await dispatchAround<string, string>(
      "model.request.invoke",
      "in",
      terminal,
      { ...context, chain }
    )

    expect(terminal).toHaveBeenCalledTimes(1)
    // Fail-open point: the downstream result stands, the post-processing is lost.
    expect(result).toBe("downstream")
  })

  it("does NOT re-run the terminal when the handler times out mid-delegation", async () => {
    const terminal = jest.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("downstream"), 40))
    )
    const chain = [
      registration({
        timeoutMs: 10,
        handler: (async (input: string, next: (value?: string) => Promise<string>) =>
          next(input)) as never,
      }),
    ]

    const { result } = await dispatchAround<string, string>(
      "model.request.invoke",
      "in",
      terminal,
      { ...context, chain }
    )

    expect(terminal).toHaveBeenCalledTimes(1)
    expect(result).toBe("downstream")
  })

  it("rejects a second next() and does not re-run the terminal", async () => {
    const terminal = jest.fn(async () => "downstream")
    const seen: string[] = []
    const chain = [
      registration({
        handler: (async (input: string, next: (value?: string) => Promise<string>) => {
          const first = await next(input)
          try {
            await next(input)
          } catch (error) {
            seen.push((error as Error).name)
          }
          return first
        }) as never,
      }),
    ]

    const { result } = await dispatchAround<string, string>(
      "model.request.invoke",
      "in",
      terminal,
      { ...context, chain }
    )

    expect(terminal).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(["InterceptorNextReentryError"])
    expect(result).toBe("downstream")
  })

  it("catches a SYNCHRONOUS throw instead of letting it escape", async () => {
    // `Promise.race` could only ever catch a rejection. A handler that threw
    // before returning a promise bypassed the old runner's try/catch entirely
    // and propagated into the send pipeline.
    const terminal = jest.fn(async () => "downstream")
    const chain = [
      registration({
        handler: (() => {
          throw new Error("sync boom")
        }) as never,
      }),
    ]

    const { result, report } = await dispatchAround<string, string>(
      "model.request.invoke",
      "in",
      terminal,
      { ...context, chain }
    )

    expect(terminal).toHaveBeenCalledTimes(1)
    expect(result).toBe("downstream")
    expect(report.failed[0]?.message).toBe("sync boom")
  })

  it("refuses a late next() after the deadline expired", async () => {
    const terminal = jest.fn(async () => "downstream")
    let lateError: string | undefined
    const chain = [
      registration({
        timeoutMs: 10,
        handler: ((_input: string, next: (value?: string) => Promise<string>) =>
          new Promise<string>((resolve) => {
            setTimeout(() => {
              void next().catch((error: Error) => {
                lateError = error.name
              })
              resolve("too late")
            }, 30)
          })) as never,
      }),
    ]

    await dispatchAround<string, string>("model.request.invoke", "in", terminal, {
      ...context,
      chain,
    })
    await new Promise((resolve) => setTimeout(resolve, 40))

    // The chain proceeded without the interceptor; the late capability is dead.
    expect(lateError).toBe("InterceptorRevokedError")
    expect(terminal).toHaveBeenCalledTimes(1)
  })

  it("forwards the value the handler holds, so a request rewrite lands", async () => {
    const terminal = jest.fn(async (value: string) => `terminal(${value})`)
    const chain = [
      registration({
        handler: ((_input: string, next: (value?: string) => Promise<string>) =>
          next("rewritten")) as never,
      }),
    ]

    const { result } = await dispatchAround<string, string>(
      "model.request.invoke",
      "in",
      terminal,
      { ...context, chain }
    )

    expect(terminal).toHaveBeenCalledWith("rewritten")
    expect(result).toBe("terminal(rewritten)")
  })

  it("refuses a synthetic result on a point that requires a real execution", async () => {
    const terminal = jest.fn(async () => "downstream")
    const chain = [
      registration({
        pointId: "tool.execute",
        handler: (async () => "made up") as never,
      }),
    ]

    // `tool.execute` is fail-closed, so the invented receipt surfaces as an
    // error rather than being passed off as the tool's own output.
    await expect(
      dispatchAround<string, string>("tool.execute", "in", terminal, { ...context, chain })
    ).rejects.toBeInstanceOf(InterceptorFailClosedError)
    expect(terminal).not.toHaveBeenCalled()
  })

  it("names the short-circuit as the cause on a fail-closed point", async () => {
    const chain = [
      registration({ pointId: "tool.execute", handler: (async () => "made up") as never }),
    ]
    const error = await dispatchAround<string, string>(
      "tool.execute",
      "in",
      async () => "downstream",
      { ...context, chain }
    ).catch((err: unknown) => err)

    expect((error as InterceptorFailClosedError).cause).toContain(
      new InterceptorShortCircuitError("tool.execute", "r1").message
    )
  })

  it("attributes downstream time to the operation, not to the wrapper", async () => {
    const chain = [
      registration({
        timeoutMs: 500,
        handler: (async (input: string, next: (value?: string) => Promise<string>) =>
          next(input)) as never,
      }),
    ]
    const { report } = await dispatchAround<string, string>(
      "model.request.invoke",
      "in",
      () => new Promise((resolve) => setTimeout(() => resolve("slow"), 30)),
      { ...context, chain }
    )

    expect(report.downstreamDurationMs).toBeGreaterThanOrEqual(20)
    // Rule 6: a wrapper that only awaited `next` owns almost none of the time.
    expect(report.ownDurationMs.r1).toBeLessThan(report.downstreamDurationMs)
  })

  it("skips a registration whose breaker is open", async () => {
    const terminal = jest.fn(async () => "downstream")
    const handler = jest.fn(async () => "never")
    const chain = [registration({ handler: handler as never })]

    const { result, report } = await dispatchAround<string, string>(
      "model.request.invoke",
      "in",
      terminal,
      {
        ...context,
        chain,
        sink: {
          shouldSkip: () => true,
          recordSuccess: () => {},
          recordFailure: () => {},
        },
      }
    )

    expect(handler).not.toHaveBeenCalled()
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(result).toBe("downstream")
    expect(report.skipped).toEqual([{ registrationId: "r1", reason: "breaker-open" }])
  })

  it("stops a registration that re-enters its own point in one operation", async () => {
    const terminal = jest.fn(async () => "downstream")
    let entries = 0
    let innerFailure: string | undefined
    const chain: InterceptorRegistration[] = [
      registration({
        handler: (async (input: string, next: (value?: string) => Promise<string>) => {
          entries += 1
          if (entries === 1) {
            // The classic loop: the handler calls back into the same point
            // while its own invocation is still in flight.
            const inner = await dispatchAround<string, string>(
              "model.request.invoke",
              input,
              terminal,
              { ...context, chain }
            )
            innerFailure = inner.report.failed[0]?.kind
          }
          return next(input)
        }) as never,
      }),
    ]

    await dispatchAround<string, string>("model.request.invoke", "in", terminal, {
      ...context,
      chain,
    })

    // The handler body runs once. The nested dispatch refuses to enter it a
    // second time for the same operation and says why, instead of looping.
    expect(entries).toBe(1)
    expect(innerFailure).toBe("reentrancy")
    // Each dispatch still completed — the interceptor was dropped, the
    // operation was not — so the terminal ran once per dispatch, not twice.
    expect(terminal).toHaveBeenCalledTimes(2)
  })
})

describe("dispatchTransform", () => {
  const transformChain = (
    ...handlers: Array<(value: { text: string; sessionId: string }) => unknown>
  ): InterceptorRegistration[] =>
    handlers.map((handler, index) =>
      registration({
        registrationId: `t${index}`,
        pointId: "model.request.prepare",
        semantic: "transform",
        handler: handler as never,
      })
    )

  it("threads each handler's output into the next one", async () => {
    const chain = transformChain(
      (value) => ({ ...value, text: `${value.text}-a` }),
      (value) => ({ ...value, text: `${value.text}-b` })
    )
    const { value } = await dispatchTransform<{ text: string; sessionId: string }>(
      "model.request.prepare",
      { text: "in", sessionId: "s1" },
      { ...context, chain }
    )
    expect(value.text).toBe("in-a-b")
  })

  it("treats a handler that returns nothing as 'no change'", async () => {
    const chain = transformChain(() => undefined)
    const { value } = await dispatchTransform<{ text: string; sessionId: string }>(
      "model.request.prepare",
      { text: "in", sessionId: "s1" },
      { ...context, chain }
    )
    expect(value.text).toBe("in")
  })

  it("rejects a rewrite of a declared invariant field", async () => {
    const chain = transformChain((value) => ({ ...value, sessionId: "somebody-elses" }))
    const { value, report } = await dispatchTransform<{ text: string; sessionId: string }>(
      "model.request.prepare",
      { text: "in", sessionId: "s1" },
      { ...context, chain, invariantFields: ["sessionId"] }
    )
    expect(value.sessionId).toBe("s1")
    expect(report.failed[0]?.kind).toBe("invariant")
  })

  it("keeps the previous value when a fail-open handler throws", async () => {
    const chain = transformChain(
      (value) => ({ ...value, text: `${value.text}-a` }),
      () => {
        throw new Error("boom")
      },
      (value) => ({ ...value, text: `${value.text}-c` })
    )
    const { value, report } = await dispatchTransform<{ text: string; sessionId: string }>(
      "model.request.prepare",
      { text: "in", sessionId: "s1" },
      { ...context, chain }
    )
    expect(value.text).toBe("in-a-c")
    expect(report.skipped.map((entry) => entry.registrationId)).toEqual(["t1"])
  })

  it("propagates when a registration narrows the point to fail-closed", async () => {
    const chain = transformChain(() => {
      throw new Error("redactor died")
    })
    chain[0]!.failurePolicy = "fail-closed" as InterceptorFailurePolicy

    await expect(
      dispatchTransform<{ text: string; sessionId: string }>(
        "model.request.prepare",
        { text: "in", sessionId: "s1" },
        { ...context, chain }
      )
    ).rejects.toBeInstanceOf(InterceptorFailClosedError)
  })

  it("ignores a registration trying to LOOSEN a fail-closed point", async () => {
    const chain = [
      registration({
        pointId: "tool.execute",
        semantic: "around",
        failurePolicy: "fail-open" as InterceptorFailurePolicy,
        handler: (() => {
          throw new Error("boom")
        }) as never,
      }),
    ]
    await expect(
      dispatchAround<string, string>("tool.execute", "in", async () => "downstream", {
        ...context,
        chain,
      })
    ).rejects.toBeInstanceOf(InterceptorFailClosedError)
  })
})

describe("dispatchGuard", () => {
  const guardChain = (...verdicts: Array<() => unknown>): InterceptorRegistration[] =>
    verdicts.map((handler, index) =>
      registration({
        registrationId: `g${index}`,
        pointId: "ui.action.invoke",
        semantic: "guard",
        handler: handler as never,
      })
    )

  it("passes when every guard passes", async () => {
    const chain = guardChain(
      () => ({ decision: "pass" }),
      () => ({ decision: "pass" })
    )
    const { verdict } = await dispatchGuard("ui.action.invoke", {}, { ...context, chain })
    expect(verdict).toEqual({ decision: "pass" })
  })

  it("stops at the first deny so nothing downstream can re-allow it", async () => {
    const later = jest.fn(() => ({ decision: "pass" }))
    const chain = guardChain(() => ({ decision: "deny", reason: "policy" }), later)
    const { verdict } = await dispatchGuard("ui.action.invoke", {}, { ...context, chain })
    expect(verdict).toEqual({ decision: "deny", reason: "policy" })
    expect(later).not.toHaveBeenCalled()
  })

  it("denies when a guard on a fail-closed point throws", async () => {
    const chain = guardChain(() => {
      throw new Error("policy engine crashed")
    })
    const { verdict } = await dispatchGuard("ui.action.invoke", {}, { ...context, chain })
    expect(verdict.decision).toBe("deny")
  })

  it("requireGuardPass raises the structured denial", async () => {
    const chain = guardChain(() => ({ decision: "deny", reason: "nope" }))
    await expect(
      requireGuardPass("ui.action.invoke", {}, { ...context, chain })
    ).rejects.toBeInstanceOf(InterceptorGuardDeniedError)
  })
})

describe("dispatchObserve", () => {
  it("does not block, and drops past the point's queue limit", async () => {
    let started = 0
    const chain = Array.from({ length: 40 }, (_unused, index) =>
      registration({
        registrationId: `o${index}`,
        pointId: "operation.completed",
        semantic: "observe",
        handler: (() => {
          started += 1
          return new Promise((resolve) => setTimeout(resolve, 20))
        }) as never,
      })
    )

    const report = dispatchObserve(
      "operation.completed",
      { any: "payload" },
      {
        ...context,
        chain,
      }
    )

    // Returns without waiting: nothing has run yet on the caller's turn, which
    // is the property that keeps an observer off the critical path.
    expect(started).toBe(0)
    // `operation.completed` declares a queue limit of 32; the rest are shed
    // rather than queued, because unbounded telemetry on the chat path is a
    // worse outcome than a missing metric. The shed decision is synchronous.
    expect(report.dropped).toBe(8)

    await Promise.resolve()
    expect(started).toBe(32)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
})

describe("InterceptorInvariantError", () => {
  it("names the field it protected", () => {
    const error = new InterceptorInvariantError("model.request.prepare", "r1", "sessionId")
    expect(error.message).toContain("sessionId")
    expect(error.name).toBe("InterceptorInvariantError")
  })
})
