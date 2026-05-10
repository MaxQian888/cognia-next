/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

import { useLoadingI18n } from "./use-loading-i18n"

describe("useLoadingI18n", () => {
  it("returns localized labels keyed off the 'loading' namespace", () => {
    const { result } = renderHook(() => useLoadingI18n())
    expect(result.current).toEqual({
      thinking: "loading.thinking",
      pageLoading: "loading.pageLoading",
      inlineLoading: "loading.loading",
    })
  })
})
