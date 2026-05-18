/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useWorkflowEditorSession, workflowSessionId } from "./use-workflow-editor-session"
import { useChatStore } from "@/stores/chat"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  useChatStore.getState().setActiveSession(null)
})

describe("workflowSessionId", () => {
  it("emits the deterministic `workflow:` prefix", () => {
    expect(workflowSessionId("wf_a")).toBe("workflow:wf_a")
  })
})

describe("useWorkflowEditorSession", () => {
  it("creates a workflow-editor ChatSession on first mount and pins it", async () => {
    const { result } = renderHook(() => useWorkflowEditorSession("wf_a", "My Workflow"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.sessionId).toBe("workflow:wf_a")
    const row = await getDb().sessions.get("workflow:wf_a")
    expect(row?.kind).toBe("workflow-editor")
    expect(row?.title).toBe("My Workflow — chat")
    expect(useChatStore.getState().activeSessionId).toBe("workflow:wf_a")
  })

  it("reuses an existing row on remount (idempotent)", async () => {
    const first = renderHook(() => useWorkflowEditorSession("wf_a", "Original"))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    const original = await getDb().sessions.get("workflow:wf_a")
    expect(original).toBeDefined()
    first.unmount()
    const second = renderHook(() => useWorkflowEditorSession("wf_a", "Renamed"))
    await waitFor(() => expect(second.result.current.loading).toBe(false))
    // Title is NOT overwritten on remount — only the kind is normalized.
    const after = await getDb().sessions.get("workflow:wf_a")
    expect(after?.title).toBe(original?.title)
  })

  it("restores the previously-active session id on unmount", async () => {
    useChatStore.getState().setActiveSession("preexisting-session")
    const { result, unmount } = renderHook(() => useWorkflowEditorSession("wf_a", "X"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(useChatStore.getState().activeSessionId).toBe("workflow:wf_a")
    unmount()
    expect(useChatStore.getState().activeSessionId).toBe("preexisting-session")
  })

  it("doesn't clobber the active session if the user navigated to a different session mid-mount", async () => {
    const { result, unmount } = renderHook(() => useWorkflowEditorSession("wf_a", "X"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // Simulate the user picking a different session while the editor
    // chat tab was open.
    act(() => useChatStore.getState().setActiveSession("user-picked-session"))
    unmount()
    expect(useChatStore.getState().activeSessionId).toBe("user-picked-session")
  })

  it("returns nulls when workflowId is undefined (no editor open)", () => {
    const { result } = renderHook(() => useWorkflowEditorSession(undefined, undefined))
    expect(result.current.sessionId).toBeNull()
    expect(result.current.session).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it("re-stamps the kind discriminator on a legacy row with the same id", async () => {
    const sid = workflowSessionId("wf_legacy")
    await getDb().sessions.put({
      id: sid,
      title: "Legacy",
      // intentionally missing `kind`
      createdAt: 0,
      updatedAt: 0,
    } as never)
    const { result } = renderHook(() => useWorkflowEditorSession("wf_legacy", "Legacy"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const row = await getDb().sessions.get(sid)
    expect(row?.kind).toBe("workflow-editor")
  })
})
