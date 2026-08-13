import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AdapterBehaviorDefaults } from "./adapter-behavior-defaults"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const mockAdapterRow = { id: "a", defaultMode: "auto", activationTtlMs: 3_600_000 }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockAdapterRow,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
const mockUpdateAdapterConfigSection = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterConfigSection: (...args: unknown[]) => mockUpdateAdapterConfigSection(...args),
}))

it("reuses the shared behavior editor in Adapter scope", () => {
  render(<AdapterBehaviorDefaults adapterId="a" />)
  expect(screen.getByTestId("conversation-behavior-editor")).toBeInTheDocument()
  expect(screen.getByTestId("behavior-ttl")).toHaveValue(1)
})

it("edits defaultMode through the shared behavior section", async () => {
  const user = userEvent.setup()
  render(<AdapterBehaviorDefaults adapterId="a" />)

  await user.click(screen.getByTestId("behavior-mode"))
  await user.click(screen.getByRole("option", { name: "modeDraft" }))
  await user.click(screen.getByRole("button", { name: "save" }))

  expect(mockUpdateAdapterConfigSection).toHaveBeenCalledWith(
    "a",
    "behavior",
    expect.objectContaining({ defaultMode: "draft" }),
    "settings.adapter.behavior"
  )
})
