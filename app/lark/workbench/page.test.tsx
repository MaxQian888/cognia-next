/** @jest-environment jsdom */
import { StrictMode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import LarkWorkbenchPage from "./page"
import {
  checkLarkPersonalHost,
  loadLarkTeamWorkspaces,
  resolveLarkWorkbench,
} from "@/lib/connectors/lark-web/intent-client"
import { refreshCollabPlane } from "@/lib/collab/refresh"

const mockPush = jest.fn()
const mockSetActive = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock("next-intl", () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, { has: (key: string) => !key.includes("unknown") }),
}))
jest.mock("@/lib/connectors/lark-web/intent-client", () => ({
  resolveLarkWorkbench: jest.fn(),
  checkLarkPersonalHost: jest.fn(),
  loadLarkTeamWorkspaces: jest.fn(),
}))
jest.mock("@/lib/collab/refresh", () => ({ refreshCollabPlane: jest.fn() }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ setActiveProject: mockSetActive }) },
}))
jest.mock("@/components/workspace/workspace-picker-list", () => ({
  WorkspacePickerList: ({
    selection,
  }: {
    selection: { items: Array<{ id: string; name: string }>; onSelect(id: string): void }
  }) => (
    <div>
      {selection.items.map((item) => (
        <button key={item.id} onClick={() => selection.onSelect(item.id)}>
          {item.name}
        </button>
      ))}
    </div>
  ),
}))
jest.mock("@/components/workspace/workspace-members", () => ({
  WorkspaceMembers: ({ workspaceId }: { workspaceId: string }) => <div>members:{workspaceId}</div>,
}))
jest.mock("@/components/workspace/workspace-activity", () => ({
  WorkspaceActivity: ({ workspaceId }: { workspaceId: string }) => (
    <div>activity:{workspaceId}</div>
  ),
}))
const resolve = jest.mocked(resolveLarkWorkbench)
const personal = jest.mocked(checkLarkPersonalHost)
const team = jest.mocked(loadLarkTeamWorkspaces)
const refresh = jest.mocked(refreshCollabPlane)
const context = { mode: "both" as const, userId: "user", accountId: "profile", serverId: "host" }
const ready = { kind: "ready" as const, context }

beforeEach(() => {
  jest.clearAllMocks()
  resolve.mockReset().mockResolvedValue(ready)
  personal.mockReset().mockResolvedValue(null)
  team.mockReset().mockResolvedValue({ kind: "ready", items: [{ id: "team-1", name: "Design" }] })
  refresh.mockReset().mockResolvedValue({
    status: "refreshed",
    orgId: "org",
    userId: "user",
    issues: 0,
    workspaces: 1,
    members: 1,
    orgMember: true,
    plans: 0,
    runs: 0,
  })
  window.history.replaceState(null, "", "/lark/workbench?adapter_id=bot")
})

it("deduplicates StrictMode launch and reuses the personal console after host verification", async () => {
  render(
    <StrictMode>
      <LarkWorkbenchPage />
    </StrictMode>
  )
  fireEvent.click(await screen.findByRole("button", { name: "personal" }))
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/"))
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(personal).toHaveBeenCalledWith(context)
  expect(mockSetActive).not.toHaveBeenCalled()
})

it.each(["host_required", "host_mismatch"] as const)(
  "blocks personal navigation on %s",
  async (code) => {
    personal.mockResolvedValue(code)
    render(<LarkWorkbenchPage />)
    fireEvent.click(await screen.findByRole("button", { name: "personal" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(`errors.${code}`)
    expect(mockPush).not.toHaveBeenCalled()
  }
)

it("renders shared team panels without navigating to local chat; rechecks before opening issues", async () => {
  render(<LarkWorkbenchPage />)
  fireEvent.click(await screen.findByRole("button", { name: "team" }))
  fireEvent.click(await screen.findByRole("button", { name: "Design" }))
  expect(await screen.findByText("members:team-1")).toBeInTheDocument()
  expect(screen.getByText("activity:team-1")).toBeInTheDocument()
  expect(mockPush).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "issues" }))
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/issues"))
  expect(mockSetActive).toHaveBeenCalledWith("team-1")
  expect(team).toHaveBeenCalledTimes(3)
  expect(refresh).toHaveBeenCalledTimes(2)
})

it("rejects a workspace revoked after the list was displayed", async () => {
  render(<LarkWorkbenchPage />)
  fireEvent.click(await screen.findByRole("button", { name: "team" }))
  await screen.findByRole("button", { name: "Design" })
  team.mockResolvedValue({ kind: "ready", items: [] })
  fireEvent.click(screen.getByRole("button", { name: "Design" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.forbidden")
  expect(mockSetActive).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
})

it.each(["personal", "team"] as const)("shows only configured %s entry", async (mode) => {
  resolve.mockResolvedValue({ kind: "ready", context: { ...context, mode } })
  render(<LarkWorkbenchPage />)
  expect(await screen.findByRole("button", { name: mode })).toBeInTheDocument()
  expect(
    screen.queryByRole("button", { name: mode === "personal" ? "team" : "personal" })
  ).not.toBeInTheDocument()
})

it("handles failed launch and retries without retaining the failed result", async () => {
  resolve.mockRejectedValueOnce(new Error("offline"))
  render(<LarkWorkbenchPage />)
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.workbench_unavailable")
  fireEvent.click(screen.getByRole("button", { name: "retry" }))
  expect(await screen.findByRole("button", { name: "personal" })).toBeInTheDocument()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

it("fails closed when the principal changes while the page is open", async () => {
  render(<LarkWorkbenchPage />)
  await screen.findByRole("button", { name: "personal" })
  resolve.mockResolvedValue({ kind: "ready", context: { ...context, userId: "other" } })
  fireEvent.click(screen.getByRole("button", { name: "personal" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.identity_mismatch")
  expect(personal).not.toHaveBeenCalled()
})

it("hides entry controls if policy is revoked during an action", async () => {
  render(<LarkWorkbenchPage />)
  await screen.findByRole("button", { name: "personal" })
  resolve.mockResolvedValue({ kind: "error", code: "workbench_disabled" })
  fireEvent.click(screen.getByRole("button", { name: "personal" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.workbench_disabled")
  expect(screen.queryByRole("button", { name: "personal" })).not.toBeInTheDocument()
})

it("does not render stale team panels when collaboration refresh fails", async () => {
  render(<LarkWorkbenchPage />)
  fireEvent.click(await screen.findByRole("button", { name: "team" }))
  refresh.mockRejectedValue(new Error("offline"))
  fireEvent.click(await screen.findByRole("button", { name: "Design" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.workbench_unavailable")
  expect(screen.queryByText("members:team-1")).not.toBeInTheDocument()
})

it("requires a refreshed matching team identity before showing shared data", async () => {
  render(<LarkWorkbenchPage />)
  fireEvent.click(await screen.findByRole("button", { name: "team" }))
  refresh.mockResolvedValue({ status: "skipped", reason: "not-signed-in" })
  fireEvent.click(await screen.findByRole("button", { name: "Design" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.team_unavailable")
  expect(screen.queryByText("members:team-1")).not.toBeInTheDocument()
})

it("clears the team list when server authorization fails", async () => {
  render(<LarkWorkbenchPage />)
  fireEvent.click(await screen.findByRole("button", { name: "team" }))
  await screen.findByRole("button", { name: "Design" })
  team.mockResolvedValue({ kind: "error", code: "team_sign_in_required" })
  fireEvent.click(screen.getByRole("button", { name: "team" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.team_sign_in_required")
  expect(screen.queryByRole("button", { name: "Design" })).not.toBeInTheDocument()
})

it("maps an unrecognized backend error to the translated fallback", async () => {
  resolve.mockResolvedValue({ kind: "error", code: "unknown" })
  render(<LarkWorkbenchPage />)
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.workbench_unavailable")
})

it.each([false, true])(
  "handles SSO login at launch or on revalidation (action=%s)",
  async (action) => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      if (!action)
        resolve.mockResolvedValue({ kind: "login", loginUrl: "https://api.example/login" })
      render(<LarkWorkbenchPage />)
      if (action) {
        await screen.findByRole("button", { name: "personal" })
        resolve.mockResolvedValue({ kind: "login", loginUrl: "https://api.example/login" })
        fireEvent.click(screen.getByRole("button", { name: "personal" }))
      }
      expect(await screen.findByText("login")).toBeInTheDocument()
      expect(mockPush).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  }
)

it("ignores a host verification that finishes after unmount", async () => {
  let finish!: (value: null) => void
  personal.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const view = render(<LarkWorkbenchPage />)
  fireEvent.click(await screen.findByRole("button", { name: "personal" }))
  await waitFor(() => expect(personal).toHaveBeenCalled())
  view.unmount()
  finish(null)
  await Promise.resolve()
  expect(mockPush).not.toHaveBeenCalled()
})
