/** @jest-environment jsdom */

import { act, render } from "@testing-library/react"

const dispose = jest.fn()
const runSquadBootstrap = jest.fn(() => ({ done: Promise.resolve({ ok: true }), dispose }))
jest.mock("@/lib/agent-team/bootstrap", () => ({
  runSquadBootstrap: () => runSquadBootstrap(),
}))

let accountState = { accountRevision: 0, unlockedAccountId: "acct-1" as string | null }
const listeners = new Set<() => void>()
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: typeof accountState) => unknown) => {
    // A tiny external store so the effect re-runs on the keys it declares.
    const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react")
    return useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => selector(accountState)
    )
  },
}))

import { SquadBootstrapInitializer } from "./squad-bootstrap-initializer"

function setAccount(next: Partial<typeof accountState>) {
  accountState = { ...accountState, ...next }
  listeners.forEach((listener) => listener())
}

describe("SquadBootstrapInitializer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    accountState = { accountRevision: 0, unlockedAccountId: "acct-1" }
  })

  it("runs the bootstrap once for an unlocked account and disposes it on unmount", () => {
    const view = render(<SquadBootstrapInitializer />)
    expect(runSquadBootstrap).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("does nothing while the account is locked", () => {
    accountState = { accountRevision: 0, unlockedAccountId: null }
    render(<SquadBootstrapInitializer />)
    expect(runSquadBootstrap).not.toHaveBeenCalled()
  })

  it("restarts against the newly selected account", () => {
    render(<SquadBootstrapInitializer />)
    act(() => setAccount({ accountRevision: 1, unlockedAccountId: "acct-2" }))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(runSquadBootstrap).toHaveBeenCalledTimes(2)
  })

  it("renders nothing", () => {
    const { container } = render(<SquadBootstrapInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
