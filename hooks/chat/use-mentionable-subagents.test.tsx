/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { useMentionableSubagents } from "./use-mentionable-subagents"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

describe("useMentionableSubagents", () => {
  afterEach(() => {
    // Clean up any templates added during a test.
    const { templates, deleteTemplate } = useSubagentRuntimeStore.getState()
    for (const id of Object.keys(templates)) deleteTemplate(id)
  })

  it("includes the host built-ins by default", () => {
    const { result } = renderHook(() => useMentionableSubagents())
    expect(result.current.some((t) => t.id === "workflow-designer")).toBe(true)
  })

  it("re-derives the list when a template is added (reactive)", () => {
    const { result } = renderHook(() => useMentionableSubagents())
    expect(result.current.some((t) => t.handle === "my-helper")).toBe(false)

    act(() => {
      useSubagentRuntimeStore.getState().addTemplate({
        id: "mh-1",
        name: "My Helper",
        description: "helps",
        category: "general",
        taskTemplate: "do {{x}}",
        config: { systemPrompt: "You help." },
        isBuiltIn: false,
      })
    })

    const added = result.current.find((t) => t.id === "template:my-helper")
    expect(added).toBeDefined()
    expect(added?.handle).toBe("my-helper")
  })
})
