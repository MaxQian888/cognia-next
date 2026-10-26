/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { ReactNode } from "react"

jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    children: ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange?.(event.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { SUBAGENT_CONTRACT_PROMPT } from "@/lib/agent/prompts/subagent-frame"
import { DIFFICULTY_JUDGE_PROMPT } from "@/lib/ai/routing/difficulty-judge"
import { publishPromptOverride } from "@/lib/db/prompt-overrides"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  __resetPromptResolutionsForTests,
  recordPromptResolution,
} from "@/lib/prompts/resolution-log"
import { publishPromptBody, readPromptSlot } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { useProjectStore } from "@/stores/project/project-store"
import { toast } from "sonner"
import { CodePromptDetail } from "./code-prompt-detail"

const mockToast = jest.mocked(toast)

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  __resetPromptResolutionsForTests()
  jest.clearAllMocks()
  useProjectStore.setState({ projects: [{ id: "ws-1", name: "Repo", roots: [] }] } as never)
})
afterAll(dbFixture.dispose)

const account = { scope: "account" as const, targetId: "" }

/** Render and let the shipped-text digest settle, so no update lands after a test. */
async function renderDetail(def: Parameters<typeof CodePromptDetail>[0]["def"]) {
  render(<CodePromptDetail def={def} />)
  await act(async () => {})
}
const editor = () => screen.getByTestId("prompt-body-editor").querySelector("textarea")!

async function typeBody(text: string) {
  await screen.findByTestId("prompt-body-editor")
  fireEvent.change(editor(), { target: { value: text } })
}

it("shows protocol text read-only with nothing to publish", async () => {
  await renderDetail(SUBAGENT_CONTRACT_PROMPT)
  expect(screen.getByText("Read-only protocol text")).toBeInTheDocument()
  expect(editor()).toHaveAttribute("readonly")
  expect(editor().value).toBe(SUBAGENT_CONTRACT_PROMPT.defaultBody)
  expect(screen.queryByRole("button", { name: "Publish" })).toBeNull()
})

it("publishes at the account scope and reports it as published", async () => {
  await renderDetail(BRIEF_MODE_PROMPT)
  await waitFor(() => expect(editor().value).toBe(BRIEF_MODE_PROMPT.defaultBody))
  expect(screen.getByTestId("prompt-slot-status")).toHaveTextContent("it inherits")
  await typeBody("Answer in one line.")
  await userEvent.click(screen.getByRole("button", { name: "Publish" }))
  await waitFor(() =>
    expect(mockToast.success).toHaveBeenCalledWith("Published. The next call uses it.")
  )
  expect((await readPromptSlot(BRIEF_MODE_PROMPT.id, account)).active?.body).toBe(
    "Answer in one line."
  )
  await waitFor(() =>
    expect(screen.getByTestId("prompt-slot-status")).toHaveTextContent("Published at this scope")
  )
  expect(editor().value).toBe("Answer in one line.")
})

it("blocks a publish that drops text the parser needs", async () => {
  await renderDetail(DIFFICULTY_JUDGE_PROMPT)
  await typeBody("Rate it.")
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled()
  expect(screen.getByTestId("prompt-body-issues").textContent).toContain("Must keep")
})

it("saves a draft without activating it, then discards it", async () => {
  await renderDetail(BRIEF_MODE_PROMPT)
  await typeBody("Draft wording.")
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }))
  await waitFor(() =>
    expect(screen.getByTestId("prompt-slot-status")).toHaveTextContent("unpublished draft")
  )
  const slot = await readPromptSlot(BRIEF_MODE_PROMPT.id, account)
  expect(slot.draft?.body).toBe("Draft wording.")
  expect(slot.active).toBeUndefined()

  await userEvent.click(screen.getByRole("button", { name: "Discard draft" }))
  await waitFor(() => expect(editor().value).toBe(BRIEF_MODE_PROMPT.defaultBody))
  expect((await readPromptSlot(BRIEF_MODE_PROMPT.id, account)).draft).toBeUndefined()
})

it("resets to inherited after showing the text that will apply", async () => {
  await publishPromptBody({
    def: BRIEF_MODE_PROMPT,
    target: account,
    body: "Mine.",
    expectedRev: 0,
  })
  await renderDetail(BRIEF_MODE_PROMPT)
  await waitFor(() => expect(editor().value).toBe("Mine."))
  await userEvent.click(screen.getByRole("button", { name: "Reset to inherited" }))
  expect(await screen.findByText("Reset this override?")).toBeInTheDocument()
  const dialogButtons = screen.getAllByRole("button", { name: "Reset to inherited" })
  await userEvent.click(dialogButtons[dialogButtons.length - 1])
  await waitFor(() => expect(editor().value).toBe(BRIEF_MODE_PROMPT.defaultBody))
  expect((await readPromptSlot(BRIEF_MODE_PROMPT.id, account)).active).toBeUndefined()
})

it("needs an explicit workspace before it can write a workspace override", async () => {
  await renderDetail(BRIEF_MODE_PROMPT)
  const [scope] = screen.getAllByRole("combobox")
  fireEvent.change(scope, { target: { value: "workspace" } })
  expect(screen.getAllByText("Choose a workspace").length).toBeGreaterThan(0)
  expect(screen.queryByRole("button", { name: "Publish" })).toBeNull()

  fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "ws-1" } })
  await typeBody("Workspace brevity.")
  await userEvent.click(screen.getByRole("button", { name: "Publish" }))
  await waitFor(async () =>
    expect(
      (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-1" })).active
        ?.body
    ).toBe("Workspace brevity.")
  )
  expect((await readPromptSlot(BRIEF_MODE_PROMPT.id, account)).binding).toBeUndefined()
})

it("keeps unsaved text when the slot changes elsewhere and loads the latest on request", async () => {
  await renderDetail(BRIEF_MODE_PROMPT)
  await typeBody("My unsaved edit.")
  await act(async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "From the CLI.",
      expectedRev: 0,
    })
  })
  expect(await screen.findByText("Changed since you started editing")).toBeInTheDocument()
  expect(editor().value).toBe("My unsaved edit.")
  expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled()

  await userEvent.click(
    screen.getByRole("button", { name: "Discard my edits and load the latest" })
  )
  await waitFor(() => expect(editor().value).toBe("From the CLI."))
  expect(screen.queryByText("Changed since you started editing")).toBeNull()
})

it("follows a change made elsewhere when there are no unsaved edits", async () => {
  await renderDetail(BRIEF_MODE_PROMPT)
  await waitFor(() => expect(editor().value).toBe(BRIEF_MODE_PROMPT.defaultBody))
  await act(async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: account,
      body: "Imported.",
      expectedRev: 0,
    })
  })
  await waitFor(() => expect(editor().value).toBe("Imported."))
  expect(screen.queryByText("Changed since you started editing")).toBeNull()
})

it("restores an earlier revision from the history", async () => {
  const first = await publishPromptBody({
    def: BRIEF_MODE_PROMPT,
    target: account,
    body: "First.",
    expectedRev: 0,
  })
  await publishPromptBody({
    def: BRIEF_MODE_PROMPT,
    target: account,
    body: "Second.",
    expectedRev: first.rev,
  })
  await renderDetail(BRIEF_MODE_PROMPT)
  await waitFor(() => expect(editor().value).toBe("Second."))
  await userEvent.click(screen.getByRole("tab", { name: /History/ }))
  const published = await screen.findAllByRole("button", { name: /Published/ })
  await userEvent.click(published[1])
  await userEvent.click(screen.getByRole("button", { name: "Restore as a new revision" }))
  await waitFor(async () =>
    expect((await readPromptSlot(BRIEF_MODE_PROMPT.id, account)).active?.body).toBe("First.")
  )
  expect(mockToast.success).toHaveBeenCalledWith("Restored as a new revision.")
})

it("compares the editor with the shipped text", async () => {
  await renderDetail(BRIEF_MODE_PROMPT)
  await userEvent.click(await screen.findByRole("tab", { name: "Compare" }))
  expect(await screen.findByText("No differences.")).toBeInTheDocument()
  await userEvent.click(screen.getByRole("tab", { name: "Edit" }))
  await typeBody("Different.")
  await userEvent.click(screen.getByRole("tab", { name: "Compare" }))
  expect(await screen.findByTestId("line-diff-view")).toBeInTheDocument()
})

it("marks an override written for another contract as not in use", async () => {
  await publishPromptOverride({
    promptId: BRIEF_MODE_PROMPT.id,
    target: account,
    body: "Old contract.",
    contractVersion: BRIEF_MODE_PROMPT.contractVersion + 1,
    baseDigest: "old",
    expectedRev: 0,
    mutationId: "m1",
    origin: "import",
  })
  await renderDetail(BRIEF_MODE_PROMPT)
  expect(await screen.findByText("Override not in use")).toBeInTheDocument()
})

it("flags an override written against an older shipped text", async () => {
  await publishPromptOverride({
    promptId: BRIEF_MODE_PROMPT.id,
    target: account,
    body: "Kept.",
    contractVersion: BRIEF_MODE_PROMPT.contractVersion,
    baseDigest: "an-older-digest",
    expectedRev: 0,
    mutationId: "m2",
    origin: "editor",
  })
  await renderDetail(BRIEF_MODE_PROMPT)
  expect(await screen.findByText("Shipped text changed")).toBeInTheDocument()
})

it("shows the last use recorded in this window", async () => {
  await renderDetail(BRIEF_MODE_PROMPT)
  await screen.findByTestId("prompt-body-editor")
  expect(screen.getByText("Not used since this window opened")).toBeInTheDocument()
  act(() =>
    recordPromptResolution({
      promptId: BRIEF_MODE_PROMPT.id,
      source: { kind: "override", scope: "workspace", bindingId: "b", revisionId: "r" },
      context: { workspaceId: "ws-1" },
      at: 0,
    })
  )
  expect(screen.getByText(/Override at the Workspace scope/)).toBeInTheDocument()
})
