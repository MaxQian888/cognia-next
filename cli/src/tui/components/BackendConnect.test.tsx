import { CliI18nProvider } from "../i18n"
import React from "react"
import { render } from "@testing-library/react"
import { __resetInk } from "ink"

import { BackendConnect } from "./BackendConnect"
import type { BackendConnectStage } from "../runtime/backend-controller"

function renderLine(backend: string, stage: BackendConnectStage) {
  const { container } = render(<BackendConnect backend={backend} stage={stage} />)
  return container.textContent ?? ""
}

describe("BackendConnect", () => {
  beforeEach(() => __resetInk())

  it("names the backend being started, not the built-in provider", () => {
    expect(renderLine("codex", "launch")).toContain("starting codex")
  })

  it.each([
    ["preset", "resolving agent"],
    ["sandbox", "checking sandbox"],
    ["command", "locating executable"],
    ["launch", "starting agent"],
  ] as const)("labels the %s stage", (stage, label) => {
    // The stage name is also what the failure page points at, so it has to be
    // something the user actually saw go by.
    expect(renderLine("claude-code", stage)).toContain(label)
  })
})

it("renders Chinese startup copy and preserves technical content", () => {
  __resetInk()
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <BackendConnect backend="codex" stage="sandbox" />
    </CliI18nProvider>
  )
  expect(container.textContent).toContain("检查沙箱")
  expect(container.textContent).toContain("codex")
})
