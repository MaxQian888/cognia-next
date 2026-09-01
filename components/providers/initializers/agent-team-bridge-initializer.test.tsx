/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const start = jest.fn(() => stop)
const stop = jest.fn()
let unlockedAccountId: string | null = "acct_a"
let accountRevision = 1

jest.mock("@/stores/agent/agent-team-store/dexie-bridge", () => ({
  startAgentTeamDexieBridge: () => start(),
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: unknown) => unknown) =>
    selector({ unlockedAccountId, accountRevision }),
}))

import { AgentTeamBridgeInitializer } from "./agent-team-bridge-initializer"

describe("AgentTeamBridgeInitializer", () => {
  beforeEach(() => {
    start.mockClear()
    stop.mockClear()
    unlockedAccountId = "acct_a"
    accountRevision = 1
  })

  it("starts the mirror once an account is unlocked", () => {
    render(<AgentTeamBridgeInitializer />)
    expect(start).toHaveBeenCalledTimes(1)
  })

  /** A locked account has no database, so hydration would read the wrong one. */
  it("stays out of the way while the account is locked", () => {
    unlockedAccountId = null
    render(<AgentTeamBridgeInitializer />)
    expect(start).not.toHaveBeenCalled()
  })

  it("stops the mirror when it unmounts", () => {
    const view = render(<AgentTeamBridgeInitializer />)
    view.unmount()
    expect(stop).toHaveBeenCalled()
  })
})
