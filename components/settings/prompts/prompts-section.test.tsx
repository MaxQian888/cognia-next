/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { ReactNode } from "react"

jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => false),
}))
let mockSearchParams = new URLSearchParams()
const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}))
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
let mockDensity: "split" | "stacked" = "split"
jest.mock("@/components/settings/common/settings-master-detail", () => ({
  ...jest.requireActual("@/components/settings/common/settings-master-detail"),
  useSettingsListDensity: () => mockDensity,
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { createPreset } from "@/lib/db/prompt-presets"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { appSettingPromptAdapter } from "@/lib/prompts/adapters/app-settings"
import { listPromptDefinitions } from "@/lib/prompts/catalog"
import { publishPromptBody } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { PromptsSection } from "./prompts-section"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  mockDensity = "split"
  mockSearchParams = new URLSearchParams()
  mockReplace.mockClear()
  useCustomModeStore.setState({ customModes: {} })
  useProjectStore.setState({
    activeProjectId: "ws-1",
    projects: [{ id: "ws-1", name: "Repo", roots: [{ path: "/repo" }] }],
  } as never)
  await useSettingsStore.getState().retryLoad()
})
afterAll(dbFixture.dispose)
afterEach(() => jest.restoreAllMocks())

const rail = () => screen.getByTestId("prompts-section").querySelector("aside")!
const railHeadings = () =>
  [...rail().querySelectorAll("p.uppercase")].map((heading) => heading.textContent)
const instructionFileButton = () => screen.queryByRole("button", { name: /^AGENTS\.md/ })

async function renderSection() {
  render(<PromptsSection />)
  await waitFor(() =>
    expect(screen.getByTestId("prompt-center-count")).not.toHaveTextContent(/^0 prompts/)
  )
}

it("opens on the effective preview and lists every resource by owner", async () => {
  await createPreset({ name: "Team voice", content: "x" })
  await renderSection()
  expect(screen.getByTestId("effective-preview-panel")).toBeInTheDocument()
  const total = Number(screen.getByTestId("prompt-center-count").textContent?.match(/^(\d+)/)?.[1])
  expect(total).toBeGreaterThan(listPromptDefinitions().length)
  expect(railHeadings()).toEqual(
    expect.arrayContaining([
      "Default prompt",
      "Instruction files",
      "Workspace instructions",
      "Presets",
      "Chat",
      "Routing",
    ])
  )
  // Owners come before the built-in groups.
  expect(railHeadings().indexOf("Presets")).toBeLessThan(railHeadings().indexOf("Chat"))
  expect(rail()).toHaveTextContent("Team voice")
  expect(rail()).toHaveTextContent("Brief mode")
  // The active workspace has no instruction file yet; its first configured name is offered.
  expect(instructionFileButton()).toBeInTheDocument()
})

it("searches titles, ids and shipped text", async () => {
  await renderSection()
  fireEvent.change(screen.getByLabelText("Search prompts"), { target: { value: "skip preamble" } })
  await waitFor(() => expect(rail()).toHaveTextContent("Brief mode"))
  expect(rail()).not.toHaveTextContent("Team voice")
  fireEvent.change(screen.getByLabelText("Search prompts"), {
    target: { value: "zz-no-such-prompt" },
  })
  expect(await screen.findByText("No prompts match.")).toBeInTheDocument()
})

it("filters by source, group and modified state", async () => {
  await createPreset({ name: "Team voice", content: "x" })
  await renderSection()
  const [sourceFilter, groupFilter] = screen.getAllByRole("combobox")
  fireEvent.change(sourceFilter, { target: { value: "preset" } })
  await waitFor(() => expect(rail()).not.toHaveTextContent("Brief mode"))
  expect(rail()).toHaveTextContent("Team voice")

  fireEvent.change(sourceFilter, { target: { value: "all" } })
  fireEvent.change(groupFilter, { target: { value: "routing" } })
  await waitFor(() => expect(rail()).not.toHaveTextContent("Team voice"))
  expect(rail()).not.toHaveTextContent("Brief mode")
  fireEvent.change(groupFilter, { target: { value: "all" } })

  await act(async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: { scope: "account", targetId: "" },
      body: "Short.",
      expectedRev: 0,
    })
  })
  await userEvent.click(screen.getByRole("switch", { name: "Modified only" }))
  await waitFor(() => expect(rail()).toHaveTextContent("Brief mode"))
  expect(rail()).not.toHaveTextContent("Team voice")
})

it("opens a built-in prompt and an owner resource in their own detail views", async () => {
  await createPreset({ name: "Team voice", content: "Say it plainly." })
  await renderSection()
  await userEvent.click(screen.getByRole("button", { name: /Brief mode/ }))
  expect(await screen.findByTestId("code-prompt-detail")).toHaveTextContent(BRIEF_MODE_PROMPT.id)
  await userEvent.click(screen.getByRole("button", { name: /Team voice/ }))
  expect(await screen.findByTestId("owner-prompt-detail")).toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getByTestId("prompt-body-editor").querySelector("textarea")!.value).toBe(
      "Say it plainly."
    )
  )
})

it("selects the resource a deep link names in its workspace, then drops the params", async () => {
  mockSearchParams = new URLSearchParams({
    section: "prompts",
    resource: `code:${BRIEF_MODE_PROMPT.id}`,
    workspace: "__none__",
  })
  await renderSection()
  expect(await screen.findByTestId("code-prompt-detail")).toHaveTextContent(BRIEF_MODE_PROMPT.id)
  // The named workspace replaced the active one: no workspace, no instruction files.
  expect(instructionFileButton()).toBeNull()
  await waitFor(() =>
    expect(mockReplace).toHaveBeenCalledWith("?section=prompts", { scroll: false })
  )
})

it("drops a deep link to a resource that does not exist without selecting anything", async () => {
  mockSearchParams = new URLSearchParams({ section: "prompts", resource: "code:no.such.prompt" })
  await renderSection()
  await waitFor(() =>
    expect(mockReplace).toHaveBeenCalledWith("?section=prompts", { scroll: false })
  )
  expect(screen.getByTestId("effective-preview-panel")).toBeInTheDocument()
})

it("lists instruction files for the workspace chosen here, not the active one", async () => {
  await renderSection()
  expect(instructionFileButton()).toBeInTheDocument()
  const workspace = screen.getAllByRole("combobox")[2]
  fireEvent.change(workspace, { target: { value: "__none__" } })
  await waitFor(() => expect(instructionFileButton()).toBeNull())
  expect(railHeadings()).not.toContain("Workspace instructions")
})

it("names an owner that could not be read and keeps the rest", async () => {
  jest.spyOn(appSettingPromptAdapter, "list").mockRejectedValue(new Error("locked"))
  await renderSection()
  expect(await screen.findByText("Could not read: Default prompt")).toBeInTheDocument()
  expect(rail()).toHaveTextContent("Brief mode")
})

it("swaps the list for a picker when the pane is narrow", async () => {
  mockDensity = "stacked"
  render(<PromptsSection />)
  const picker = await screen.findByTestId("prompts-stacked-picker")
  const select = picker.querySelector("select")!
  await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(10))
  fireEvent.change(select, { target: { value: `code:${BRIEF_MODE_PROMPT.id}` } })
  expect(await screen.findByTestId("code-prompt-detail")).toBeInTheDocument()
})

it("opens the profile dialog", async () => {
  await renderSection()
  await userEvent.click(screen.getByRole("button", { name: "Profiles" }))
  expect(await screen.findByText("Prompt profiles")).toBeInTheDocument()
})
