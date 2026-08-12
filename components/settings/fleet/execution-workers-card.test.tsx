/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ExecutionWorkersCard } from "./execution-workers-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="worker-qr">{value}</div>,
}))
const api = {
  create: jest.fn(),
  list: jest.fn(),
  revoke: jest.fn(),
}
jest.mock("@/lib/fleet/execution-workers", () => ({
  createWorkerEnrollment: () => api.create(),
  listExecutionWorkers: () => api.list(),
  revokeExecutionWorker: (id: string) => api.revoke(id),
  workerEnrollmentCommand: () => "cognia-agent worker enroll --enrollment once",
}))

describe("ExecutionWorkersCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    api.list.mockResolvedValue([
      {
        deviceId: "worker-a",
        displayName: "Worker A",
        capabilities: ["agent.worker"],
      },
    ])
    api.revoke.mockResolvedValue(undefined)
  })

  it("shows authenticated host readiness and creates one-time enrollment", async () => {
    api.create.mockResolvedValue({
      enrollment: "once",
      expiresAtMs: 10,
      baseUrl: "https://brain",
      fingerprint: "sha256:x",
      tenantId: "tenant-a",
    })
    render(
      <ExecutionWorkersCard
        hosts={[
          {
            hostRef: "device:worker-a",
            online: true,
            maxActiveTurns: 2,
            usedSlots: 1,
            runtime: "test",
            workspaceBindingReady: true,
            lastSeenAt: 1,
          },
        ]}
      />
    )
    expect(await screen.findByText("Worker A")).toBeInTheDocument()
    expect(screen.getByText("online")).toBeInTheDocument()
    fireEvent.click(screen.getByText("enroll"))
    expect(await screen.findByTestId("worker-qr")).toHaveTextContent("once")
  })

  it("revokes only the worker capability through the management API", async () => {
    api.create.mockResolvedValue(null)
    render(<ExecutionWorkersCard hosts={[]} />)
    fireEvent.click(await screen.findByText("revoke"))
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith("worker-a"))
  })
})
