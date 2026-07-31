/**
 * @jest-environment jsdom
 */

import type { SubagentMentionTarget } from "@/lib/claude/agents/chat-mention-targets"

const discoverMock = jest.fn<Promise<SubagentMentionTarget[]>, [unknown]>()
jest.mock("@/lib/claude/agents/markdown-mention-targets", () => ({
  discoverMarkdownAgentTargets: (input: unknown) => discoverMock(input),
}))

import { renderHook, waitFor } from "@testing-library/react"
import { useMarkdownChatAgents } from "./use-markdown-chat-agents"
import { useProjectStore } from "@/stores/project/project-store"

beforeEach(() => {
  discoverMock.mockReset()
  useProjectStore.setState({ activeProjectId: null, projects: [] })
})

const target = (id: string): SubagentMentionTarget => ({
  id,
  name: id,
  description: "",
  handle: id,
})

describe("useMarkdownChatAgents", () => {
  it("discovers markdown agents for the cwd and returns them", async () => {
    discoverMock.mockResolvedValue([target("doc-writer")])
    const { result } = renderHook(() => useMarkdownChatAgents("/repo"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe("doc-writer")
    expect(discoverMock).toHaveBeenCalledWith({ cwd: "/repo", roots: [] })
  })

  it("stays empty and skips discovery when disabled", async () => {
    discoverMock.mockResolvedValue([target("x")])
    const { result } = renderHook(() => useMarkdownChatAgents("/repo", false))
    expect(result.current).toEqual([])
    expect(discoverMock).not.toHaveBeenCalled()
  })

  it("swallows discovery errors and yields an empty list", async () => {
    discoverMock.mockRejectedValue(new Error("fs down"))
    const { result } = renderHook(() => useMarkdownChatAgents("/repo"))
    await waitFor(() => expect(discoverMock).toHaveBeenCalled())
    expect(result.current).toEqual([])
  })

  it("normalizes a null cwd to undefined for discovery", async () => {
    discoverMock.mockResolvedValue([])
    renderHook(() => useMarkdownChatAgents(null))
    await waitFor(() => expect(discoverMock).toHaveBeenCalled())
    expect(discoverMock).toHaveBeenCalledWith({ cwd: undefined, roots: [] })
  })

  it("discovers against the active project's roots", async () => {
    useProjectStore.setState({
      activeProjectId: "proj1",
      projects: [{ id: "proj1", roots: [{ path: "/ws", primary: true }] }] as never,
    })
    discoverMock.mockResolvedValue([])
    renderHook(() => useMarkdownChatAgents("/ws"))
    await waitFor(() => expect(discoverMock).toHaveBeenCalled())
    expect(discoverMock.mock.calls[0][0]).toMatchObject({ roots: ["/ws"] })
  })
})
