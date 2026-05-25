/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { useLocale } from "next-intl"
import { usePluginT } from "./use-plugin-t"

jest.mock("next-intl", () => ({ useLocale: jest.fn() }))

const mockLocale = useLocale as jest.Mock

describe("usePluginT", () => {
  it("resolves keys in the active locale with the plugin prefix", () => {
    mockLocale.mockReturnValue("zh-CN")
    const { result } = renderHook(() => usePluginT())
    expect(result.current("review.title")).toBe("知乎流水线 — 审阅")
  })

  it("uses English for the en locale", () => {
    mockLocale.mockReturnValue("en")
    const { result } = renderHook(() => usePluginT())
    expect(result.current("review.title")).toBe("Zhihu Pipeline — Review")
  })

  it("interpolates {vars}", () => {
    mockLocale.mockReturnValue("zh-CN")
    const { result } = renderHook(() => usePluginT())
    expect(result.current("review.startWritingAria", { title: "X" })).toBe("开始写作：X")
  })

  it("falls back to English for an unknown locale and to the raw key for an unknown key", () => {
    mockLocale.mockReturnValue("fr")
    const { result } = renderHook(() => usePluginT())
    expect(result.current("review.title")).toBe("Zhihu Pipeline — Review")
    expect(result.current("nope.key")).toBe("nope.key")
  })
})
