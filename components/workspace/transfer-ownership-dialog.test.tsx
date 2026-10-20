/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace}.${key}${values ? `:${Object.values(values).join(",")}` : ""}`,
}))

import { TransferOwnershipDialog } from "./transfer-ownership-dialog"

const target = { userId: "usr_cleo", name: "Cleo" }

describe("TransferOwnershipDialog", () => {
  it("is closed without a target", () => {
    render(
      <TransferOwnershipDialog
        target={null}
        busy={false}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />
    )
    expect(screen.queryByTestId("workspace-transfer-ownership")).not.toBeInTheDocument()
  })

  it("names the new owner and confirms with the admin step-down by default", () => {
    const onConfirm = jest.fn()
    render(
      <TransferOwnershipDialog
        target={target}
        busy={false}
        onCancel={jest.fn()}
        onConfirm={onConfirm}
      />
    )
    expect(screen.getByTestId("workspace-transfer-ownership")).toHaveTextContent(
      "workspace.members.transfer.title:Cleo"
    )
    fireEvent.click(screen.getByTestId("workspace-transfer-confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ toUserId: "usr_cleo", previousOwnerRole: "admin" })
  })

  it("lets the outgoing owner step down to plain member", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    render(
      <TransferOwnershipDialog
        target={target}
        busy={false}
        onCancel={jest.fn()}
        onConfirm={onConfirm}
      />
    )
    await user.click(screen.getByTestId("workspace-transfer-step-down"))
    await user.click(
      await screen.findByRole("option", { name: "workspace.members.orgRole.member" })
    )
    fireEvent.click(screen.getByTestId("workspace-transfer-confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ toUserId: "usr_cleo", previousOwnerRole: "member" })
  })

  it("never offers owner as the step-down role, and blocks confirm while busy", async () => {
    const user = userEvent.setup()
    render(
      <TransferOwnershipDialog target={target} busy onCancel={jest.fn()} onConfirm={jest.fn()} />
    )
    expect(screen.getByTestId("workspace-transfer-confirm")).toBeDisabled()
    await user.click(screen.getByTestId("workspace-transfer-step-down"))
    expect(screen.queryByRole("option", { name: "workspace.members.orgRole.owner" })).toBeNull()
  })

  it("reports a cancel", async () => {
    const onCancel = jest.fn()
    render(
      <TransferOwnershipDialog
        target={target}
        busy={false}
        onCancel={onCancel}
        onConfirm={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("common.cancel"))
    expect(onCancel).toHaveBeenCalled()
  })
})
