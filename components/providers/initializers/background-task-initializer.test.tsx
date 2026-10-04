import { render, waitFor } from "@testing-library/react"

const setRendererBackgroundSettleListener = jest.fn()
const registerBackgroundResultNotifyStrings = jest.fn((_strings: unknown) => jest.fn())
const onBackgroundRunSettled = jest.fn()
const stopRecovery = jest.fn()
const startBackgroundTaskRecovery = jest.fn(
  (_options: { onResumed: (count: number) => Promise<void> }) => stopRecovery
)
const notify = jest.fn(async () => "n1")
let accountRevision = 1
let targetId: string | undefined = "local"
let vaultState = "unlocked"
const translate = (key: string, values?: Record<string, unknown>) =>
  `${key}${values ? `:${JSON.stringify(values)}` : ""}`

jest.mock("next-intl", () => ({ useTranslations: () => translate }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (select: (state: { accountRevision: number }) => unknown) =>
    select({ accountRevision }),
}))
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ target: targetId ? { id: targetId } : undefined, vaultState }),
}))
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  setRendererBackgroundSettleListener: (...args: unknown[]) =>
    setRendererBackgroundSettleListener(...args),
}))
jest.mock("@/hooks/chat/background-result-runtime", () => ({
  onBackgroundRunSettled: (...args: unknown[]) => onBackgroundRunSettled(...args),
  registerBackgroundResultNotifyStrings: (strings: unknown) =>
    registerBackgroundResultNotifyStrings(strings),
}))
jest.mock("@/lib/background-tasks/redispatch", () => ({
  startBackgroundTaskRecovery: (options: { onResumed: (count: number) => Promise<void> }) =>
    startBackgroundTaskRecovery(options),
}))
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => notify(...(args as [])),
}))

import { BackgroundTaskInitializer } from "./background-task-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  accountRevision = 1
  targetId = "local"
  vaultState = "unlocked"
})

it("starts shared recovery and stops on unmount", () => {
  const { container, unmount } = render(<BackgroundTaskInitializer />)
  expect(container).toBeEmptyDOMElement()
  expect(startBackgroundTaskRecovery).toHaveBeenCalledTimes(1)
  unmount()
  expect(stopRecovery).toHaveBeenCalledTimes(1)
})

it("wires localized settlement copy and unwires on unmount", () => {
  const { unmount } = render(<BackgroundTaskInitializer />)
  const listener = setRendererBackgroundSettleListener.mock.calls[0][0] as (
    ...args: unknown[]
  ) => void
  listener("r1", { kind: "subagent" }, { status: "done" })
  expect(onBackgroundRunSettled).toHaveBeenCalledWith(
    "r1",
    { kind: "subagent" },
    { status: "done" }
  )
  const strings = registerBackgroundResultNotifyStrings.mock.calls[0]![0] as {
    title: (p: { subagentId: string; status: string; elapsed: string }) => string
    body: (p: { runId: string }) => string
  }
  expect(strings.title({ subagentId: "explore", status: "done", elapsed: "3s" })).toContain(
    "doneTitle"
  )
  expect(strings.title({ subagentId: "explore", status: "error", elapsed: "3s" })).toContain(
    "failedTitle"
  )
  expect(strings.body({ runId: "r1" })).toContain("body")
  unmount()
  expect(setRendererBackgroundSettleListener).toHaveBeenLastCalledWith(undefined)
})

it("rebinds after account and runtime target changes and stops when locked", () => {
  const { rerender } = render(<BackgroundTaskInitializer />)
  accountRevision += 1
  rerender(<BackgroundTaskInitializer />)
  expect(stopRecovery).toHaveBeenCalledTimes(1)
  expect(startBackgroundTaskRecovery).toHaveBeenCalledTimes(2)
  targetId = "companion"
  rerender(<BackgroundTaskInitializer />)
  expect(stopRecovery).toHaveBeenCalledTimes(2)
  expect(startBackgroundTaskRecovery).toHaveBeenCalledTimes(3)
  vaultState = "locked"
  rerender(<BackgroundTaskInitializer />)
  expect(stopRecovery).toHaveBeenCalledTimes(3)
  expect(startBackgroundTaskRecovery).toHaveBeenCalledTimes(3)
})

it("does not access the recovery database before an unlocked target exists", () => {
  targetId = undefined
  const { rerender } = render(<BackgroundTaskInitializer />)
  expect(startBackgroundTaskRecovery).not.toHaveBeenCalled()
  targetId = "local"
  vaultState = "locked"
  rerender(<BackgroundTaskInitializer />)
  expect(startBackgroundTaskRecovery).not.toHaveBeenCalled()
})

it("uses the existing translated summary notification", async () => {
  render(<BackgroundTaskInitializer />)
  await startBackgroundTaskRecovery.mock.calls[0][0].onResumed(2)
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'autoResumed:{"count":2}',
        dedupeKey: "background-auto-resume",
      })
    )
  )
})

it("does not notify after the lifecycle has stopped", async () => {
  const { unmount } = render(<BackgroundTaskInitializer />)
  const callback = startBackgroundTaskRecovery.mock.calls[0][0].onResumed
  unmount()
  await callback(1)
  expect(notify).not.toHaveBeenCalled()
})
