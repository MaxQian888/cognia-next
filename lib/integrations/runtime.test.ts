import { startIntegrationRuntime } from "./runtime"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"

const drainIntegrationActionJobs = jest.fn()
const pruneIntegrationRetention = jest.fn()
const disposeIngress = jest.fn()
const installIntegrationIngressRuntime = jest.fn()

jest.mock("./action-runner", () => ({
  drainIntegrationActionJobs: (...args: unknown[]) => drainIntegrationActionJobs(...args),
}))
jest.mock("@/lib/db/integrations", () => ({
  pruneIntegrationRetention: (...args: unknown[]) => pruneIntegrationRetention(...args),
}))
jest.mock("./ingress-client", () => ({
  installIntegrationIngressRuntime: (...args: unknown[]) =>
    installIntegrationIngressRuntime(...args),
}))
jest.mock("@/lib/diagnostics/bus", () => ({
  dispatchDiagnostic: jest.fn(),
}))

describe("Integration runtime", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    drainIntegrationActionJobs.mockReset().mockResolvedValue(undefined)
    pruneIntegrationRetention.mockReset().mockResolvedValue(undefined)
    disposeIngress.mockReset()
    installIntegrationIngressRuntime.mockReset().mockResolvedValue(disposeIngress)
    jest.mocked(dispatchDiagnostic).mockReset()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("starts the shared action, retention, and ingress loops and disposes them", async () => {
    const dispose = await startIntegrationRuntime()
    expect(drainIntegrationActionJobs).toHaveBeenCalledTimes(1)
    expect(pruneIntegrationRetention).toHaveBeenCalledTimes(1)
    expect(installIntegrationIngressRuntime).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(30_000)
    expect(drainIntegrationActionJobs).toHaveBeenCalledTimes(2)

    dispose()
    jest.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(pruneIntegrationRetention).toHaveBeenCalledTimes(1)
    expect(disposeIngress).toHaveBeenCalledTimes(1)
  })

  it("reports recurring job failures without leaving an unhandled rejection", async () => {
    const dispose = await startIntegrationRuntime()
    drainIntegrationActionJobs.mockRejectedValueOnce(new Error("action drain failed"))

    await jest.advanceTimersByTimeAsync(30_000)

    expect(dispatchDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "serverError",
        source: "connector",
        message: "action drain failed",
        meta: { extra: { stage: "action-drain" } },
      }),
      { kind: "background" }
    )
    dispose()
  })

  it("reports non-Error retention failures with their recurring stage", async () => {
    const dispose = await startIntegrationRuntime()
    pruneIntegrationRetention.mockRejectedValueOnce("retention unavailable")

    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(dispatchDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "serverError",
        source: "connector",
        message: "retention unavailable",
        meta: { extra: { stage: "retention-prune" } },
      }),
      { kind: "background" }
    )
    dispose()
  })
})
