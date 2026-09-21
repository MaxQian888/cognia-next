/** @jest-environment jsdom */

// The body preview is the load-bearing visual: tokens as chips, code left
// alone, three states (empty/filled/unresolved) readable at a glance.

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    params ? `${key}:${params.id}` : key,
}))

import { ChatTemplateBodyPreview } from "./body-preview"

describe("ChatTemplateBodyPreview", () => {
  it("renders tokens as chips and prose as text", () => {
    render(<ChatTemplateBodyPreview body="review {{module}} on {{branch}}" />)

    expect(screen.getByText("{{module}}")).toBeInTheDocument()
    expect(screen.getByText("{{branch}}")).toBeInTheDocument()
    expect(screen.getByText(/review/)).toBeInTheDocument()
  })

  it("leaves tokens inside code spans literal — they are not slots", () => {
    render(
      <ChatTemplateBodyPreview
        body="run `pnpm {{script}}` then {{report}}"
        onParamClick={() => {}}
      />
    )

    // The backticked token stays part of the prose — no chip, no button.
    expect(screen.getByText(/pnpm \{\{script\}\}/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "fillSlot:script" })).toBeNull()
    // The real slot became a clickable chip.
    expect(screen.getByRole("button", { name: "fillSlot:report" })).toBeInTheDocument()
  })

  it("shows the substituted value for a filled slot", () => {
    render(
      <ChatTemplateBodyPreview
        body="review {{module}}"
        values={{ module: { kind: "text", value: "composer" } }}
      />
    )
    expect(screen.getByText("composer")).toBeInTheDocument()
    expect(screen.queryByText("{{module}}")).toBeNull()
  })

  it("fires onParamClick with the token id when a chip is clicked", () => {
    const onParamClick = jest.fn()
    render(<ChatTemplateBodyPreview body="review {{module}}" onParamClick={onParamClick} />)

    fireEvent.click(screen.getByRole("button", { name: "fillSlot:module" }))
    expect(onParamClick).toHaveBeenCalledWith("module")
  })

  it("reads in the composer's pill language: dashed empty, primary filled, amber unresolved", () => {
    render(
      <ChatTemplateBodyPreview
        body="review {{module}} explain {{file}} ping {{who}}"
        values={{
          module: { kind: "text", value: "composer" },
          file: {
            kind: "resource",
            resourceKind: "file",
            id: "gone.ts",
            label: "gone.ts",
          },
        }}
        isResolvable={() => false}
      />
    )
    expect(screen.getByText("{{who}}").className).toContain("border-dashed")
    expect(screen.getByText("composer").className).toContain("bg-primary/10")
    expect(screen.getByText("gone.ts").className).toContain("ring-amber-500/40")
  })

  it("marks an unresolved resource value rather than dropping it", () => {
    render(
      <ChatTemplateBodyPreview
        body="explain {{file}}"
        values={{
          file: {
            kind: "resource",
            resourceKind: "file",
            id: "gone.ts",
            label: "gone.ts",
          },
        }}
        isResolvable={() => false}
      />
    )
    const chip = screen.getByText("gone.ts")
    expect(chip.className).toContain("ring-amber-500/40")
  })
})
