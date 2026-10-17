import { fireEvent, render, screen } from "@testing-library/react"
import { SharedSandboxPreviewsPanel } from "./shared-sandbox-previews-panel"
import { useSharedSandboxPreviews } from "@/hooks/sandbox/use-shared-sandbox-previews"
import en from "@/i18n/messages/en/sandboxManagement.json"
import type { RemoteHostEndpoint } from "@/lib/tauri/transport-routing"

jest.mock("@/hooks/sandbox/use-shared-sandbox-previews", () => ({
  useSharedSandboxPreviews: jest.fn(),
}))
const hook = jest.mocked(useSharedSandboxPreviews)
const endpoint = { baseUrl: "https://host" } as RemoteHostEndpoint
const state = (overrides: Partial<ReturnType<typeof useSharedSandboxPreviews>> = {}) => ({
  previews: [],
  loading: false,
  busy: false,
  error: null,
  opened: {},
  checkedAt: Date.now(),
  refresh: jest.fn(),
  open: jest.fn(),
  close: jest.fn(),
  ...overrides,
})
const renderPanel = () => render(<SharedSandboxPreviewsPanel endpoint={endpoint} projectId="p" />)

it("shows an empty state when nothing is shared with this device", () => {
  hook.mockReturnValue(state())
  renderPanel()
  expect(screen.getByText(en.shared.title)).toBeInTheDocument()
  expect(screen.getByText(en.shared.empty)).toBeInTheDocument()
  expect(hook).toHaveBeenCalledWith(endpoint, "p")
})

it("opens and closes a shared grant", () => {
  const value = state({
    previews: [
      {
        id: "a",
        projectId: "p",
        workspaceId: "w",
        resolvedPort: 3000,
        expiresAt: Date.now() + 120_000,
        relayPath: "/api/sandbox/previews/a/",
      },
    ],
    opened: { a: "http://127.0.0.1:5/" },
  })
  hook.mockReturnValue(value)
  renderPanel()
  fireEvent.click(screen.getByRole("button", { name: en.shared.open }))
  expect(value.open).toHaveBeenCalledWith("a")
  fireEvent.click(screen.getByRole("button", { name: en.shared.close }))
  expect(value.close).toHaveBeenCalledWith("a")
  expect(screen.getByText("http://127.0.0.1:5/")).toBeInTheDocument()
})

it("explains a withdrawn control grant", () => {
  hook.mockReturnValue(state({ error: "forbidden" }))
  renderPanel()
  expect(screen.getByRole("alert")).toHaveTextContent(en.shared.errors.forbidden)
})
