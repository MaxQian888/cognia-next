/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const listMock = jest.fn(async () => [{ path: "/trusted/a", trustedAt: 1700000000000 }])
const revokeMock = jest.fn(async () => undefined)
jest.mock("@/lib/db/trusted-workspaces", () => ({
  listTrustedWorkspaces: () => listMock(),
  revokeWorkspaceTrust: (...a: unknown[]) => revokeMock(...(a as [])),
}))

const saveMock = jest.fn(async () => undefined)
let mockSettings: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save: saveMock }),
}))

import { WorkspaceTrustSection } from "./workspace-trust-section"

beforeEach(() => {
  saveMock.mockClear()
  listMock.mockClear()
  revokeMock.mockClear()
  mockSettings = { workspaceTrust: { enabled: true, promptOnSwitch: false } }
})

it("toggles the enabled setting", () => {
  render(<WorkspaceTrustSection />)
  fireEvent.click(screen.getByLabelText("enabledLabel"))
  expect(saveMock).toHaveBeenCalledWith({
    workspaceTrust: { enabled: false, promptOnSwitch: false },
  })
})

it("toggles promptOnSwitch", () => {
  render(<WorkspaceTrustSection />)
  fireEvent.click(screen.getByLabelText("promptOnSwitchLabel"))
  expect(saveMock).toHaveBeenCalledWith({
    workspaceTrust: { enabled: true, promptOnSwitch: true },
  })
})

it("lists trusted folders and revokes one", async () => {
  render(<WorkspaceTrustSection />)
  await waitFor(() => expect(screen.getByText("/trusted/a")).toBeInTheDocument())
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "revoke" }))
  })
  expect(revokeMock).toHaveBeenCalledWith("/trusted/a")
})

it("defaults enabled to true when unset", () => {
  mockSettings = {}
  render(<WorkspaceTrustSection />)
  // The enabled switch reflects the default-on state.
  expect(screen.getByLabelText("enabledLabel")).toBeChecked()
})
