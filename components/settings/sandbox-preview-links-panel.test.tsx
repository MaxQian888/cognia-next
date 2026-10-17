import { fireEvent, render, screen } from "@testing-library/react"
import { SandboxPreviewLinksPanel } from "./sandbox-preview-links-panel"
import { useSandboxPreviewLinks } from "@/hooks/sandbox/use-sandbox-preview-links"
import type { SandboxPreviewTarget } from "@/lib/sandbox/previews"
import en from "@/i18n/messages/en/sandboxManagement.json"
import zh from "@/i18n/messages/zh-CN/sandboxManagement.json"

jest.mock("@/hooks/sandbox/use-sandbox-preview-links", () => ({
  useSandboxPreviewLinks: jest.fn(),
}))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: jest.fn() }))
const mockDevices = jest.fn()
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockDevices() }))
const create = jest.fn()
const target = {
  workspaceId: "w",
  provider: "local",
  containerId: "c",
  executionRoot: "/fork",
  workspaceState: "active",
  ports: [{ port: 20002, label: "App", containerId: "c", projectId: "p", path: "/port" }],
  portLease: { basePort: 20000, portCount: 10 },
} as SandboxPreviewTarget
beforeEach(() => {
  jest.clearAllMocks()
  mockDevices.mockReturnValue([
    { deviceId: "desk", label: "Studio Mac", platform: "desktop" },
    { deviceId: "phone", label: "Pixel", platform: "android" },
    { deviceId: "gone", label: "Old Mac", platform: "desktop", revokedAt: 1 },
  ])
  jest.mocked(useSandboxPreviewLinks).mockReturnValue({
    grants: [],
    loading: false,
    busy: false,
    error: null,
    copyable: [],
    now: Date.now(),
    refresh: jest.fn(),
    create,
    copy: jest.fn(),
    open: jest.fn(),
    revoke: jest.fn(),
  })
})

it("creates a local-owner lease-offset preview and limits expiry choices to an hour", () => {
  render(<SandboxPreviewLinksPanel projectId="p" targets={[target]} />)
  fireEvent.click(screen.getByRole("button", { name: en.previews.create }))
  expect(create).toHaveBeenCalledWith(
    {
      workspaceId: "w",
      provider: "local",
      containerId: "c",
      expiresInSeconds: 900,
      originMode: "localhost",
      port: { kind: "workspace-lease-offset", offset: 2 },
    },
    { kind: "localOwner" }
  )
  const choices = screen.getByRole("combobox", { name: en.previews.expiry }) as HTMLSelectElement
  expect([...choices.options].map((option) => Number(option.value))).toEqual([300, 900, 1800, 3600])
})

it("shares with a paired desktop and lists phones and browsers as inert", () => {
  render(<SandboxPreviewLinksPanel projectId="p" targets={[target]} />)
  const audience = screen.getByRole("combobox", { name: en.previews.audience }) as HTMLSelectElement
  expect([...audience.options].map((option) => [option.value, option.disabled])).toEqual([
    ["localOwner", false],
    ["device:desk", false],
    ["device:phone", true],
  ])
  expect(screen.getByText(en.previews.pairedMobileInactive)).toHaveAttribute(
    "data-dormant",
    "paired-mobile-preview"
  )
  // A manipulated DOM cannot pick a device without the native relay.
  fireEvent.change(audience, { target: { value: "device:phone" } })
  fireEvent.click(screen.getByRole("button", { name: en.previews.create }))
  expect(create).toHaveBeenLastCalledWith(expect.anything(), { kind: "localOwner" })
  fireEvent.change(audience, { target: { value: "device:desk" } })
  expect(screen.getByText(en.previews.pairedHelp)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: en.previews.create }))
  expect(create).toHaveBeenLastCalledWith(expect.anything(), {
    kind: "pairedDevice",
    deviceId: "desk",
  })
  expect(zh.previews.pairedMobileInactive).toBeTruthy()
})

it("shows a paired grant's device and offers no local copy or open", () => {
  jest.mocked(useSandboxPreviewLinks).mockReturnValue({
    ...jest.mocked(useSandboxPreviewLinks)("p"),
    grants: [
      {
        id: "g",
        origin: "/api/sandbox/previews/g/",
        audience: { kind: "pairedDevice", deviceId: "desk" },
        expiresAt: Date.now() + 60_000,
        revoked: false,
      } as never,
    ],
  })
  render(<SandboxPreviewLinksPanel projectId="p" targets={[target]} />)
  expect(screen.getByText("Shared with Studio Mac")).toBeInTheDocument()
  expect(screen.getByText(en.previews.opensOnDevice)).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: en.previews.open })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: en.previews.copyOnce })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: en.previews.revoke })).toBeEnabled()
})

it("marks numeric fallback inert and never emits it even if the DOM selection is manipulated", () => {
  render(<SandboxPreviewLinksPanel projectId="p" targets={[target]} />)
  expect(screen.getByRole("option", { name: en.previews.loopbackOrigin })).toBeDisabled()
  expect(screen.getByText(en.previews.originHelp)).toHaveAttribute(
    "data-dormant",
    "numeric-preview-origin"
  )
  fireEvent.change(screen.getByLabelText(en.previews.origin), { target: { value: "loopback" } })
  fireEvent.change(screen.getByLabelText(en.previews.addressing), { target: { value: "fixed" } })
  fireEvent.click(screen.getByRole("button", { name: en.previews.create }))
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ originMode: "localhost", port: { kind: "fixed", port: 20002 } }),
    { kind: "localOwner" }
  )
})

it("disables expired grants and never renders a bootstrap capability", () => {
  jest.mocked(useSandboxPreviewLinks).mockReturnValue({
    ...jest.mocked(useSandboxPreviewLinks)("p"),
    grants: [
      {
        id: "g",
        origin: "http://p-g.localhost:4000",
        audience: { kind: "localOwner" },
        expiresAt: 1,
        revoked: false,
      } as never,
    ],
    now: 2,
  })
  render(<SandboxPreviewLinksPanel projectId="p" targets={[target]} />)
  expect(screen.getByRole("button", { name: en.previews.open })).toBeDisabled()
  expect(screen.getByText(en.previews.expired)).toBeInTheDocument()
  expect(screen.queryByRole("link")).not.toBeInTheDocument()
})
