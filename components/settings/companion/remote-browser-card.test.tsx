/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

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

import { RemoteBrowserCard } from "./remote-browser-card"

beforeEach(() => {
  enabled = false
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
