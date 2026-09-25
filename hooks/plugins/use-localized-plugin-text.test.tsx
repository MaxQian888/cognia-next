import { renderHook } from "@testing-library/react"

import { localizePluginText, useLocalizedPluginText } from "./use-localized-plugin-text"

const manifest = {
  name: "Clipboard History",
  description: "Keep recent entries.",
  nameKey: "manifest.name",
  descriptionKey: "manifest.description",
  i18n: {
    locales: {
      en: { "manifest.name": "Clipboard History", "manifest.description": "Keep recent entries." },
      "zh-CN": { "manifest.name": "剪贴板历史", "manifest.description": "保存最近的剪贴板条目。" },
    },
  },
}

describe("useLocalizedPluginText", () => {
  it("shows a plugin row's name and description in the user's locale", () => {
    // next-intl is mocked globally (jest.setup.ts) with an "en" locale.
    jest
      .spyOn(jest.requireMock<typeof import("next-intl")>("next-intl"), "useLocale")
      .mockReturnValue("zh-CN")
    const { result } = renderHook(() =>
      useLocalizedPluginText({ name: "Clipboard History", manifest })
    )
    expect(result.current).toEqual({ name: "剪贴板历史", description: "保存最近的剪贴板条目。" })
  })

  it("keeps the row's literal name when the manifest has no key", () => {
    expect(localizePluginText({ name: "Row name", manifest: {} }, "zh-CN")).toEqual({
      name: "Row name",
      description: "",
    })
  })
})
