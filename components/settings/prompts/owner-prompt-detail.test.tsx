/** @jest-environment jsdom */

import "fake-indexeddb/auto"

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush, replace: jest.fn() }) }))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import {
  createCharacter,
  createCharacterVariant,
  resolveCharacterById,
  updateCharacter,
} from "@/lib/db/characters"
import { createChatTemplate } from "@/lib/db/chat-templates"
import { createPreset, getPreset, listPresets, seedBuiltInPresets } from "@/lib/db/prompt-presets"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { WorkspaceFileConflictError } from "@/lib/files/workspace-fs"
import { characterPromptAdapter } from "@/lib/prompts/adapters/characters"
import {
  instructionFilePromptAdapter,
  instructionFileKey,
} from "@/lib/prompts/adapters/instruction-files"
import { presetPromptAdapter } from "@/lib/prompts/adapters/presets"
import { resourceKey, type PromptResourceSummary } from "@/lib/prompts/resources"
import { settingsHref } from "@/lib/settings/deep-link"
import { WORKSPACE_INSTRUCTIONS_MAX_CHARS } from "@/lib/workspace/workspace-instructions"
import { BUILT_IN_PRESET_IDS } from "@/lib/presets/built-ins"
import { useProjectStore } from "@/stores/project/project-store"
import { OwnerPromptDetail } from "./owner-prompt-detail"

const mockToast = jest.mocked(toast)
const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
})
afterAll(dbFixture.dispose)
afterEach(() => jest.restoreAllMocks())

const ctx = {}

async function summaryFor(key: string): Promise<PromptResourceSummary> {
  const { ownerAdapterFor } = await import("@/lib/prompts/adapters")
  const listed = await ownerAdapterFor(key)!.list(ctx)
  const found = listed.find((entry) => entry.key === key)
  if (!found) throw new Error(`no summary for ${key}`)
  return found
}

function renderDetail(resource: PromptResourceSummary, context = ctx) {
  const onChanged = jest.fn()
  const onSelect = jest.fn()
  render(
    <OwnerPromptDetail
      resource={resource}
      ctx={context}
      onChanged={onChanged}
      onSelect={onSelect}
    />
  )
  return { onChanged, onSelect }
}

const editor = () => screen.getByTestId("prompt-body-editor").querySelector("textarea")!

it("saves a user preset in place and compares with the saved text", async () => {
  const preset = await createPreset({ name: "Mine", content: "Be terse." })
  const { onChanged } = renderDetail(await summaryFor(resourceKey("preset", preset.id)))
  await waitFor(() => expect(editor().value).toBe("Be terse."))
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

  fireEvent.change(editor(), { target: { value: "Be brief." } })
  await userEvent.click(screen.getByRole("tab", { name: "Compare with saved" }))
  expect(await screen.findByTestId("line-diff-view")).toBeInTheDocument()
  await userEvent.click(screen.getByRole("tab", { name: "Edit" }))
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(async () => expect((await getPreset(preset.id))?.content).toBe("Be brief."))
  expect(onChanged).toHaveBeenCalled()
  expect(mockToast.success).toHaveBeenCalledWith("Saved.")
})

it("saves a built-in preset as the user's own copy and opens it", async () => {
  await seedBuiltInPresets()
  const builtInId = [...BUILT_IN_PRESET_IDS][0]
  const shipped = await getPreset(builtInId)
  const { onSelect } = renderDetail(await summaryFor(resourceKey("preset", builtInId)))
  expect(await screen.findByText("Shipped with Cognia")).toBeInTheDocument()
  fireEvent.change(editor(), { target: { value: "My take." } })
  await userEvent.click(screen.getByRole("button", { name: "Save as my version" }))
  await waitFor(() => expect(onSelect).toHaveBeenCalled())
  const copyId = onSelect.mock.calls[0][0].slice("preset:".length)
  expect(await getPreset(copyId)).toMatchObject({
    name: `${shipped!.name} (my version)`,
    content: "My take.",
  })
  expect((await getPreset(builtInId))?.content).toBe(shipped!.content)
})

it("makes a preset the default without editing it", async () => {
  const preset = await createPreset({ name: "Mine", content: "x" })
  renderDetail(await summaryFor(resourceKey("preset", preset.id)))
  await userEvent.click(await screen.findByRole("button", { name: "Use by default" }))
  await waitFor(async () => expect((await getPreset(preset.id))?.isDefault).toBe(true))
  expect((await listPresets()).filter((row) => row.isDefault)).toHaveLength(1)
})

it("lets a variant follow its base prompt again", async () => {
  const base = await createCharacter({ name: "Base", systemPrompt: "Base prompt." })
  const variant = await createCharacterVariant(base.id, "Variant")
  await updateCharacter(variant.id, { systemPrompt: "Variant prompt." })
  renderDetail(await summaryFor(resourceKey("character", variant.id)))
  await waitFor(() => expect(editor().value).toBe("Variant prompt."))
  expect(screen.getByRole("tab", { name: "Compare with base" })).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Follow the base prompt again" }))
  await waitFor(() => expect(editor().value).toBe("Base prompt."))
  expect((await resolveCharacterById(variant.id))?.variant?.ownFields).not.toContain("systemPrompt")
})

it("sends a shipped agent's edit to its existing variant", async () => {
  const shipped = await createCharacter({ name: "Shipped", systemPrompt: "Shipped." })
  await getDb().characters.update(shipped.id, { isBuiltIn: true })
  const variantKey = await characterPromptAdapter.saveCustom!(
    resourceKey("character", shipped.id),
    "Mine.",
    ctx
  )
  const { onSelect } = renderDetail(await summaryFor(resourceKey("character", shipped.id)))
  await userEvent.click(await screen.findByRole("button", { name: "Open my version" }))
  expect(onSelect).toHaveBeenCalledWith(variantKey)
  fireEvent.change(editor(), { target: { value: "Mine, again." } })
  await userEvent.click(screen.getByRole("button", { name: "Update my variant" }))
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(variantKey))
  expect((await resolveCharacterById(variantKey.slice("character:".length)))?.systemPrompt).toBe(
    "Mine, again."
  )
})

it("shows a chat template read-only and opens its owner", async () => {
  const template = await createChatTemplate({ name: "Standup", body: "Summarize {{day}}" })
  renderDetail(await summaryFor(resourceKey("composer-template", template.id)))
  await waitFor(() => expect(editor().value).toBe("Summarize {{day}}"))
  expect(editor()).toHaveAttribute("readonly")
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  expect(screen.getByText(/inserted as your own message/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Open in Chat templates" }))
  expect(mockPush).toHaveBeenCalledWith(settingsHref("chatTemplates"))
})

describe("instruction files", () => {
  const key = instructionFileKey({ root: "/repo", name: "AGENTS.md" })
  const resource: PromptResourceSummary = {
    key,
    source: "instruction-file",
    kind: "project-rule",
    operation: "append-rules",
    name: "AGENTS.md",
    builtIn: false,
    modified: true,
    edit: "source",
    ownerSection: "agent-runtime",
    detail: "project",
  }

  it("keeps the user's text when the file changed on disk and saves over it on request", async () => {
    const read = jest
      .spyOn(instructionFilePromptAdapter, "read")
      .mockResolvedValueOnce({ key, text: "Old.", version: "sha-1" })
      .mockResolvedValue({ key, text: "Changed on disk.", version: "sha-2" })
    const save = jest
      .spyOn(instructionFilePromptAdapter, "save")
      .mockRejectedValueOnce(new WorkspaceFileConflictError("sha-2"))
      .mockResolvedValue({ key, text: "Mine.", version: "sha-3" })
    renderDetail(resource)
    expect(await screen.findByText("Project instruction file")).toBeInTheDocument()
    await waitFor(() => expect(editor().value).toBe("Old."))
    fireEvent.change(editor(), { target: { value: "Mine." } })
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByTestId("owner-file-conflict")).toBeInTheDocument()
    expect(save).toHaveBeenLastCalledWith(key, "Mine.", "sha-1", ctx)
    expect(editor().value).toBe("Mine.")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    await userEvent.click(screen.getByRole("button", { name: "Save my text over it" }))
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(key, "Mine.", "sha-2", ctx))
    await waitFor(() => expect(screen.queryByTestId("owner-file-conflict")).toBeNull())
    expect(read).toHaveBeenCalled()
  })

  it("drops the user's text and loads the file on request", async () => {
    jest
      .spyOn(instructionFilePromptAdapter, "read")
      .mockResolvedValueOnce({ key, text: "Old.", version: "sha-1" })
      .mockResolvedValue({ key, text: "Changed on disk.", version: "sha-2" })
    jest
      .spyOn(instructionFilePromptAdapter, "save")
      .mockRejectedValue(new WorkspaceFileConflictError("sha-2"))
    renderDetail(resource)
    await waitFor(() => expect(editor().value).toBe("Old."))
    fireEvent.change(editor(), { target: { value: "Mine." } })
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await userEvent.click(
      await screen.findByRole("button", { name: "Discard my text and load the file" })
    )
    await waitFor(() => expect(editor().value).toBe("Changed on disk."))
    expect(screen.queryByTestId("owner-file-conflict")).toBeNull()
  })
})

it("holds workspace instructions to their limit", async () => {
  useProjectStore.setState({ projects: [{ id: "ws-1", name: "Repo", roots: [] }] } as never)
  const context = { workspace: { id: "ws-1", name: "Repo", roots: [] } }
  const { workspaceInstructionsPromptAdapter } =
    await import("@/lib/prompts/adapters/workspace-instructions")
  const [resource] = await workspaceInstructionsPromptAdapter.list(context)
  renderDetail(resource, context)
  await screen.findByTestId("prompt-body-editor")
  fireEvent.change(editor(), {
    target: { value: "x".repeat(WORKSPACE_INSTRUCTIONS_MAX_CHARS + 1) },
  })
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  expect(screen.getByTestId("prompt-body-issues").textContent).toContain("the limit is")
})

it("reports a missing resource and a failed read with a retry", async () => {
  renderDetail({
    key: resourceKey("preset", "gone"),
    source: "preset",
    kind: "role",
    operation: "legacy-replace",
    name: "Gone",
    builtIn: false,
    modified: false,
    edit: "source",
  })
  expect(await screen.findByText("This resource no longer exists.")).toBeInTheDocument()
})

it("retries a failed read", async () => {
  const preset = await createPreset({ name: "Mine", content: "Back." })
  const resource = await summaryFor(resourceKey("preset", preset.id))
  const read = jest.spyOn(presetPromptAdapter, "read").mockRejectedValueOnce(new Error("locked"))
  renderDetail(resource)
  expect(await screen.findByText("Could not read this resource")).toBeInTheDocument()
  read.mockRestore()
  await userEvent.click(screen.getByRole("button", { name: "Retry" }))
  await waitFor(() => expect(editor().value).toBe("Back."))
})
