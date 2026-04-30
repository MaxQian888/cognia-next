/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import {
  useArtifactDetection,
  detectArtifactType,
  mapToArtifactLanguage,
} from "./use-artifact-detection"

describe("useArtifactDetection", () => {
  it("returns nothing when disabled", () => {
    const { result } = renderHook(() =>
      useArtifactDetection("```js\n" + "a\n".repeat(20) + "```", { enabled: false })
    )
    expect(result.current).toEqual([])
  })

  it("returns nothing for empty content", () => {
    const { result } = renderHook(() => useArtifactDetection(""))
    expect(result.current).toEqual([])
  })

  it("detects long code blocks with the centralized detector", () => {
    const md = "```js\n" + "console.log(1)\n".repeat(15) + "```"
    const { result } = renderHook(() => useArtifactDetection(md))
    expect(result.current.length).toBeGreaterThanOrEqual(1)
    expect(result.current[0].type).toBe("code")
    expect(result.current[0].language).toBe("javascript")
  })

  it("filters out short code blocks under minCodeLength", () => {
    const md = "```js\nfoo\n```"
    const { result } = renderHook(() => useArtifactDetection(md, { minCodeLength: 200 }))
    expect(result.current).toEqual([])
  })

  it("includes math even if shorter than minCodeLength", () => {
    const md = "$$\nx\ny\nz\n$$"
    const { result } = renderHook(() => useArtifactDetection(md, { minCodeLength: 1000 }))
    expect(result.current.some((a) => a.type === "math")).toBe(true)
  })

  it("falls back to extractCodeBlocks for blocks the pipeline didn't already capture", () => {
    // Tiny block (under detector threshold), but bigger than minCodeLength=10.
    const md = "```js\n" + "abcdefghijklmnop\n".repeat(2) + "```"
    const { result } = renderHook(() => useArtifactDetection(md, { minCodeLength: 10 }))
    expect(result.current.length).toBeGreaterThan(0)
  })
})

describe("detectArtifactType helper", () => {
  it("returns 'code' when no language is provided", () => {
    expect(detectArtifactType()).toBe("code")
  })

  it("returns 'react' for tsx", () => {
    expect(detectArtifactType("tsx")).toBe("react")
  })

  it("returns 'document' for markdown", () => {
    expect(detectArtifactType("markdown")).toBe("document")
  })
})

describe("mapToArtifactLanguage", () => {
  it("maps aliases", () => {
    expect(mapToArtifactLanguage("py")).toBe("python")
    expect(mapToArtifactLanguage("ts")).toBe("typescript")
  })
})
