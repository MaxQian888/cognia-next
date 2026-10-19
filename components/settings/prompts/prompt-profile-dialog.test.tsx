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
jest.mock("@cognia/plugin-sdk/api/download", () => ({ downloadBlob: jest.fn() }))

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { downloadBlob } from "@cognia/plugin-sdk/api/download"
import { toast } from "sonner"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { exportPromptProfile, serializePromptProfile } from "@/lib/prompts/profile"
import { publishPromptBody, readPromptSlot } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { useProjectStore } from "@/stores/project/project-store"
import { PromptProfileDialog } from "./prompt-profile-dialog"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  jest.clearAllMocks()
  useProjectStore.setState({
    projects: [
      { id: "ws-src", name: "Same id here", roots: [] },
      { id: "ws-other", name: "Other", roots: [] },
    ],
  } as never)
})
afterAll(dbFixture.dispose)

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

async function profileText(): Promise<string> {
  await publishPromptBody({
    def: BRIEF_MODE_PROMPT,
    target: { scope: "account", targetId: "" },
    body: "Account brevity.",
    expectedRev: 0,
  })
  await publishPromptBody({
    def: BRIEF_MODE_PROMPT,
    target: { scope: "workspace", targetId: "ws-src" },
    body: "Workspace brevity.",
    expectedRev: 0,
  })
  const text = serializePromptProfile(await exportPromptProfile())
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  return text
}

/** The mapping row's select (the mocked Select drops the trigger's label). */
async function mappingFor(sourceId: string): Promise<HTMLSelectElement> {
  const id = await screen.findByText(sourceId, { selector: "code" })
  return id.parentElement!.querySelector("select")!
}

async function openImport(text: string) {
  render(<PromptProfileDialog open onOpenChange={jest.fn()} />)
  await userEvent.click(screen.getByRole("tab", { name: "Import" }))
  const input = screen.getByLabelText("Choose a profile file") as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([text], "profile.json")] } })
}

it("exports the published overrides of the chosen scopes", async () => {
  await publishPromptBody({
    def: BRIEF_MODE_PROMPT,
    target: { scope: "account", targetId: "" },
    body: "Exported.",
    expectedRev: 0,
  })
  render(<PromptProfileDialog open onOpenChange={jest.fn()} />)
  await userEvent.click(screen.getByRole("button", { name: "Export" }))
  await waitFor(() => expect(downloadBlob).toHaveBeenCalled())
  const [name, blob] = jest.mocked(downloadBlob).mock.calls[0] as [string, Blob]
  expect(name).toMatch(/^cognia-prompts-\d{4}-\d{2}-\d{2}\.json$/)
  const profile = JSON.parse(await readBlob(blob))
  expect(profile.entries).toEqual([
    expect.objectContaining({ promptId: BRIEF_MODE_PROMPT.id, body: "Exported." }),
  ])
})

it("says when the chosen scopes publish nothing", async () => {
  render(<PromptProfileDialog open onOpenChange={jest.fn()} />)
  await userEvent.click(screen.getByRole("button", { name: "Export" }))
  await waitFor(() =>
    expect(toast.info).toHaveBeenCalledWith("Nothing is published in the chosen scopes.")
  )
  expect(downloadBlob).not.toHaveBeenCalled()
})

it("previews an import, maps a workspace that exists here and publishes the ticked entries", async () => {
  const text = await profileText()
  const onOpenChange = jest.fn()
  render(<PromptProfileDialog open onOpenChange={onOpenChange} />)
  await userEvent.click(screen.getByRole("tab", { name: "Import" }))
  fireEvent.change(screen.getByLabelText("Choose a profile file"), {
    target: { files: [new File([text], "profile.json")] },
  })
  const preview = await screen.findByTestId("prompt-import-preview")
  await waitFor(() => expect(within(preview).getAllByText("New")).toHaveLength(2))
  expect((await mappingFor("ws-src")).value).toBe("ws-src")

  await userEvent.click(screen.getByRole("button", { name: "Publish 2 overrides" }))
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  expect(toast.success).toHaveBeenCalledWith("Published 2 overrides.")
  expect(
    (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "account", targetId: "" })).active?.body
  ).toBe("Account brevity.")
  expect(
    (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-src" })).active
      ?.body
  ).toBe("Workspace brevity.")
})

it("leaves a skipped target unpublished", async () => {
  const text = await profileText()
  await openImport(text)
  const mapping = await mappingFor("ws-src")
  await waitFor(() => expect(mapping.value).toBe("ws-src"))
  fireEvent.change(mapping, { target: { value: "__unmapped__" } })
  const preview = screen.getByTestId("prompt-import-preview")
  await waitFor(() => expect(within(preview).getByText("Needs a target")).toBeInTheDocument())
  // The skip sticks: the row does not map itself back.
  expect(mapping.value).toBe("__unmapped__")
  // The test mock of next-intl has no `one` branch, so match the stem.
  await userEvent.click(screen.getByRole("button", { name: /^Publish 1 override/ }))
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Published 1 override/))
  )
  expect(
    (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-src" })).binding
  ).toBeUndefined()
})

it("maps an entry to another local workspace", async () => {
  const text = await profileText()
  await openImport(text)
  const mapping = await mappingFor("ws-src")
  fireEvent.change(mapping, { target: { value: "ws-other" } })
  await waitFor(() => expect(mapping.value).toBe("ws-other"))
  await userEvent.click(await screen.findByRole("button", { name: "Publish 2 overrides" }))
  await waitFor(() => expect(toast.success).toHaveBeenCalled())
  expect(
    (await readPromptSlot(BRIEF_MODE_PROMPT.id, { scope: "workspace", targetId: "ws-other" }))
      .active?.body
  ).toBe("Workspace brevity.")
})

it("rejects a file that is not a profile", async () => {
  await openImport("{ nope")
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("This is not a prompt profile: not JSON")
  )
  expect(screen.queryByTestId("prompt-import-preview")).toBeNull()
})
