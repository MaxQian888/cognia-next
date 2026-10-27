/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SharedSession } from "@cognia/agent-config-types"

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { toast } from "sonner"
import { SharedToolDetailSetting } from "./shared-tool-detail-setting"

const session = {
  id: "ses",
  orgId: "org",
  workspaceId: "w",
  title: "t",
  status: "active",
  createdBy: { kind: "human", id: "u" },
  createdAt: 1,
  updatedAt: 1,
  revision: 3,
  policyRevision: 2,
} as SharedSession

function setup(overrides: Partial<{ session: SharedSession; canChange: boolean }> = {}) {
  const updateSharedSession = jest.fn(
    async (_org: string, _id: string, input: { toolDetail?: string }) => ({
      ...session,
      toolDetail: input.toolDetail,
    })
  ) as jest.Mock
  const onChanged = jest.fn()
  render(
    <SharedToolDetailSetting
      client={{ updateSharedSession }}
      orgId="org"
      session={overrides.session ?? session}
      canChange={overrides.canChange ?? true}
      onChanged={onChanged}
    />
  )
  return { updateSharedSession, onChanged }
}

it("defaults to the summary tier on a server that names none", () => {
  setup()
  expect(screen.getByRole("switch")).not.toBeChecked()
})

it("asks before showing members commands and edits, then saves the full tier", async () => {
  const { updateSharedSession, onChanged } = setup()
  await userEvent.click(screen.getByRole("switch"))
  expect(updateSharedSession).not.toHaveBeenCalled()
  expect(screen.getByText("toolDetailConfirmWarning")).toBeInTheDocument()
  await userEvent.click(screen.getByText("toolDetailConfirm"))
  await waitFor(() =>
    expect(updateSharedSession).toHaveBeenCalledWith("org", "ses", {
      toolDetail: "full",
      operationId: "tool-detail:ses:3:full",
      baseRevision: 3,
    })
  )
  expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ toolDetail: "full" }))
})

it("does nothing when the warning is cancelled", async () => {
  const { updateSharedSession } = setup()
  await userEvent.click(screen.getByRole("switch"))
  await userEvent.click(screen.getByText("toolDetailCancel"))
  expect(updateSharedSession).not.toHaveBeenCalled()
})

it("turns the full tier off without asking", async () => {
  const { updateSharedSession } = setup({ session: { ...session, toolDetail: "full" } })
  expect(screen.getByRole("switch")).toBeChecked()
  await userEvent.click(screen.getByRole("switch"))
  await waitFor(() =>
    expect(updateSharedSession).toHaveBeenCalledWith(
      "org",
      "ses",
      expect.objectContaining({ toolDetail: "summary" })
    )
  )
})

it("is read-only for a member who may not change settings", () => {
  setup({ canChange: false })
  expect(screen.getByRole("switch")).toBeDisabled()
  expect(screen.getByText("toolDetailReadOnly")).toBeInTheDocument()
})

it("says so when the server refuses the change", async () => {
  const { updateSharedSession, onChanged } = setup({ session: { ...session, toolDetail: "full" } })
  updateSharedSession.mockRejectedValueOnce(new Error("403"))
  await userEvent.click(screen.getByRole("switch"))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("toolDetailFailed"))
  expect(onChanged).not.toHaveBeenCalled()
})
