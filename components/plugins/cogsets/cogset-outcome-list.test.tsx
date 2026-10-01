/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"

import { CogsetOutcomeList } from "./cogset-outcome-list"

describe("CogsetOutcomeList", () => {
  it("lists only the problems, with localized reasons and dependency names", () => {
    render(
      <CogsetOutcomeList
        pluginName={(id) => `name:${id}`}
        outcomes={[
          { pluginId: "ok", action: "enable", ok: true },
          {
            pluginId: "pdf",
            action: "enable",
            ok: false,
            reason: "version-mismatch",
            installedVersion: "1.0.0",
            expectedVersion: "2.0.0",
          },
          {
            pluginId: "writer",
            action: "enable",
            ok: false,
            reason: "dependency-missing",
            dependencyId: "docs",
            dependencyConstraint: "^1",
            optional: true,
          },
          {
            pluginId: "loop",
            action: "enable",
            ok: false,
            reason: "dependency-cycle",
            cycle: ["loop", "back"],
          },
          {
            pluginId: "tool",
            action: "enable",
            ok: false,
            reason: "enable-failed",
            message: "activate() threw",
          },
        ]}
      />
    )
    expect(screen.queryByText("name:ok")).toBeNull()
    expect(screen.getByText("name:pdf")).toBeTruthy()
    expect(
      screen.getByText(
        'reason.version-mismatch:{"installed":"1.0.0","expected":"2.0.0","dependency":"","constraint":"any","found":"","cycle":""}'
      )
    ).toBeTruthy()
    expect(
      screen.getByText(
        'reason.dependency-missing:{"installed":"","expected":"","dependency":"name:docs","constraint":"^1","found":"","cycle":""}'
      )
    ).toBeTruthy()
    expect(
      screen.getByText(
        'reason.dependency-cycle:{"installed":"","expected":"","dependency":"","constraint":"any","found":"","cycle":"name:loop → name:back"}'
      )
    ).toBeTruthy()
    expect(screen.getByText("activate() threw")).toBeTruthy()
    expect(screen.getByText("activation.optional")).toBeTruthy()
  })

  it("renders nothing without problems", () => {
    const { container } = render(
      <CogsetOutcomeList
        pluginName={(id) => id}
        outcomes={[{ pluginId: "a", action: "keep", ok: true }]}
      />
    )
    expect(container.innerHTML).toBe("")
  })
})
