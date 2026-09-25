/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }))
let mockReachable = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: () => mockReachable }))
jest.mock("@/lib/platform/web-companion", () => ({ hasWebCompanionTarget: () => mockReachable }))
const deleteRemoteBrowserProfile = jest.fn()
jest.mock("@/lib/browser/remote-profiles", () => {
  class RemoteProfileDeleteError extends Error {
    constructor(readonly reason: string) {
      super(reason)
    }
  }
  return {
    RemoteProfileDeleteError,
    deleteRemoteBrowserProfile: (...args: unknown[]) => deleteRemoteBrowserProfile(...args),
  }
})

const save = jest.fn().mockResolvedValue(undefined)
let enabled = false
const createBrowserProfile = jest.fn().mockResolvedValue({ id: "profile-2" })
const selectBrowserProfile = jest.fn().mockResolvedValue(undefined)
const grantBrowserDomain = jest.fn().mockResolvedValue(undefined)
const revokeBrowserDomain = jest.fn().mockResolvedValue(undefined)
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => unknown) => query(),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ activeProjectId: "workspace-1" }),
}))
jest.mock("@/lib/db/browser-profiles", () => ({
  createBrowserProfile: (...args: unknown[]) => createBrowserProfile(...args),
  selectBrowserProfile: (...args: unknown[]) => selectBrowserProfile(...args),
  grantBrowserDomain: (...args: unknown[]) => grantBrowserDomain(...args),
  revokeBrowserDomain: (...args: unknown[]) => revokeBrowserDomain(...args),
  listBrowserProfiles: () => [{ id: "profile-1", name: "QA", selected: true }],
  listBrowserDomainGrants: () => [{ id: "workspace-1\u0000example.com", domain: "example.com" }],
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { remoteBrowserEnabled: enabled }, save }),
}))

import { toast } from "sonner"
import { RemoteProfileDeleteError } from "@/lib/browser/remote-profiles"
import { RemoteBrowserCard } from "./remote-browser-card"

beforeEach(() => {
  enabled = false
  mockReachable = true
  deleteRemoteBrowserProfile.mockReset().mockResolvedValue(undefined)
  ;(toast.success as jest.Mock).mockClear()
  save.mockClear()
  createBrowserProfile.mockClear()
  selectBrowserProfile.mockClear()
  grantBrowserDomain.mockClear()
  revokeBrowserDomain.mockClear()
})

it("keeps the remote browser experiment disabled by default", () => {
  render(<RemoteBrowserCard />)
  expect(screen.getByTestId("remote-browser-toggle")).not.toBeChecked()
})

it("persists explicit user opt-in", async () => {
  render(<RemoteBrowserCard />)
  fireEvent.click(screen.getByTestId("remote-browser-toggle"))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ remoteBrowserEnabled: true }))
})

it("reflects an enabled preference", () => {
  enabled = true
  render(<RemoteBrowserCard />)
  expect(screen.getByTestId("remote-browser-toggle")).toBeChecked()
})

it("creates and selects a persistent profile only after explicit input", async () => {
  enabled = true
  render(<RemoteBrowserCard />)
  fireEvent.change(screen.getByLabelText("mobile.companion.remoteBrowser.profiles.name"), {
    target: { value: "SaaS QA" },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "mobile.companion.remoteBrowser.profiles.create" })
  )
  await waitFor(() => expect(createBrowserProfile).toHaveBeenCalledWith("workspace-1", "SaaS QA"))
  expect(selectBrowserProfile).toHaveBeenCalledWith("workspace-1", "profile-2")
})

it("grants and revokes exact public domains", async () => {
  enabled = true
  render(<RemoteBrowserCard />)
  fireEvent.change(screen.getByLabelText("mobile.companion.remoteBrowser.domains.domain"), {
    target: { value: "app.example.com" },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "mobile.companion.remoteBrowser.domains.grant" })
  )
  await waitFor(() =>
    expect(grantBrowserDomain).toHaveBeenCalledWith("workspace-1", "app.example.com")
  )
  fireEvent.click(
    screen.getByRole("button", {
      name: "mobile.companion.remoteBrowser.domains.revoke",
    })
  )
  expect(revokeBrowserDomain).toHaveBeenCalledWith("workspace-1", "example.com")
})

describe("profiles", () => {
  const deleteButton = () =>
    screen.getByRole("button", { name: "mobile.companion.remoteBrowser.profiles.delete" })
  const confirm = () =>
    screen.getByRole("button", { name: "mobile.companion.remoteBrowser.profiles.deleteConfirm" })

  it("marks which profile new sessions use", () => {
    enabled = true
    render(<RemoteBrowserCard />)
    expect(screen.getByRole("button", { name: "QA" })).toHaveAttribute("aria-pressed", "true")
    expect(
      screen.getByRole("button", { name: "mobile.companion.remoteBrowser.profiles.ephemeral" })
    ).toHaveAttribute("aria-pressed", "false")
  })

  // The profile's data is a directory on the runtime. The row alone used to be
  // the only thing "deleting" could touch, leaving that directory orphaned.
  it("erases a profile's cloud data after confirmation", async () => {
    enabled = true
    render(<RemoteBrowserCard />)
    fireEvent.click(deleteButton())
    expect(deleteRemoteBrowserProfile).not.toHaveBeenCalled()
    fireEvent.click(confirm())
    await waitFor(() =>
      expect(deleteRemoteBrowserProfile).toHaveBeenCalledWith("workspace-1", "profile-1")
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("explains a refusal while the profile is open", async () => {
    enabled = true
    deleteRemoteBrowserProfile.mockRejectedValue(new RemoteProfileDeleteError("in-use", null))
    render(<RemoteBrowserCard />)
    fireEvent.click(deleteButton())
    fireEvent.click(confirm())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "mobile.companion.remoteBrowser.error"
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("cannot erase anything with no server connected", () => {
    enabled = true
    mockReachable = false
    render(<RemoteBrowserCard />)
    expect(deleteButton()).toBeDisabled()
    expect(deleteButton()).toHaveAttribute(
      "title",
      "mobile.companion.remoteBrowser.profiles.deleteUnreachable"
    )
  })
})
