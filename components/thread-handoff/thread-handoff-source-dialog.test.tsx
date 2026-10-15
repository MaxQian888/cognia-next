import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
const mockGetSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ getSession: (id: string) => mockGetSession(id) }))
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
const mockWithCode = jest.fn()
let mockRefusal: string | null = null
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => true }))
jest.mock("@/lib/remote-host/code-supply/snapshot-handoff", () => ({
  continueOnHostRefusal: () => mockRefusal,
  continueSessionOnAlwaysOnHost: (...args: unknown[]) => mockWithCode(...args),
  continueOnHostFailure: () => "too-large",
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
  mockGetSession.mockResolvedValue(session)
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
  mockGetSession.mockResolvedValue(locked)
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

describe("an always-on Host can take the code along (ADR-0224 A11b)", () => {
  beforeEach(() => {
    mockRefusal = null
    mockHosts = [
      {
        id: "studio",
        label: "Studio Mac",
        alwaysOn: true,
        connectionState: "ready",
        featureManifest: { hostIdentity: { kind: "desktop" } },
      },
    ]
    mockWithCode.mockResolvedValue({ checkout: { branch: "cognia/handoff-abc" } })
  })

  it("brings the code by default and hands over through the code path", async () => {
    show()
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }))
    expect(screen.getByRole("checkbox", { name: "withCode" })).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "continue" }))
    await waitFor(() =>
      expect(mockWithCode).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ id: "studio" }),
        expect.objectContaining({ onProgress: expect.any(Function) })
      )
    )
    expect(mockRemote).not.toHaveBeenCalled()
    expect(mockChange).toHaveBeenCalledWith(false)
  })

  it("continues without the code when the person unticks it", async () => {
    show()
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: "withCode" }))
    fireEvent.click(screen.getByRole("button", { name: "continue" }))
    await waitFor(() => expect(mockRemote).toHaveBeenCalled())
    expect(mockWithCode).not.toHaveBeenCalled()
  })

  it("explains a Host that cannot take the code and does not offer it", async () => {
    mockRefusal = "host-unsupported"
    show()
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }))
    expect(screen.getByRole("checkbox", { name: "withCode" })).toBeDisabled()
    expect(screen.getByText("withCodeUnsupported")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "continue" }))
    await waitFor(() => expect(mockRemote).toHaveBeenCalled())
    expect(mockWithCode).not.toHaveBeenCalled()
  })

  it("names what failed and keeps the dialog open", async () => {
    mockWithCode.mockRejectedValue(new Error("code_snapshot_too_large"))
    show()
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }))
    fireEvent.click(screen.getByRole("button", { name: "continue" }))
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("codeFailure.too-large"))
    expect(mockChange).not.toHaveBeenCalledWith(false)
  })
})

it("hydrates encrypted session configuration before handing a projected row to another host", async () => {
  const full = { ...session, systemPrompt: "Secret prompt", sdkSessionId: "sdk-session" }
  mockGetSession.mockResolvedValue(full)
  show()
  fireEvent.click(screen.getByRole("button", { name: /My Cloud/ }))
  fireEvent.click(screen.getByRole("button", { name: "continue" }))
  await waitFor(() => expect(mockRemote).toHaveBeenCalledWith(full, expect.any(Object)))
})
