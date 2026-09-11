/** @jest-environment jsdom */
import React from "react"
import { render, screen } from "@testing-library/react"
import { CliI18nProvider, createCliTranslator, useCliTranslations } from "./i18n"

function Example() {
  const t = useCliTranslations("cliUiCommon")
  return <span>{t("trustQuestion", { path: "/work" })}</span>
}

it("switches interface language without replacing user text", () => {
  const { rerender } = render(
    <CliI18nProvider locale="en">
      <Example />
    </CliI18nProvider>
  )
  expect(screen.getByText("Do you trust the files in /work?")).toBeTruthy()
  rerender(
    <CliI18nProvider locale="zh-CN">
      <Example />
    </CliI18nProvider>
  )
  expect(screen.getByText("是否信任 /work 中的文件？")).toBeTruthy()
})

it("defaults isolated terminal components to English", () => {
  render(<Example />)
  expect(screen.getByText("Do you trust the files in /work?")).toBeTruthy()
  expect(createCliTranslator("zh-CN", "cliUiCommon")("unknownError")).toBe("未知错误")
})
