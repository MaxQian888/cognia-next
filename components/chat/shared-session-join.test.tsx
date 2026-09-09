import { fireEvent, render, screen, waitFor } from "@testing-library/react"
const mockResolve = jest.fn()
const mockAccept = jest.fn()
const mockSync = jest.fn()
const mockActivate = jest.fn()
const mockWorkspace = jest.fn()
const mockError = jest.fn()
const mockNavigate = jest.fn()
jest.mock("@/components/shell/use-shell-nav", () => ({
  useShellNav: () => ({ switchToDm: mockNavigate }),
}))
let mockEnabled = true
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockError(...args), success: jest.fn() },
}))
jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: () => mockResolve(),
}))
jest.mock("@/lib/collab/shared-chat-sync", () => ({
  syncSharedSession: (...args: unknown[]) => mockSync(...args),
}))
jest.mock("@/lib/collab/shared-chat-feature", () => ({
  // The component reads the gate through `useSharedChatEnabled`, which needs
  // all three: the build answer for its first paint, the resolved answer after
  // mount, and a subscription so the settings switch reaches an open surface.
  isSharedChatBuildEnabled: () => mockEnabled,
  isSharedChatClientEnabled: () => mockEnabled,
  subscribeSharedChatPreference: () => () => {},
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setActiveSession: mockActivate }) },
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ setActiveProject: mockWorkspace }) },
}))
import { SharedSessionJoin } from "./shared-session-join"

beforeEach(() => {
  jest.clearAllMocks()
  mockEnabled = true
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  mockResolve.mockResolvedValue({ orgId: "org", client: { acceptSessionInvite: mockAccept } })
  mockAccept.mockResolvedValue({ invite: { sessionId: "shared" } })
  mockSync.mockResolvedValue({ localSessionId: "local", session: { workspaceId: "workspace" } })
})
function fillInvite() {
  fireEvent.click(screen.getByRole("button", { name: "acceptInvite" }))
  fireEvent.change(screen.getByLabelText("inviteToken"), { target: { value: " token " } })
  fireEvent.click(screen.getAllByRole("button", { name: "acceptInvite" }).at(-1)!)
}
it("accepts an invitation without an existing session and opens the discovered conversation", async () => {
  render(<SharedSessionJoin />)
  fillInvite()
  await waitFor(() => expect(mockActivate).toHaveBeenCalledWith("local"))
  expect(mockAccept).toHaveBeenCalledWith("org", "token")
  expect(mockWorkspace).toHaveBeenCalledWith("workspace")
  expect(mockNavigate).toHaveBeenCalled()
})
it("retains input on expired or rejected invitations", async () => {
  mockAccept.mockRejectedValue(new Error("expired"))
  render(<SharedSessionJoin />)
  fillInvite()
  await waitFor(() => expect(mockError).toHaveBeenCalledWith("inviteAcceptFailed"))
  expect(screen.getByLabelText("inviteToken")).toHaveValue(" token ")
  expect(mockActivate).not.toHaveBeenCalled()
})
it("does not silently queue an offline invitation", async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
  render(<SharedSessionJoin />)
  fillInvite()
  await waitFor(() => expect(mockError).toHaveBeenCalledWith("offlineConversion"))
  expect(mockAccept).not.toHaveBeenCalled()
})
it("explains missing configuration", async () => {
  mockResolve.mockResolvedValue(null)
  render(<SharedSessionJoin />)
  fillInvite()
  await waitFor(() => expect(mockError).toHaveBeenCalledWith("notConfigured"))
})
it("hides entry when collaboration is disabled", () => {
  mockEnabled = false
  const { container } = render(<SharedSessionJoin />)
  expect(container).toBeEmptyDOMElement()
})
