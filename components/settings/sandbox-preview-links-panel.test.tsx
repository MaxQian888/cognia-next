import { fireEvent, render, screen } from "@testing-library/react"
import { SandboxPreviewLinksPanel } from "./sandbox-preview-links-panel"
import { useSandboxPreviewLinks } from "@/hooks/sandbox/use-sandbox-preview-links"
import type { SandboxPreviewTarget } from "@/lib/sandbox/previews"
import en from "@/i18n/messages/en/sandboxManagement.json"
import zh from "@/i18n/messages/zh-CN/sandboxManagement.json"

jest.mock("@/hooks/sandbox/use-sandbox-preview-links", () => ({
  useSandboxPreviewLinks: jest.fn(),
}))
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
  expect(create).toHaveBeenCalledWith({
    workspaceId: "w",
    provider: "local",
    containerId: "c",
    expiresInSeconds: 900,
    originMode: "localhost",
    port: { kind: "workspace-lease-offset", offset: 2 },
  })
  const choices = screen.getByRole("combobox", { name: en.previews.expiry }) as HTMLSelectElement
  expect([...choices.options].map((option) => Number(option.value))).toEqual([300, 900, 1800, 3600])
})

it("labels paired devices as inert and renders no paired-device action", () => {
  render(<SandboxPreviewLinksPanel projectId="p" targets={[target]} />)
  expect(screen.getByText(en.previews.pairedPhase2)).toHaveAttribute(
    "data-dormant",
    "paired-device-preview"
  )
  expect(screen.getByRole("combobox", { name: en.previews.audience })).toBeDisabled()
  expect(zh.previews.pairedPhase2).toContain("第 2 阶段")
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
    expect.objectContaining({ originMode: "localhost", port: { kind: "fixed", port: 20002 } })
  )
})

it("disables expired grants and never renders a bootstrap capability", () => {
  jest.mocked(useSandboxPreviewLinks).mockReturnValue({
    ...jest.mocked(useSandboxPreviewLinks)("p"),
    grants: [
      { id: "g", origin: "http://p-g.localhost:4000", expiresAt: 1, revoked: false } as never,
    ],
    now: 2,
  })
  render(<SandboxPreviewLinksPanel projectId="p" targets={[target]} />)
  expect(screen.getByRole("button", { name: en.previews.open })).toBeDisabled()
  expect(screen.getByText(en.previews.expired)).toBeInTheDocument()
  expect(screen.queryByRole("link")).not.toBeInTheDocument()
})
