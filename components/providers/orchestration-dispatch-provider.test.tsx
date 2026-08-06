import { render } from "@testing-library/react"
import { OrchestrationDispatchProvider } from "./orchestration-dispatch-provider"

const installMock = jest.fn()
jest.mock("@/lib/external-bridge/orchestration-ipc", () => ({
  installOrchestrationDispatchSource: (...args: unknown[]) => installMock(...args),
}))

const logErrorMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { app: { error: (...args: unknown[]) => logErrorMock(...args) } },
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  installMock.mockReset().mockResolvedValue(() => undefined)
  logErrorMock.mockReset()
})

describe("OrchestrationDispatchProvider", () => {
  it("installs the shared dispatch source on mount", async () => {
    render(<OrchestrationDispatchProvider />)
    await flush()
    expect(installMock).toHaveBeenCalledWith({ onError: expect.any(Function) })
  })

  it("uninstalls the shared source on unmount", async () => {
    const uninstall = jest.fn()
    installMock.mockResolvedValue(uninstall)
    const view = render(<OrchestrationDispatchProvider />)
    await flush()
    view.unmount()
    expect(uninstall).toHaveBeenCalled()
  })
})
