/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PromptOverrideRevisionRow } from "@/lib/db/prompt-overrides"
import { PromptHistory, type PromptHistoryProps } from "./prompt-history"

function revision(
  id: string,
  kind: PromptOverrideRevisionRow["kind"],
  body: string,
  createdAt: number
): PromptOverrideRevisionRow {
  return {
    id,
    bindingId: "b",
    promptId: "chat.brief-mode",
    parentId: null,
    kind,
    body,
    contractVersion: 1,
    baseDigest: "d",
    origin: "editor",
    mutationId: id,
    createdAt,
  }
}

function renderHistory(props: Partial<PromptHistoryProps>) {
  const onRestore = jest.fn()
  const onLoadDraft = jest.fn()
  render(
    <PromptHistory
      revisions={[]}
      activeRevisionId={null}
      draftRevisionId={null}
      currentText="Now."
      inheritedText="Shipped."
      onRestore={onRestore}
      onLoadDraft={onLoadDraft}
      {...props}
    />
  )
  return { onRestore, onLoadDraft }
}

it("says when nothing has been saved", () => {
  renderHistory({})
  expect(screen.getByText("Nothing has been saved at this scope yet.")).toBeInTheDocument()
})

it("restores an older revision and offers nothing for the active one", async () => {
  const active = revision("r2", "published", "Two.", 2)
  const older = revision("r1", "published", "One.", 1)
  const { onRestore } = renderHistory({ revisions: [active, older], activeRevisionId: "r2" })
  expect(screen.getByText("Active")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull()
  await userEvent.click(screen.getAllByRole("button", { name: /Published/ })[1])
  await userEvent.click(screen.getByRole("button", { name: "Restore as a new revision" }))
  expect(onRestore).toHaveBeenCalledWith(older)
})

it("restores inheritance from a reset revision and loads a draft into the editor", async () => {
  const draft = revision("d1", "draft", "Draft text.", 3)
  const reset = revision("x1", "reset", "", 2)
  const { onRestore, onLoadDraft } = renderHistory({
    revisions: [draft, reset],
    draftRevisionId: "d1",
  })
  expect(screen.getAllByText("Draft")).toHaveLength(2)
  await userEvent.click(screen.getByRole("button", { name: "Load into the editor" }))
  expect(onLoadDraft).toHaveBeenCalledWith(draft)
  await userEvent.click(screen.getByRole("button", { name: /Reset to inherited/ }))
  await userEvent.click(screen.getByRole("button", { name: "Restore inheritance" }))
  expect(onRestore).toHaveBeenCalledWith(reset)
})
