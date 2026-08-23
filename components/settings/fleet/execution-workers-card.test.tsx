/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ExecutionWorkersCard } from "./execution-workers-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="worker-qr">{value}</div>,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
const { toast: mockToast } = jest.requireMock<{
  toast: { error: jest.Mock; success: jest.Mock }
}>("sonner")
jest.mock("@/components/ai-elements/snippet", () => ({
  Snippet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SnippetInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  SnippetCopyButton: ({ onCopy, onError }: { onCopy?: () => void; onError?: () => void }) => (
    <>
      <button onClick={onCopy}>copy-ok</button>
      <button onClick={onError}>copy-error</button>
    </>
  ),
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

import {
  installRemoteWorkerRuntime,
  __resetRemoteWorkerRuntimeForTesting,
  type RemoteWorkerRuntime,
} from "@/lib/ai/agent/team/remote-worker-runtime"
import { isAgentTeamRemoteDispatchEnabled } from "@/lib/ai/agent/execution/feature-flags"

describe("ExecutionWorkersCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.localStorage.clear()
    api.list.mockResolvedValue([
      {
        deviceId: "worker-a",
        hostRef: "device:derived-worker-a",
        displayName: "Worker A",
        capabilities: ["agent.worker"],
      },
    ])
    api.revoke.mockResolvedValue(undefined)
  })

  it("lets the operator enable and stop new remote AgentTeam dispatch", async () => {
    render(<ExecutionWorkersCard hosts={[]} />)

    const toggle = await screen.findByRole("switch", { name: "remoteDispatchLabel" })
    expect(toggle).not.toBeChecked()
    expect(isAgentTeamRemoteDispatchEnabled()).toBe(false)

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(isAgentTeamRemoteDispatchEnabled()).toBe(true)

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(isAgentTeamRemoteDispatchEnabled()).toBe(false)
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
            hostRef: "device:derived-worker-a",
            online: true,
            maxActiveTurns: 2,
            usedSlots: 1,
            runtime: "test",
            workspaceBindingReady: true,
            lastSeenAt: 1,
            placementReady: true,
          },
        ]}
      />
    )
    expect(await screen.findByText("Worker A")).toBeInTheDocument()
    expect(screen.getByText("online")).toBeInTheDocument()
    fireEvent.click(screen.getByText("enroll"))
    expect(await screen.findByTestId("worker-qr")).toHaveTextContent("once")
    fireEvent.click(screen.getByText("copy-ok"))
    fireEvent.click(screen.getByText("copy-error"))
    expect(mockToast.success).toHaveBeenCalledWith("copied")
    expect(mockToast.error).toHaveBeenCalledWith("copyFailed")
  })

  it("uses the management DTO hostRef and exposes placement incompatibility", async () => {
    render(
      <ExecutionWorkersCard
        hosts={[
          {
            hostRef: "device:derived-worker-a",
            online: true,
            maxActiveTurns: 1,
            runtime: "test",
            workspaceBindingReady: true,
            lastSeenAt: 1,
            placementReady: false,
            placementReason: "execution_profile_missing",
          },
        ]}
      />
    )
    expect(await screen.findByText("incompatible")).toBeInTheDocument()
    expect(screen.getByText("placementReason")).toBeInTheDocument()
  })

  it("does not present a retained offline Fleet host as online", async () => {
    render(
      <ExecutionWorkersCard
        hosts={[
          {
            hostRef: "device:derived-worker-a",
            online: false,
            maxActiveTurns: 1,
            runtime: "test",
            workspaceBindingReady: true,
            lastSeenAt: 1,
            placementReady: true,
          },
        ]}
      />
    )
    expect(await screen.findByText("offline")).toBeInTheDocument()
    expect(screen.queryByText("capacity")).not.toBeInTheDocument()
  })

  it("says so when the host has enrolled workers but cannot dispatch to them", async () => {
    // Before desktop dispatch existed this was the silent failure: a worker
    // authenticated, showed "online", and never received a frame, because no
    // brain was attached on the host. Rule 7 — dormancy has to be visible.
    __resetRemoteWorkerRuntimeForTesting()
    render(<ExecutionWorkersCard hosts={[]} />)

    expect(await screen.findByText("dispatchUnavailable")).toBeInTheDocument()
  })

  it("drops the warning once a brain attaches on this host", async () => {
    __resetRemoteWorkerRuntimeForTesting()
    render(<ExecutionWorkersCard hosts={[]} />)
    expect(await screen.findByText("dispatchUnavailable")).toBeInTheDocument()

    let uninstall = () => undefined as void
    act(() => {
      uninstall = installRemoteWorkerRuntime({
        listWorkers: () => [],
        run: jest.fn(),
      } as unknown as RemoteWorkerRuntime)
    })

    await waitFor(() => expect(screen.queryByText("dispatchUnavailable")).not.toBeInTheDocument())
    act(() => uninstall())
  })

  it("revokes only the worker capability through the management API", async () => {
    api.create.mockResolvedValue(null)
    render(<ExecutionWorkersCard hosts={[]} />)
    fireEvent.click(await screen.findByText("revoke"))
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith("worker-a"))
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
    expect(mockToast.success).toHaveBeenCalledWith("revoked")
  })

  it.each([
    [new Error("companion_not_connected"), "notConnected"],
    [new Error("enrollment failed"), "enrollment failed"],
    ["string failure", "string failure"],
  ])("reports enrollment failures without leaving the card busy", async (failure, detail) => {
    api.create.mockRejectedValue(failure)
    render(<ExecutionWorkersCard hosts={[]} />)
    fireEvent.click(await screen.findByText("enroll"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("error"))
    expect(detail).toBeTruthy()
    expect(screen.getByText("enroll")).toBeEnabled()
  })

  it("reports revoke failures and tolerates a failed or late initial refresh", async () => {
    api.revoke.mockRejectedValueOnce("revoke failed")
    const { unmount } = render(<ExecutionWorkersCard hosts={[]} />)
    fireEvent.click(await screen.findByText("revoke"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("error"))
    unmount()

    let resolveList!: (workers: unknown[]) => void
    api.list.mockReturnValueOnce(new Promise((resolve) => (resolveList = resolve)))
    const late = render(<ExecutionWorkersCard hosts={[]} />)
    late.unmount()
    resolveList([])
    await Promise.resolve()

    api.list.mockRejectedValueOnce(new Error("list failed"))
    const failed = render(<ExecutionWorkersCard hosts={[]} />)
    await Promise.resolve()
    failed.unmount()
  })
})
