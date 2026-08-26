import { render, screen } from "@testing-library/react"
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
  jest.spyOn(window, "confirm").mockReturnValue(true)
  render(<AdapterPermissions adapterId="a" />)

  expect(screen.queryByTestId("adapter-media-policy-warning")).not.toBeInTheDocument()
  await user.click(screen.getByTestId("adapter-media-policy"))
  await user.click(screen.getByRole("option", { name: "mediaPolicyCloud" }))

  // Bot-wide, unscoped and non-expiring — the warning is the honest part.
  expect(screen.getByTestId("adapter-media-policy-warning")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "save" }))
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
