import React from "react"
import { render } from "@testing-library/react"

import { CliI18nProvider } from "../i18n"

import { Banner } from "./Banner"

describe("Banner", () => {
  it("renders the logo, version, provider/model, cwd, and hint", () => {
    const { container } = render(
      <Banner version="1.2.3" provider="anthropic" model="claude-opus-4-8" cwd="/repo/project" />
    )
    const frame = container.textContent ?? ""
    expect(frame).toContain("Cognia Agent")
    expect(frame).toContain("v1.2.3")
    expect(frame).toContain("anthropic")
    expect(frame).toContain("claude-opus-4-8")
    expect(frame).toContain("/repo/project")
    expect(frame).toContain("/help")
    expect(frame).toContain("/settings to configure")
    expect(frame).toContain("/inspect")
  })

  it("omits the model when none is set", () => {
    const { container } = render(<Banner version="1.0.0" provider="openai" cwd="/x" />)
    const frame = container.textContent ?? ""
    expect(frame).toContain("openai")
    expect(frame).not.toContain("claude")
  })

  it("shortens a very long cwd", () => {
    const long =
      "/very/deeply/nested/path/that/keeps/going/and/going/onwards/forever/until/it/is/clearly/over/eighty/characters/project"
    const { container } = render(<Banner version="1" provider="p" cwd={long} />)
    expect(container.textContent ?? "").toContain("…")
  })

  it("omits the live status line when no status is provided (scrollback banner)", () => {
    const { container } = render(<Banner version="1" provider="p" cwd="/x" />)
    expect(container.textContent ?? "").not.toContain("ctx")
    expect(container.textContent ?? "").not.toContain("tok")
  })

  it("renders a live status line (mode / context / tokens) for the fixed header", () => {
    const { container } = render(
      <Banner
        version="1"
        provider="p"
        cwd="/x"
        status={{ mode: "default", contextPct: 42.6, sessionTokens: 12345 }}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("default")
    expect(text).toContain("43% ctx")
    expect(text).toContain("12k tok")
  })

  it("flags bypassPermissions with a warning marker", () => {
    const { container } = render(
      <Banner version="1" provider="p" cwd="/x" status={{ mode: "bypassPermissions" }} />
    )
    expect(container.textContent ?? "").toContain("⚠ bypassPermissions")
  })

  it("renders only the provided status segments", () => {
    const { container } = render(
      <Banner version="1" provider="p" cwd="/x" status={{ contextPct: 10 }} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("10% ctx")
    expect(text).not.toContain("tok")
  })

  it("uses one line at the compact breakpoint and drops nonessential hints", () => {
    const { container } = render(
      <Banner version="1" provider="p" model="m" cwd="/long/path" density="compact" />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Cognia")
    expect(text).toContain("p/m")
    expect(text).not.toContain("/settings")
    expect(text).not.toContain("/long/path")
  })
})

it("renders Chinese welcome hints and status labels", () => {
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <Banner
        version="1"
        provider="pi-rpc"
        cwd="/work"
        status={{ mode: "bypassPermissions", contextPct: 12, sessionTokens: 200 }}
      />
    </CliI18nProvider>
  )
  expect(container.textContent).toContain("/settings 配置")
  expect(container.textContent).toContain("⚠ 跳过权限确认")
  expect(container.textContent).toContain("12% 上下文")
  expect(container.textContent).not.toContain("to configure")
})
