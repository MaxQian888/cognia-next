import { renderHook } from "@testing-library/react"
import {
  getContextWorkbenchWindowScope,
  useContextWorkbenchInstanceId,
} from "./use-context-workbench-instance-id"

describe("useContextWorkbenchInstanceId", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it("keeps a browser window and host scope stable across remounts", () => {
    const firstScope = getContextWorkbenchWindowScope()
    expect(getContextWorkbenchWindowScope()).toBe(firstScope)
    const first = renderHook(() => useContextWorkbenchInstanceId("canvas")).result.current
    const second = renderHook(() => useContextWorkbenchInstanceId("canvas")).result.current
    expect(first).toContain(firstScope)
    expect(second).toContain(firstScope)
    expect(second).toBe(first)
    expect(renderHook(() => useContextWorkbenchInstanceId("artifact")).result.current).not.toBe(
      first
    )
  })

  it("uses the stable Tauri window label instead of shared web storage", () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "project-a" } },
    }
    expect(getContextWorkbenchWindowScope()).toBe("tauri:project-a")
  })

  it("prefers a Tauri webview label when both labels are present", () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: {
        currentWebview: { label: "webview-a" },
        currentWindow: { label: "window-a" },
      },
    }
    expect(getContextWorkbenchWindowScope()).toBe("tauri:webview-a")
  })
})
