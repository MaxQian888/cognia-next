import { render } from "@testing-library/react"
import { OrchestrationDispatchProvider } from "./orchestration-dispatch-provider"
import type { OrchestrationExecRequest } from "@/lib/external-bridge/orchestration-ipc"

let capturedHandler: ((req: OrchestrationExecRequest) => void) | null = null
const subscribeMock = jest.fn()
const sendMock = jest.fn()
jest.mock("@/lib/external-bridge/orchestration-ipc", () => ({
  subscribeOrchestrationExec: (...a: unknown[]) => subscribeMock(...a),
  sendOrchestrationResponse: (...a: unknown[]) => sendMock(...a),
}))

const runOrchestrationExecMock = jest.fn()
jest.mock("@/lib/external-bridge/handlers/orchestration", () => ({
  runOrchestrationExec: (...a: unknown[]) => runOrchestrationExecMock(...a),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { app: { error: jest.fn() } },
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  capturedHandler = null
  subscribeMock.mockReset().mockImplementation((h: (req: OrchestrationExecRequest) => void) => {
    capturedHandler = h
    return Promise.resolve(() => {})
  })
  sendMock.mockReset().mockResolvedValue(undefined)
  runOrchestrationExecMock.mockReset()
})

describe("OrchestrationDispatchProvider", () => {
  it("subscribes on mount", async () => {
    render(<OrchestrationDispatchProvider />)
    await flush()
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(capturedHandler).toBeInstanceOf(Function)
  })

  it("runs the command and posts the result back with ok:true", async () => {
    runOrchestrationExecMock.mockResolvedValue({ ok: true, text: "done", redacted: true })
    render(<OrchestrationDispatchProvider />)
    await flush()
    capturedHandler!({ id: "r1", command: "agent_dispatch", args: { prompt: "p" } })
    await flush()
    expect(runOrchestrationExecMock).toHaveBeenCalledWith("agent_dispatch", { prompt: "p" })
    expect(sendMock).toHaveBeenCalledWith({
      id: "r1",
      ok: true,
      result: { ok: true, text: "done", redacted: true },
    })
  })

  it("forwards a redacted handler output verbatim (PII stays redacted across the wire)", async () => {
    runOrchestrationExecMock.mockResolvedValue({
      ok: true,
      text: "mail [[EMAIL_1]]",
      redacted: true,
    })
    render(<OrchestrationDispatchProvider />)
    await flush()
    capturedHandler!({ id: "r9", command: "agent_dispatch", args: {} })
    await flush()
    const sent = sendMock.mock.calls[0][0] as { result: { text: string; redacted: boolean } }
    expect(sent.result.text).toBe("mail [[EMAIL_1]]")
    expect(sent.result.redacted).toBe(true)
  })

  it("collapses a thrown run onto an ok:false reply", async () => {
    runOrchestrationExecMock.mockRejectedValue(new Error("kaboom"))
    render(<OrchestrationDispatchProvider />)
    await flush()
    capturedHandler!({ id: "r2", command: "team_run", args: {} })
    await flush()
    expect(sendMock).toHaveBeenCalledWith({ id: "r2", ok: false, error: "kaboom" })
  })
})
