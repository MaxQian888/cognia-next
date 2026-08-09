import { startIntegrationRuntime } from "./runtime"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"

const drainIntegrationActionJobs = jest.fn()
const pruneIntegrationRetention = jest.fn()
const disposeIngress = jest.fn()
const installIntegrationIngressRuntime = jest.fn()
const disposeGithubAuth = jest.fn()
const registerGithubIntegrationAuthProviders: jest.Mock = jest.fn(() => disposeGithubAuth)
const reconcileGithubAppDeliveries = jest.fn()

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
jest.mock("./github-auth", () => ({
  registerGithubIntegrationAuthProviders: (...args: unknown[]) =>
    registerGithubIntegrationAuthProviders(...args),
}))
jest.mock("./github-delivery-recovery", () => ({
  reconcileGithubAppDeliveries: (...args: unknown[]) => reconcileGithubAppDeliveries(...args),
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
    disposeGithubAuth.mockReset()
    registerGithubIntegrationAuthProviders.mockClear()
    reconcileGithubAppDeliveries.mockReset().mockResolvedValue(undefined)
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
    expect(registerGithubIntegrationAuthProviders).toHaveBeenCalledTimes(1)
    expect(reconcileGithubAppDeliveries).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(30_000)
    expect(drainIntegrationActionJobs).toHaveBeenCalledTimes(2)

    jest.advanceTimersByTime(15 * 60_000 - 30_000)
    expect(reconcileGithubAppDeliveries).toHaveBeenCalledTimes(2)

    dispose()
    jest.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(pruneIntegrationRetention).toHaveBeenCalledTimes(1)
    expect(disposeIngress).toHaveBeenCalledTimes(1)
    expect(disposeGithubAuth).toHaveBeenCalledTimes(1)
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

  it("isolates startup failures and still installs recurring recovery", async () => {
    reconcileGithubAppDeliveries.mockRejectedValueOnce(new Error("GitHub unavailable"))
    installIntegrationIngressRuntime.mockRejectedValueOnce(new Error("ingress unavailable"))

    const dispose = await startIntegrationRuntime()

    expect(dispatchDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "GitHub unavailable",
        meta: { extra: { stage: "github-delivery-reconciliation" } },
      }),
      { kind: "background" }
    )
    expect(dispatchDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "ingress unavailable",
        meta: { extra: { stage: "ingress-install" } },
      }),
      { kind: "background" }
    )
    await jest.advanceTimersByTimeAsync(15 * 60_000)
    expect(reconcileGithubAppDeliveries).toHaveBeenCalledTimes(2)
    dispose()
    expect(disposeGithubAuth).toHaveBeenCalledTimes(1)
  })
})
