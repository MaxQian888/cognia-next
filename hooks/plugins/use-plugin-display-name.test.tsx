/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

import { usePluginDisplayName } from "./use-plugin-display-name"

describe("usePluginDisplayName", () => {
  beforeEach(() => {
    usePluginStore.setState({
      plugins: {
        "com.example.web": { manifest: { name: "  Web Tools " } },
        "com.example.blank": { manifest: { name: "" } },
      } as never,
    })
  })

  it("reads the manifest name from the runtime store", () => {
    const { result } = renderHook(() => usePluginDisplayName("com.example.web"))
    expect(result.current).toBe("Web Tools")
  })

  it("falls back to the id for an unknown or unnamed plugin", () => {
    expect(renderHook(() => usePluginDisplayName("com.example.blank")).result.current).toBe(
      "com.example.blank"
    )
    expect(renderHook(() => usePluginDisplayName("nope")).result.current).toBe("nope")
    expect(renderHook(() => usePluginDisplayName(null)).result.current).toBe("")
  })
})
