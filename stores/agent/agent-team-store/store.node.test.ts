/**
 * @jest-environment node
 */

jest.mock("@cognia/logging", () => {
  const childLogger = {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }
  return {
    createLogger: () => ({ ...childLogger, child: () => childLogger }),
    logger: { ...childLogger, child: () => childLogger },
    loggers: {
      agent: {
        child: () => childLogger,
      },
      plugin: {
        child: () => childLogger,
      },
    },
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
