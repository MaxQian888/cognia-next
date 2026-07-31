/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}))

import { useLoadingI18n } from "./use-loading-i18n"

describe("useLoadingI18n", () => {
  it("returns localized labels keyed off the 'loading' namespace", () => {
    const { result } = renderHook(() => useLoadingI18n())
    expect(result.current).toMatchObject({
      thinking: "loading.thinking",
      pageLoading: "loading.pageLoading",
      inlineLoading: "loading.loading",
      loading: "loading.loading",
      offline: "loading.offline",
      cancel: "loading.cancel",
      page: {
        title: "loading.page.title",
        description: "loading.page.description",
        progressLabel: "loading.page.progressLabel",
        stages: [
          "loading.page.stages.interface",
          "loading.page.stages.workspace",
          "loading.page.stages.finalizing",
        ],
        reload: "loading.page.reload",
        reloadHint: "loading.page.reloadHint",
      },
    })
  })

  it("passes the elapsed seconds through to the stillWorking message", () => {
    const { result } = renderHook(() => useLoadingI18n())
    expect(result.current.stillWorking(12)).toBe('loading.stillWorking:{"seconds":12}')
  })
})
