/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { appSettingPromptAdapter } from "@/lib/prompts/adapters/app-settings"
import { publishPromptBody } from "@/lib/prompts/service"
import { invalidatePromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePromptResources } from "./use-prompt-resources"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
  useCustomModeStore.setState({ customModes: {} })
})
afterAll(dbFixture.dispose)
afterEach(() => jest.restoreAllMocks())

const ctx = {}

it("lists resources and refreshes after a publish", async () => {
  const { result } = renderHook(() => usePromptResources(ctx))
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  const brief = () =>
    result.current.state.listing?.resources.find((entry) => entry.promptId === BRIEF_MODE_PROMPT.id)
  expect(brief()?.modified).toBe(false)

  await act(async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: { scope: "account", targetId: "" },
      body: "Short.",
      expectedRev: 0,
    })
  })
  await waitFor(() => expect(brief()?.modified).toBe(true))
})

it("picks up a new custom mode from its store", async () => {
  const { result } = renderHook(() => usePromptResources(ctx))
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  act(() => {
    useCustomModeStore.getState().createMode({ name: "Mine", systemPrompt: "x" })
  })
  await waitFor(() =>
    expect(
      result.current.state.listing?.resources.some((entry) => entry.source === "custom-mode")
    ).toBe(true)
  )
})

it("reports owners that failed without dropping the rest", async () => {
  jest.spyOn(appSettingPromptAdapter, "list").mockRejectedValue(new Error("boom"))
  const { result } = renderHook(() => usePromptResources(ctx))
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  expect(result.current.state.listing?.failed).toEqual(["app-setting"])
})

it("names the context a ready listing was read for", async () => {
  const { result } = renderHook(() => usePromptResources(ctx))
  await waitFor(() => expect(result.current.state.status).toBe("ready"))
  const state = result.current.state
  expect(state.status === "ready" && state.context).toBe(ctx)
})
