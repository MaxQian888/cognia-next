/**
 * @jest-environment node
 */

jest.mock("@cognia/logging", () => {
  // Namespace-agnostic on purpose. These mocks used to list the handful of
  // `loggers.*` names the suite happened to reach, so the day an import chain
  // grew a new one the whole suite died at load with
  // "Cannot read properties of undefined (reading 'child')" and zero tests ran.
  // A Proxy answers for any namespace, so graph growth cannot go dark here.
  const child: Record<string, unknown> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  }
  child.child = () => child
  return {
    createLogger: () => child,
    logger: child,
    loggers: new Proxy({} as Record<string, unknown>, { get: () => child }),
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

import {
  activateAgentTeamAccountStorage,
  clearAgentTeamAccountStorage,
  purgeAgentTeamAccountStorage,
} from "./store"

describe("agent-team account storage without a browser window", () => {
  it("no-ops browser bucket helpers when window is unavailable", () => {
    expect(typeof window).toBe("undefined")
    expect(() => purgeAgentTeamAccountStorage("acct_server")).not.toThrow()
    expect(() => activateAgentTeamAccountStorage("acct_server")).not.toThrow()
    expect(() => clearAgentTeamAccountStorage()).not.toThrow()
  })
})
