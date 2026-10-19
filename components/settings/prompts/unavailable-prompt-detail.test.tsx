/** @jest-environment jsdom */

import "fake-indexeddb/auto"

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}))

import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { listPromptOverrideBindings } from "@/lib/db/prompt-overrides"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  __resetPluginPromptsForTesting,
  getPluginPromptEntry,
  registerPluginPrompts,
} from "@/lib/prompts/plugin-prompts"
import { publishPromptBody, savePromptDraft } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { toast } from "sonner"
import { UnavailablePromptDetail } from "./unavailable-prompt-detail"

const SLOT = "plugin:deep-research/outline"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  __resetPluginPromptsForTesting()
  jest.clearAllMocks()
})
afterAll(dbFixture.dispose)

/** Publish while the plugin is enabled, then disable it. */
async function orphanedOverrides() {
  const dispose = registerPluginPrompts(
    "deep-research",
    [{ id: "outline", title: "Outline", defaultBody: "Plan the report." }],
    "plugins/deep-research/src/engine/prompts.ts"
  )
  const def = getPluginPromptEntry(SLOT)!.def
  await publishPromptBody({
    def,
    target: { scope: "account", targetId: "" },
    body: "Plan a short report.",
    expectedRev: 0,
  })
  await savePromptDraft({
    def,
    target: { scope: "workspace", targetId: "ws-1" },
    body: "Draft only.",
    expectedRev: 0,
  })
  dispose()
}

it("shows the kept text of each scope and names the missing plugin", async () => {
  await orphanedOverrides()
  render(<UnavailablePromptDetail promptId={SLOT} />)
  expect(await screen.findByText("Plan a short report.")).toBeInTheDocument()
  expect(screen.getByText(/belongs to the plugin deep-research/)).toBeInTheDocument()
  const slots = within(screen.getByRole("list", { name: "Saved overrides" })).getAllByRole(
    "listitem"
  )
  expect(slots).toHaveLength(2)
  expect(within(slots[1]).getByText("Has a draft")).toBeInTheDocument()
  expect(within(slots[1]).getByText("ws-1")).toBeInTheDocument()
  expect(
    within(slots[1]).getByText("No published text, only a draft or a reset.")
  ).toBeInTheDocument()
})

it("says a shipped prompt was retired when the id is not a plugin's", async () => {
  render(<UnavailablePromptDetail promptId="generation.retired" />)
  await act(async () => {})
  expect(screen.getByText(/no longer uses this prompt/)).toBeInTheDocument()
})

it("removes one scope's override after confirmation", async () => {
  await orphanedOverrides()
  render(<UnavailablePromptDetail promptId={SLOT} />)
  await screen.findByText("Plan a short report.")
  const [accountSlot] = within(screen.getByRole("list", { name: "Saved overrides" })).getAllByRole(
    "listitem"
  )
  await userEvent.click(within(accountSlot).getByRole("button", { name: /Remove/ }))
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" })
  )
  await waitFor(() => expect(jest.mocked(toast).success).toHaveBeenCalledWith("Override removed."))
  const remaining = await listPromptOverrideBindings()
  expect(remaining.map((binding) => binding.scope)).toEqual(["workspace"])
  await waitFor(() => expect(screen.queryByText("Plan a short report.")).not.toBeInTheDocument())
})
