/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  canUseTauriInvoke: () => false,
}))

import { renderHook } from "@testing-library/react"

import { usePluginIconSrc } from "./use-plugin-icon-src"

describe("usePluginIconSrc", () => {
  it("renders a directly loadable icon without touching Tauri", () => {
    const { result } = renderHook(() =>
      usePluginIconSrc({
        kind: "image",
        src: "data:image/png;base64,AA",
        original: "data:image/png;base64,AA",
        transport: "inline",
      })
    )
    expect(result.current).toEqual({ kind: "image", src: "data:image/png;base64,AA" })
  })

  // A `file` transport needs the asset protocol, which a browser build does
  // not have. Falling back beats rendering a broken image.
  it("falls back for a file icon off the desktop shell", () => {
    const { result } = renderHook(() =>
      usePluginIconSrc({
        kind: "image",
        src: "/plugins/a/icon.png",
        original: "icon.png",
        transport: "file",
      })
    )
    expect(result.current).toBeNull()
  })

  it("is null without an icon", () => {
    const { result } = renderHook(() => usePluginIconSrc(undefined))
    expect(result.current).toBeNull()
  })
})
