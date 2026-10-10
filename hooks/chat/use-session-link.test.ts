/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"

import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"

import { parseSessionLink, useSessionLink } from "./use-session-link"

describe("parseSessionLink", () => {
  it("reads a session-only link and leaves permalinks to their own consumer", () => {
    expect(parseSessionLink(new URLSearchParams("session=s1"))).toBe("s1")
    expect(parseSessionLink(new URLSearchParams("session=s1&message=m1"))).toBeNull()
    expect(parseSessionLink(new URLSearchParams("session=%20"))).toBeNull()
    expect(parseSessionLink(new URLSearchParams(""))).toBeNull()
    expect(parseSessionLink(null)).toBeNull()
  })
})

describe("useSessionLink", () => {
  let setActiveSession: jest.SpyInstance
  let setActiveProject: jest.SpyInstance

  beforeEach(() => {
    setActiveSession = jest
      .spyOn(useChatStore.getState(), "setActiveSession")
      .mockImplementation(() => undefined as never)
    setActiveProject = jest
      .spyOn(useProjectStore.getState(), "setActiveProject")
      .mockImplementation(() => undefined as never)
  })

  afterEach(() => jest.restoreAllMocks())

  function run(
    search: string,
    lookup: (id: string) => Promise<{ projectId?: string } | undefined>
  ) {
    const callbacks = { onConsumed: jest.fn(), onUnresolved: jest.fn(), onOpened: jest.fn() }
    renderHook(() => useSessionLink({ params: new URLSearchParams(search), lookup, ...callbacks }))
    return callbacks
  }

  it("opens the conversation in its own workspace, then consumes the link", async () => {
    const lookup = jest.fn(async () => ({ projectId: "proj-9" }))
    const callbacks = run("session=s1", lookup)
    await waitFor(() => expect(callbacks.onConsumed).toHaveBeenCalledTimes(1))
    expect(lookup).toHaveBeenCalledWith("s1")
    expect(setActiveProject).toHaveBeenCalledWith("proj-9")
    expect(setActiveSession).toHaveBeenCalledWith("s1")
    expect(callbacks.onOpened).toHaveBeenCalledTimes(1)
    expect(callbacks.onUnresolved).not.toHaveBeenCalled()
  })

  it("says so, and focuses nothing, when the conversation does not exist here", async () => {
    const callbacks = run("session=gone", async () => undefined)
    await waitFor(() => expect(callbacks.onUnresolved).toHaveBeenCalledTimes(1))
    expect(callbacks.onConsumed).toHaveBeenCalledTimes(1)
    expect(setActiveSession).not.toHaveBeenCalled()
    expect(callbacks.onOpened).not.toHaveBeenCalled()
  })

  it("treats a failed lookup like a missing conversation", async () => {
    const callbacks = run("session=s1", async () => {
      throw new Error("db closed")
    })
    await waitFor(() => expect(callbacks.onUnresolved).toHaveBeenCalledTimes(1))
    expect(setActiveSession).not.toHaveBeenCalled()
  })

  it("opens a files link's file once its conversation is focused", async () => {
    const openFiles = jest.fn(async () => "opened" as const)
    const onFilesUnresolved = jest.fn()
    renderHook(() =>
      useSessionLink({
        params: new URLSearchParams("session=s1&view=files&path=%2Fworkspace%2Fa.ts&line=4"),
        lookup: async () => ({ projectId: "p1" }),
        onConsumed: jest.fn(),
        onUnresolved: jest.fn(),
        onFilesUnresolved,
        openFiles,
      })
    )
    await waitFor(() =>
      expect(openFiles).toHaveBeenCalledWith({ sessionId: "s1", path: "/workspace/a.ts", line: 4 })
    )
    expect(setActiveSession).toHaveBeenCalledWith("s1")
    expect(onFilesUnresolved).not.toHaveBeenCalled()
  })

  it("reports a files link whose file could not be shown, after opening the conversation", async () => {
    const onFilesUnresolved = jest.fn()
    renderHook(() =>
      useSessionLink({
        params: new URLSearchParams("session=s1&view=files&path=%2Fuploads%2Fgone.pdf"),
        lookup: async () => ({}),
        onConsumed: jest.fn(),
        onUnresolved: jest.fn(),
        onFilesUnresolved,
        openFiles: async () => "not-found",
      })
    )
    await waitFor(() => expect(onFilesUnresolved).toHaveBeenCalledWith("not-found"))
    expect(setActiveSession).toHaveBeenCalledWith("s1")
  })

  it("opens no files for a conversation that does not exist", async () => {
    const openFiles = jest.fn(async () => "opened" as const)
    const onUnresolved = jest.fn()
    renderHook(() =>
      useSessionLink({
        params: new URLSearchParams("session=gone&view=files"),
        lookup: async () => undefined,
        onConsumed: jest.fn(),
        onUnresolved,
        openFiles,
      })
    )
    await waitFor(() => expect(onUnresolved).toHaveBeenCalled())
    expect(openFiles).not.toHaveBeenCalled()
  })

  it("does nothing for a message permalink or no link", async () => {
    const lookup = jest.fn(async () => ({}))
    run("session=s1&message=m1", lookup)
    run("", lookup)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lookup).not.toHaveBeenCalled()
  })
})
