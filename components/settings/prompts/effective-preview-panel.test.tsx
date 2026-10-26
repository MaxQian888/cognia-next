/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { ReactNode } from "react"

jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => false),
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

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createCharacter } from "@/lib/db/characters"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { Plugin } from "@/types/plugin"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { EffectivePreviewPanel } from "./effective-preview-panel"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  useCustomModeStore.setState({ customModes: {} })
  usePluginStore.setState({ plugins: {} })
  useProjectStore.setState({
    projects: [{ id: "ws-1", name: "Repo", customInstructions: "Small diffs.", roots: [] }],
  } as never)
  await useSettingsStore.getState().retryLoad()
})
afterAll(dbFixture.dispose)

it("lays out a new chat's prompt for the chosen agent and mode", async () => {
  const agent = await createCharacter({
    name: "Ada",
    systemPrompt: "You are Ada.",
    persona: { tone: "warm" },
  })
  const mode = useCustomModeStore
    .getState()
    .createMode({ name: "Mine", systemPrompt: "Mode text." })
  render(<EffectivePreviewPanel workspaceId="ws-1" />)
  const [agentSelect, modeSelect] = screen.getAllByRole("combobox")
  await waitFor(() =>
    expect(
      [...agentSelect.querySelectorAll("option")].some((option) => option.value === agent.id)
    ).toBe(true)
  )
  fireEvent.change(agentSelect, { target: { value: agent.id } })
  fireEvent.change(modeSelect, { target: { value: mode.id } })

  await waitFor(() => expect(screen.getByText("Agent prompt · Ada")).toBeInTheDocument())
  const segments = within(screen.getByRole("list", { name: "Sections in send order" }))
  expect(
    segments
      .getAllByText(/^(Base prompt|Persona|Standing rules|Workspace instructions|Mode|Skills)$/)
      .map((node) => node.textContent)
  ).toEqual(["Base prompt", "Persona", "Workspace instructions", "Mode"])
  expect(
    screen.getByText(/Instruction files — this host has no project files to read/)
  ).toBeInTheDocument()
  expect(screen.getByText("Memory recall")).toBeInTheDocument()
  expect(screen.getByTestId("effective-preview-total")).toHaveTextContent("characters")

  await userEvent.click(screen.getByRole("button", { name: /Persona/ }))
  expect(screen.getByText(/Tone: warm/)).toBeInTheDocument()
})

it("starts from the default system prompt without an agent", async () => {
  await useSettingsStore.getState().save({ defaultSystemPrompt: "Default." })
  render(<EffectivePreviewPanel workspaceId={null} />)
  expect(await screen.findByText("Default system prompt")).toBeInTheDocument()
  expect(screen.getByText(/Workspace instructions — nothing set/)).toBeInTheDocument()
})

it("offers enabled plugins' modes next to the user's own", () => {
  useCustomModeStore.getState().createMode({ name: "Mine", systemPrompt: "Mode text." })
  const workMode = { id: "work:work", type: "custom", name: "Work", description: "", icon: "Bot" }
  usePluginStore.setState({
    plugins: {
      work: { status: "enabled", modes: [workMode] } as unknown as Plugin,
      off: {
        status: "disabled",
        modes: [{ ...workMode, id: "off:mode", name: "Disabled" }],
      } as unknown as Plugin,
    },
  })
  render(<EffectivePreviewPanel workspaceId={null} />)
  const modeSelect = screen.getAllByRole("combobox")[1]
  const names = [...modeSelect.querySelectorAll("option")].map((option) => option.textContent)
  expect(names).toEqual(expect.arrayContaining(["Mine", "Work"]))
  expect(names).not.toContain("Disabled")
})
