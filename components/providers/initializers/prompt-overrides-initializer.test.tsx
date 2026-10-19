/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"

const loadMock = jest.fn(async () => undefined)
const invalidateMock = jest.fn()
jest.mock("@/lib/prompts/snapshot", () => ({
  loadPromptOverrideSnapshot: () => loadMock(),
  invalidatePromptOverrideSnapshot: () => invalidateMock(),
}))
const listMock = jest.fn(async () => [])
jest.mock("@/lib/db/prompt-overrides", () => ({
  listPromptOverrideBindings: () => listMock(),
}))
const warnMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { shell: { warn: (...a: unknown[]) => warnMock(...a), info: jest.fn() } },
}))

// `Dexie.liveQuery` rather than the named export, which is undefined under
// Jest's module interop. Stubbed so emissions are driven by the test.
const unsubscribe = jest.fn()
let emit: ((rows: unknown) => void) | null = null
let fail: ((err: unknown) => void) | null = null
let subscriptions = 0
jest.mock("dexie", () => ({
  __esModule: true,
  default: {
    liveQuery: (query: () => Promise<unknown>) => ({
      subscribe: (o: { next: (rows: unknown) => void; error: (err: unknown) => void }) => {
        subscriptions += 1
        emit = o.next
        fail = o.error
        void query()
        return { unsubscribe }
      },
    }),
  },
}))

import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { PromptOverridesInitializer } from "./prompt-overrides-initializer"

beforeEach(() => {
  clearActiveRuntimeTargetContext()
  loadMock.mockClear()
  invalidateMock.mockClear()
  listMock.mockClear()
  warnMock.mockClear()
  unsubscribe.mockClear()
  emit = null
  fail = null
  subscriptions = 0
})

describe("PromptOverridesInitializer", () => {
  it("loads the snapshot on the first emission without discarding it", () => {
    render(<PromptOverridesInitializer />)
    expect(listMock).toHaveBeenCalledTimes(1)
    act(() => emit?.([]))
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it("reloads from the database when the bindings change elsewhere", () => {
    render(<PromptOverridesInitializer />)
    act(() => emit?.([]))
    act(() => emit?.([{ id: "pob" }]))
    expect(invalidateMock).toHaveBeenCalledTimes(1)
    expect(loadMock).toHaveBeenCalledTimes(2)
  })

  it("re-subscribes for a new runtime target and drops the old subscription", () => {
    render(<PromptOverridesInitializer />)
    expect(subscriptions).toBe(1)
    act(() => setActiveRuntimeTargetContext("acct_local", "host-b"))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscriptions).toBe(2)
  })

  it("logs a failed live query instead of throwing", () => {
    render(<PromptOverridesInitializer />)
    act(() => fail?.(new Error("closed")))
    expect(warnMock).toHaveBeenCalledWith("prompt-overrides: live query failed", expect.anything())
  })

  it("stops reacting after unmount", () => {
    const { unmount } = render(<PromptOverridesInitializer />)
    const next = emit
    unmount()
    act(() => next?.([]))
    expect(loadMock).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
