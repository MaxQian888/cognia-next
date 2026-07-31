const detectCliMock = jest.fn()
jest.mock("@/lib/cli-bridge/detect-cli", () => ({
  detectCli: (name: string, versionArg?: string) => detectCliMock(name, versionArg),
  satisfiesMinVersion: jest.requireActual("@/lib/cli-bridge/detect-cli").satisfiesMinVersion,
}))

import { getPluginBinaryStatuses } from "./binary-status"

describe("getPluginBinaryStatuses", () => {
  beforeEach(() => {
    detectCliMock.mockReset()
  })

  it("returns empty for manifests without binary requirements", async () => {
    await expect(getPluginBinaryStatuses({})).resolves.toEqual([])
    await expect(getPluginBinaryStatuses({ requires: {} })).resolves.toEqual([])
  })

  it("maps available, missing, and below-min binaries", async () => {
    detectCliMock.mockImplementation(async (name: string) => {
      if (name === "rg") {
        return { available: true, version: "ripgrep 14.1.0", path: "C:/bin/rg.exe", error: null }
      }
      if (name === "old") {
        return { available: true, version: "old 0.1.0", path: "/bin/old", error: null }
      }
      return { available: false, version: null, path: null, error: "not found" }
    })

    const statuses = await getPluginBinaryStatuses({
      requires: {
        binaries: [
          { name: "rg", minVersion: "13.0.0" },
          { name: "old", minVersion: "1.0.0", documentation: "https://example.com/install" },
          { name: "ghost", documentation: "https://example.com/ghost" },
        ],
      },
    })

    expect(statuses).toEqual([
      expect.objectContaining({ name: "rg", available: true, satisfiesMin: true }),
      expect.objectContaining({
        name: "old",
        available: true,
        satisfiesMin: false,
        minVersion: "1.0.0",
        documentation: "https://example.com/install",
      }),
      expect.objectContaining({
        name: "ghost",
        available: false,
        satisfiesMin: false,
        documentation: "https://example.com/ghost",
      }),
    ])
  })
})
