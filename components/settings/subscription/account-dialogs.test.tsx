/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { AccountSummary } from "@/types/subscription"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const inspectReferencesMock = jest.fn()
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  inspectProviderAccountReferences: (...args: unknown[]) => inspectReferencesMock(...args),
}))

import { RemoveDialog, RenameDialog } from "./account-dialogs"

function summary(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "a1",
    provider: "opencode",
    variant: "opencode-zen",
    expiresAtMs: 0,
    createdAtMs: 0,
    lastUsedAtMs: 0,
    authMode: "api_key",
    credentialSource: "managed",
    health: "ready",
    isExternal: false,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  inspectReferencesMock.mockResolvedValue({
    sessions: [],
    characters: [],
    isDefault: false,
    isActive: false,
  })
})

it("renames and supports clearing a custom label", async () => {
  const onSubmit = jest.fn(async () => undefined)
  const user = userEvent.setup()
  render(
    <RenameDialog account={summary({ label: "Work" })} onClose={() => {}} onSubmit={onSubmit} />
  )

  await user.clear(screen.getByLabelText("renameLabel"))
  await user.click(screen.getByText("confirm"))

  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(null))
})

it("previews references and migrates them to an explicit replacement", async () => {
  inspectReferencesMock.mockResolvedValue({
    sessions: [{ id: "s1", title: "Chat" }],
    characters: [{ id: "c1", name: "Assistant" }],
    isDefault: true,
    isActive: true,
  })
  const onConfirm = jest.fn(async () => undefined)
  const user = userEvent.setup()
  render(
    <RemoveDialog
      provider="opencode"
      account={summary({ id: "a1", label: "Old" })}
      accounts={[summary({ id: "a1" }), summary({ id: "a2", label: "New" })]}
      onClose={() => {}}
      onConfirm={onConfirm}
    />
  )

  expect(await screen.findByText("referenceSummary")).toBeInTheDocument()
  expect(screen.getByText("activeReference")).toBeInTheDocument()
  expect(screen.getByText("defaultReference")).toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText("replacementLabel"), "a2")
  await user.click(screen.getByText("removeConfirm"))

  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("a2"))
})

it("explains that unlinking an external OpenCode credential is local only", async () => {
  const user = userEvent.setup()
  const onConfirm = jest.fn(async () => undefined)
  render(
    <RemoveDialog
      provider="opencode"
      account={summary({ variant: "opencode-discovered", isExternal: true })}
      accounts={[summary({ variant: "opencode-discovered", isExternal: true })]}
      onClose={() => {}}
      onConfirm={onConfirm}
    />
  )

  expect(screen.getByText("unlinkDialogBody")).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText("unlinkConfirm")).toBeEnabled())
  await user.click(screen.getByText("unlinkConfirm"))
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(null))
})
