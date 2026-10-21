import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AdapterPermissions } from "./adapter-permissions"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const mockRow: { current: Record<string, unknown> | undefined } = { current: undefined }
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockRow.current }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
const mockUpdate = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterConfigSection: (...args: unknown[]) => mockUpdate(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockRow.current = undefined
})

it("keeps Skills, Host Capabilities, and HITL as distinct permission groups", () => {
  render(<AdapterPermissions adapterId="a" />)
  expect(screen.getByText("builtInSkills")).toBeInTheDocument()
  expect(screen.getByText("hostCapabilities")).toBeInTheDocument()
  expect(screen.getByText("hitl")).toBeInTheDocument()
})

/**
 * `mediaModelPolicy` is the base every conversation grant sits on top of, and
 * all eleven create dialogs hard-coded it to `local_extract_only` with no
 * editor anywhere — so `allow_cloud_binary` was unreachable at this scope.
 */
it("defaults to local extraction and can be widened deliberately", async () => {
  const user = userEvent.setup()
  render(<AdapterPermissions adapterId="a" />)

  expect(screen.queryByTestId("adapter-media-policy-warning")).not.toBeInTheDocument()
  await user.click(screen.getByTestId("adapter-media-policy"))
  await user.click(screen.getByRole("option", { name: "mediaPolicyCloud" }))

  // Bot-wide, unscoped and non-expiring — the warning is the honest part.
  expect(screen.getByTestId("adapter-media-policy-warning")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "save" }))
  const dialog = await screen.findByTestId("adapter-permissions-confirm")
  expect(dialog).toHaveTextContent("confirmImpact")
  expect(mockUpdate).not.toHaveBeenCalled()
  await user.click(within(dialog).getByTestId("adapter-permissions-confirm-confirm"))
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
  expect(mockUpdate).toHaveBeenCalledWith(
    "a",
    "permissions",
    expect.objectContaining({ mediaModelPolicy: "allow_cloud_binary" }),
    "settings.adapter.permissions"
  )
})

it("seeds from the stored policy", () => {
  mockRow.current = { id: "a", mediaModelPolicy: "allow_cloud_binary", updatedAt: 1 }
  render(<AdapterPermissions adapterId="a" />)
  expect(screen.getByTestId("adapter-media-policy-warning")).toBeInTheDocument()
})

it("saves nothing when the impact confirmation is cancelled", async () => {
  const user = userEvent.setup()
  render(<AdapterPermissions adapterId="a" />)
  await user.click(screen.getByRole("button", { name: "save" }))
  await user.click(await screen.findByTestId("adapter-permissions-confirm-cancel"))
  await waitFor(() =>
    expect(screen.queryByTestId("adapter-permissions-confirm")).not.toBeInTheDocument()
  )
  expect(mockUpdate).not.toHaveBeenCalled()
})

it("resets the media policy along with the other fields", async () => {
  const user = userEvent.setup()
  render(<AdapterPermissions adapterId="a" />)
  await user.click(screen.getByTestId("adapter-media-policy"))
  await user.click(screen.getByRole("option", { name: "mediaPolicyCloud" }))
  expect(screen.getByTestId("adapter-media-policy-warning")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "cancel" }))
  expect(screen.queryByTestId("adapter-media-policy-warning")).not.toBeInTheDocument()
})
