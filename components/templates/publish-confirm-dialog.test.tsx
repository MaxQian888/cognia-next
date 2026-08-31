/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { PublishConfirmDialog } from "./publish-confirm-dialog"

const messages = {
  templateStudio: {
    publishDialog: {
      title: "Publish this template",
      description: "Currently {current}. This release will be {next}.",
      unreleased: "unreleased",
      noReasons: "No differences that change the version.",
      cancel: "Cancel",
      confirm: "Publish {version}",
      bump: { major: "Major", minor: "Minor", patch: "Patch" },
    },
  },
}

function renderDialog(suggestion: Parameters<typeof PublishConfirmDialog>[0]["suggestion"]) {
  const onConfirm = jest.fn()
  const onOpenChange = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <PublishConfirmDialog
        suggestion={suggestion}
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />
    </NextIntlClientProvider>
  )
  return { onConfirm, onOpenChange }
}

describe("PublishConfirmDialog", () => {
  it("stays shut until a suggestion is fetched", () => {
    renderDialog(null)
    expect(screen.queryByTestId("template-publish-dialog")).toBeNull()
  })

  /**
   * `service.publish` returns the reasons behind its conservative suggestion
   * precisely so a human sees why a change is major before it becomes major.
   * The Studio used to hand the suggestion straight back as the confirmation,
   * which satisfied the check without ever showing a version or a reason.
   */
  it("shows the version it is about to cut and why", () => {
    renderDialog({
      bump: "major",
      reasons: ["An existing input was removed"],
      currentVersion: "1.2.0",
      nextVersion: "2.0.0",
    })
    // The global next-intl mock resolves against the real en.json, so this
    // matches the shipped copy rather than the inline fixture.
    expect(screen.getByText(/^Major/)).toBeInTheDocument()
    expect(screen.getByTestId("template-publish-reasons")).toHaveTextContent(
      "An existing input was removed"
    )
    expect(screen.getByTestId("template-publish-confirm")).toHaveTextContent("2.0.0")
  })

  it("says so when there is no prior release", () => {
    renderDialog({
      bump: "minor",
      reasons: ["Initial release"],
      currentVersion: null,
      nextVersion: "0.1.0",
    })
    expect(screen.getByText(/unreleased/)).toBeInTheDocument()
  })

  it("confirms with the bump the service will accept", () => {
    const { onConfirm } = renderDialog({
      bump: "patch",
      reasons: [],
      currentVersion: "1.0.0",
      nextVersion: "1.0.1",
    })
    fireEvent.click(screen.getByTestId("template-publish-confirm"))
    expect(onConfirm).toHaveBeenCalledWith("patch")
  })
})
