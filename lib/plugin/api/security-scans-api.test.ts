jest.mock("@/lib/execution/control-handlers", () => ({
  registerSecurityScanRunController: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/execution/security-scan-bridge", () => ({
  syncSecurityScanExecutionRun: jest.fn(async () => undefined),
}))

import { registerSecurityScanRunController } from "@/lib/execution/control-handlers"
import { syncSecurityScanExecutionRun } from "@/lib/execution/security-scan-bridge"
import { createSecurityScansAPI } from "./security-scans-api"

describe("createSecurityScansAPI", () => {
  it("delegates run projection and cancellation ownership", async () => {
    const api = createSecurityScansAPI()
    const record = {
      runId: "scan-1",
      target: "example.com",
      startedAt: 1,
      status: "running" as const,
      findingsCount: 0,
    }
    const controller = new AbortController()

    await api.syncExecutionRun(record)
    api.registerRunController("execution:security-scan:scan-1", controller)

    expect(syncSecurityScanExecutionRun).toHaveBeenCalledWith(record)
    expect(registerSecurityScanRunController).toHaveBeenCalledWith(
      "execution:security-scan:scan-1",
      controller
    )
  })
})
