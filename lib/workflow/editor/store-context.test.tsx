import { render, renderHook } from "@testing-library/react"
import { EditorStoreProvider, useEditorStore, useEditorStoreOrNull } from "./store-context"
import type { EditorStore } from "./store"

// Minimal duck-typed `EditorStore` stub — the context only stores the
// reference, so we don't need a real Zustand store here.
const fakeStore = (() => ({})) as unknown as EditorStore

describe("EditorStoreProvider / useEditorStore", () => {
  it("exposes the store via useEditorStore inside the provider", () => {
    const { result } = renderHook(() => useEditorStore(), {
      wrapper: ({ children }) => (
        <EditorStoreProvider store={fakeStore}>{children}</EditorStoreProvider>
      ),
    })
    expect(result.current).toBe(fakeStore)
  })

  it("returns null from useEditorStoreOrNull outside the provider", () => {
    const { result } = renderHook(() => useEditorStoreOrNull())
    expect(result.current).toBeNull()
  })

  it("throws from useEditorStore when no provider is mounted", () => {
    // jsdom + React 19 surfaces hook errors via the rendered tree; suppress
    // the noisy console output and assert on the thrown error directly.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    function Probe(): null {
      useEditorStore()
      return null
    }
    expect(() => render(<Probe />)).toThrow(
      /useEditorStore must be used inside <EditorStoreProvider>/
    )
    spy.mockRestore()
  })
})
