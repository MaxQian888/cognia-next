/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { PermissionDiffPanel } from "./permission-diff-panel"
import creatorMessages from "@/i18n/messages/en/creator.json"
import { computePermissionDiff } from "@/lib/creator/permission-diff"

function renderPanel(props: Partial<React.ComponentProps<typeof PermissionDiffPanel>> = {}) {
  const onApprove = props.onApprove ?? jest.fn()
  const diff =
    props.diff ?? computePermissionDiff({ current: ["fs.read"], proposed: ["fs.read", "fs.write"] })
  render(
    <NextIntlClientProvider locale="en" messages={{ creator: creatorMessages }}>
      <PermissionDiffPanel
        diff={diff}
        approvedAdditions={props.approvedAdditions ?? []}
        onApprove={onApprove}
        disabled={props.disabled}
      />
    </NextIntlClientProvider>
  )
  return { onApprove, diff }
}

const approveButton = () =>
  screen.getByRole("button", { name: creatorMessages.permissions.approve })

describe("PermissionDiffPanel", () => {
  it("lists every capability with its change kind", () => {
    renderPanel()
    expect(screen.getByText("fs.write")).toBeInTheDocument()
    expect(screen.getByText("fs.read")).toBeInTheDocument()
  })

  it("states that writes are blocked until approval", () => {
    renderPanel()
    expect(screen.getByText(creatorMessages.permissions.writesBlocked)).toBeInTheDocument()
  })

  it("approves exactly the added capabilities, not the whole proposal", () => {
    const { onApprove } = renderPanel()
    fireEvent.click(approveButton())
    expect(onApprove).toHaveBeenCalledWith(["fs.write"])
  })

  it("offers no approval when nothing was added", () => {
    renderPanel({ diff: computePermissionDiff({ current: ["fs.read"], proposed: ["fs.read"] }) })
    expect(
      screen.queryByRole("button", { name: creatorMessages.permissions.approve })
    ).not.toBeInTheDocument()
  })

  it("says so when the artifact asks for nothing at all", () => {
    renderPanel({ diff: computePermissionDiff({ current: [], proposed: [] }) })
    expect(screen.getByText(creatorMessages.permissions.none)).toBeInTheDocument()
  })

  it("marks the diff approved and disables the button once covered", () => {
    renderPanel({ approvedAdditions: ["fs.write"] })
    expect(screen.getByText(creatorMessages.permissions.approved)).toBeInTheDocument()
    expect(approveButton()).toBeDisabled()
  })

  // The smuggling case: a regenerated, wider proposal must not ride in on the
  // earlier approval.
  it("warns that a widened proposal is no longer covered", () => {
    renderPanel({
      diff: computePermissionDiff({ current: [], proposed: ["fs.write", "proc.spawn"] }),
      approvedAdditions: ["fs.write"],
    })
    expect(screen.getByRole("alert")).toHaveTextContent(creatorMessages.permissions.stale)
    expect(approveButton()).toBeEnabled()
  })

  it("does not call it stale when nothing was ever approved", () => {
    renderPanel()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("renders a generator-supplied rationale", () => {
    renderPanel({
      diff: computePermissionDiff({
        current: [],
        proposed: ["net.fetch"],
        rationales: { "net.fetch": "fetches the changelog" },
      }),
    })
    expect(screen.getByText("fetches the changelog")).toBeInTheDocument()
  })

  it("disables approval while no run is active", () => {
    renderPanel({ disabled: true })
    expect(approveButton()).toBeDisabled()
  })
})
