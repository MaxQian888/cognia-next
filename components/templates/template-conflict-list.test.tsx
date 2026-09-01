/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TemplateConflictList, unresolvedPaths } from "./template-conflict-list"

const messages = {
  templateStudio: {
    updateDialog: {
      conflicts: "{count, plural, =1 {1 conflict} other {# conflicts}} with your local edits",
      keepLocal: "Keep mine",
      takeUpstream: "Take theirs",
      resolutionLabel: "Resolve {path}",
      unresolved:
        "{count, plural, =1 {1 conflict still needs an answer} other {# conflicts still need an answer}}",
    },
  },
}

function renderList(
  conflicts: { path: string }[],
  resolutions: Record<string, "local" | "upstream"> = {}
) {
  const onResolve = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TemplateConflictList
        conflicts={conflicts as never}
        resolutions={resolutions}
        onResolve={onResolve}
      />
    </NextIntlClientProvider>
  )
  return { onResolve }
}

describe("unresolvedPaths", () => {
  it("counts only the conflicts with no answer yet", () => {
    expect(unresolvedPaths([{ path: "a" }, { path: "b" }] as never, { a: "local" })).toEqual(["b"])
  })
})

describe("TemplateConflictList", () => {
  it("renders nothing when the two sides agree", () => {
    renderList([])
    expect(screen.queryByTestId("template-update-conflicts")).toBeNull()
  })

  /** Nothing is preselected: each side of a conflict discards someone's work. */
  it("starts every row unanswered", () => {
    renderList([{ path: "$/a" }])
    expect(screen.getByTestId("template-update-keep-$/a")).toHaveAttribute("data-state", "off")
    expect(screen.getByTestId("template-update-take-$/a")).toHaveAttribute("data-state", "off")
    expect(screen.getByTestId("template-update-pending")).toBeInTheDocument()
  })

  it("reports the choice for the path it was made on", () => {
    const { onResolve } = renderList([{ path: "$/a" }, { path: "$/b" }])
    fireEvent.click(screen.getByTestId("template-update-take-$/b"))
    expect(onResolve).toHaveBeenCalledWith("$/b", "upstream")
  })

  it("stops nagging once every row is answered", () => {
    renderList([{ path: "$/a" }], { "$/a": "local" })
    expect(screen.queryByTestId("template-update-pending")).toBeNull()
  })
})
