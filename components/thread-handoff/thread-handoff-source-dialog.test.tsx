import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
const mockStart = jest.fn()
const mockRemote = jest.fn()
const mockRecover = jest.fn()
const mockUpdate = jest.fn()
const mockChange = jest.fn()
const mockToast = jest.fn()
let mockSnapshot: Record<string, unknown>
let mockHosts: Array<Record<string, unknown>>
let mockActiveHost: string | null = null
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: (...args: unknown[]) => mockToast(...args) },
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => Promise<unknown>) => {
    void query()
    return mockSnapshot
  },
}))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: () => mockSnapshot.devices }))
jest.mock("@/lib/db/thread-handoff-tickets", () => ({
  getThreadHandoffTicket: () => mockSnapshot.ticket,
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ hostDispatchQueue: { update: mockUpdate, get: () => mockSnapshot.dispatch } }),
}))
jest.mock("@/lib/thread-handoff/orchestrator", () => ({
  startThreadHandoff: (...args: unknown[]) => mockStart(...args),
  startRemoteThreadHandoff: (...args: unknown[]) => mockRemote(...args),
  recoverThreadHandoffOffer: (...args: unknown[]) => mockRecover(...args),
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (value: unknown) => unknown) =>
    selector({ hosts: mockHosts, activeHostId: mockActiveHost }),
}))
import {
  ThreadHandoffSourceDialog,
  threadHandoffTargetUnavailableReason,
} from "./thread-handoff-source-dialog"
const session = {
  id: "session",
  title: "Chat",
  kind: "direct",
  createdAt: 1,
  updatedAt: 1,
} as ChatSession
beforeEach(() => {
  jest.clearAllMocks()
  mockSnapshot = { devices: [] }
  mockHosts = [
    {
      id: "cloud",
      label: "My Cloud",
      connectionState: "disconnected",
      featureManifest: { hostIdentity: { kind: "cloud" } },
    },
  ]
  mockActiveHost = null
  mockRemote.mockResolvedValue({})
})
function show(value = session) {
  return render(<ThreadHandoffSourceDialog session={value} open onOpenChange={mockChange} />)
}
it("lists configured remote Hosts and transfers only on an explicit action", async () => {
  show()
  expect(mockRemote).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: /My Cloud/ }))
  fireEvent.click(screen.getByRole("button", { name: "continue" }))
  await waitFor(() =>
    expect(mockRemote).toHaveBeenCalledWith(session, {
      hostRef: "cloud",
      kind: "cloud",
      label: "My Cloud",
    })
  )
  expect(mockChange).toHaveBeenCalledWith(false)
  expect(mockStart).not.toHaveBeenCalled()
})
it("keeps a failed preflight visible without closing or claiming success", async () => {
  mockRemote.mockRejectedValue(new Error("workspace unavailable"))
  show()
  fireEvent.click(screen.getByRole("button", { name: /My Cloud/ }))
  fireEvent.click(screen.getByRole("button", { name: "continue" }))
  await waitFor(() => expect(mockToast).toHaveBeenCalledWith("failed"))
  expect(mockChange).not.toHaveBeenCalled()
})
it("excludes the current Host and blocks revoked targets", () => {
  mockActiveHost = "cloud"
  mockHosts.push({ id: "revoked", label: "Revoked Host", connectionState: "revoked" })
  show()
  expect(screen.queryByRole("button", { name: /My Cloud/ })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: /Revoked Host/ })).toBeDisabled()
  expect(screen.getByRole("button", { name: "continue" })).toBeDisabled()
})
it("resumes interrupted remote ownership instead of the mobile dispatch queue", async () => {
  const target = { hostRef: "cloud", kind: "cloud" }
  mockSnapshot = { devices: [], ticket: { target, state: "frozen" } }
  const locked = { ...session, handoffLock: { ticketId: "ticket", state: "frozen" } } as ChatSession
  show(locked)
  fireEvent.click(screen.getByRole("button", { name: "retry" }))
  await waitFor(() => expect(mockRemote).toHaveBeenCalledWith(locked, target))
  expect(mockUpdate).not.toHaveBeenCalled()
})
it.each([
  [{ revokedAt: 1 }, "revoked"],
  [{ pausedAt: 1 }, "paused"],
  [{ platform: "web" }, "not-mobile"],
  [{ platform: "android" }, "standalone-required"],
  [{ platform: "ios", capabilities: ["thread-handoff-v1"] }, null],
])("checks paired-device eligibility %j", (device, expected) => {
  expect(threadHandoffTargetUnavailableReason(device as PairedDeviceRow)).toBe(expected)
})

it("uses the existing mobile carrier for an eligible paired device", async () => {
  mockHosts = []
  mockSnapshot = {
    devices: [
      {
        deviceId: "phone",
        label: "My phone",
        platform: "android",
        capabilities: ["thread-handoff-v1"],
      },
    ],
  }
  show()
  fireEvent.click(screen.getByRole("button", { name: /My phone/ }))
  fireEvent.click(screen.getByRole("button", { name: "continue" }))
  await waitFor(() =>
    expect(mockStart).toHaveBeenCalledWith(session, {
      hostRef: "phone",
      label: "My phone",
      kind: "mobile",
    })
  )
})
it("requeues a failed mobile dispatch and displays preflight blockers", async () => {
  mockSnapshot = {
    devices: [],
    ticket: {
      target: { kind: "mobile" },
      state: "frozen",
      preflight: {
        blockers: [{ kind: "workspace-unavailable", ref: "workspace", severity: "blocking" }],
      },
    },
    dispatch: { id: "ticket", status: "failed" },
  }
  const locked = { ...session, handoffLock: { ticketId: "ticket", state: "frozen" } } as ChatSession
  show(locked)
  expect(screen.getByText("blocker.workspace-unavailable")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "retry" }))
  await waitFor(() =>
    expect(mockUpdate).toHaveBeenCalledWith(
      "ticket",
      expect.objectContaining({ status: "pending", attempts: 0 })
    )
  )
})
it("recovers missing mobile delivery and reports a failed retry", async () => {
  mockRecover.mockRejectedValueOnce(new Error("offline"))
  mockSnapshot = { devices: [], ticket: { target: { kind: "mobile" }, state: "frozen" } }
  show({ ...session, handoffLock: { ticketId: "ticket", state: "frozen" } } as ChatSession)
  fireEvent.click(screen.getByRole("button", { name: "retry" }))
  await waitFor(() => expect(mockRecover).toHaveBeenCalled())
  await waitFor(() => expect(mockToast).toHaveBeenCalledWith("failed"))
})
it("keeps committed sources read-only and offers remote completion retry", () => {
  mockSnapshot = { devices: [], ticket: { target: { kind: "cloud" }, state: "committed" } }
  show({ ...session, handoffLock: { ticketId: "ticket", state: "committed" } } as ChatSession)
  expect(screen.getByText("committedReadonly")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "retry" })).toBeEnabled()
  expect(screen.queryByText("stranded")).not.toBeInTheDocument()
})
it("explains an empty destination list", () => {
  mockHosts = []
  show()
  expect(screen.getByText("noDevices")).toBeInTheDocument()
})
it("preflights a desktop Host without cached feature metadata", async () => {
  mockHosts = [{ id: "desktop", label: "Desktop", connectionState: "disconnected" }]
  show()
  fireEvent.click(screen.getByRole("button", { name: /Desktop/ }))
  fireEvent.click(screen.getByRole("button", { name: "continue" }))
  await waitFor(() =>
    expect(mockRemote).toHaveBeenCalledWith(session, {
      hostRef: "desktop",
      kind: "desktop",
      label: "Desktop",
    })
  )
})
