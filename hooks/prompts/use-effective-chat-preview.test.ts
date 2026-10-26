/** @jest-environment jsdom */

import "fake-indexeddb/auto"

jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => true),
}))
const mockLoadInstructions = jest.fn()
jest.mock("@/lib/claude/instructions/load", () => ({
  loadProjectInstructions: (...args: unknown[]) => mockLoadInstructions(...args),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { BUILT_IN_MODE_PROMPTS } from "@/lib/agent/modes/built-ins"
import { createCharacter } from "@/lib/db/characters"
import { createSkill } from "@/lib/db/skills"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { publishPromptBody } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { Plugin } from "@/types/plugin"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { useEffectiveChatPreview } from "./use-effective-chat-preview"

const setTauri = (value: boolean) => jest.mocked(isTauri).mockReturnValue(value)

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  setTauri(true)
  mockLoadInstructions.mockReset()
  mockLoadInstructions.mockResolvedValue({ section: "## Project instructions\n\nUse pnpm." })
  useCustomModeStore.setState({ customModes: {} })
  usePluginStore.setState({ plugins: {} })
  useProjectStore.setState({
    projects: [
      { id: "ws-1", name: "Repo", customInstructions: "Small diffs.", roots: [{ path: "/repo" }] },
    ],
  } as never)
  await useSettingsStore.getState().retryLoad()
})
afterAll(dbFixture.dispose)

const [modeId, modeDef] = [...BUILT_IN_MODE_PROMPTS.entries()][0]

it("previews a new chat with the agent, mode and workspace", async () => {
  const skill = await createSkill({ name: "Cite sources", content: "x" })
  const agent = await createCharacter({
    name: "Ada",
    systemPrompt: "You are Ada.",
    persona: { tone: "warm" },
    skillIds: [skill.id],
  })
  const { result } = renderHook(() =>
    useEffectiveChatPreview({ agentId: agent.id, modeId, workspaceId: "ws-1" })
  )
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  const preview = result.current.state.status === "ready" ? result.current.state.preview : null
  expect(preview?.segments.map((segment) => segment.kind)).toEqual([
    "base",
    "persona",
    "instructions",
    "workspace",
    "mode",
    "skills",
  ])
  expect(preview?.segments[0]).toMatchObject({
    text: "You are Ada.",
    baseSource: "character",
    label: "Ada",
  })
  expect(preview?.segments[4].text).toBe(modeDef.defaultBody)
  expect(preview?.segments[5].items).toEqual(["Cite sources"])
  expect(mockLoadInstructions).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: "/repo", roots: ["/repo"] })
  )
})

it("shows the mode text a workspace override publishes", async () => {
  await publishPromptBody({
    def: modeDef,
    target: { scope: "workspace", targetId: "ws-1" },
    body: "Workspace mode.",
    expectedRev: 0,
  })
  const { result } = renderHook(() =>
    useEffectiveChatPreview({ agentId: null, modeId, workspaceId: "ws-1" })
  )
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  const preview = result.current.state.status === "ready" ? result.current.state.preview : null
  expect(preview?.segments.find((segment) => segment.kind === "mode")?.text).toBe("Workspace mode.")
})

it("uses a custom mode's own text and the app default without an agent", async () => {
  await useSettingsStore.getState().save({ defaultSystemPrompt: "Default." })
  const mode = useCustomModeStore.getState().createMode({ name: "Mine", systemPrompt: "Custom." })
  const { result } = renderHook(() =>
    useEffectiveChatPreview({ agentId: null, modeId: mode.id, workspaceId: null })
  )
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  const preview = result.current.state.status === "ready" ? result.current.state.preview : null
  expect(preview?.segments[0]).toMatchObject({ baseSource: "app-default", text: "Default." })
  expect(preview?.segments.find((segment) => segment.kind === "mode")).toMatchObject({
    label: "Mine",
    text: "Custom.",
  })
})

it("uses an enabled plugin's contributed mode", async () => {
  usePluginStore.setState({
    plugins: {
      work: {
        status: "enabled",
        modes: [
          {
            id: "work:work",
            type: "custom",
            name: "Work",
            description: "",
            icon: "Bot",
            systemPrompt: "You are in WORK MODE.",
          },
        ],
      } as unknown as Plugin,
    },
  })
  const { result } = renderHook(() =>
    useEffectiveChatPreview({ agentId: null, modeId: "work:work", workspaceId: null })
  )
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  const preview = result.current.state.status === "ready" ? result.current.state.preview : null
  expect(preview?.segments.find((segment) => segment.kind === "mode")).toMatchObject({
    label: "Work",
    text: "You are in WORK MODE.",
  })
})

it("names why instruction files are absent", async () => {
  setTauri(false)
  const { result, rerender } = renderHook(
    ({ agentId }: { agentId: string | null }) =>
      useEffectiveChatPreview({ agentId, modeId: null, workspaceId: "ws-1" }),
    { initialProps: { agentId: null as string | null } }
  )
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  const omitted = () =>
    result.current.state.status === "ready" ? result.current.state.preview.omitted : []
  expect(omitted()).toContainEqual({ kind: "instructions", reason: "no-filesystem" })

  setTauri(true)
  const bare = await createCharacter({ name: "Bare", systemPrompt: "x", bareMode: true })
  rerender({ agentId: bare.id })
  await waitFor(() =>
    expect(omitted()).toContainEqual({ kind: "instructions", reason: "bare-mode" })
  )

  mockLoadInstructions.mockRejectedValue(new Error("io"))
  rerender({ agentId: null })
  act(() => result.current.reload())
  await waitFor(() =>
    expect(omitted()).toContainEqual({ kind: "instructions", reason: "load-failed" })
  )
})
