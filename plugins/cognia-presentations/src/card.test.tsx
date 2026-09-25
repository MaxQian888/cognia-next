/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

import { createPresentationResultCard, PRESENTATIONS_PLUGIN_ID } from "./card"
import { I18N_MESSAGES } from "./i18n"

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-presentations_create",
    state: "output-available",
    input: {},
    output,
  } as unknown as ToolUIPart
}

beforeAll(() => {
  // What the plugin manager does with plugin.json's `i18n.locales` on enable.
  registerPluginI18n({
    pluginId: PRESENTATIONS_PLUGIN_ID,
    messages: Object.fromEntries(
      Object.entries(I18N_MESSAGES).map(([locale, messages]) => [
        locale,
        Object.fromEntries(
          Object.entries(messages).map(([key, value]) => [
            `plugin.${PRESENTATIONS_PLUGIN_ID}.${key}`,
            value,
          ])
        ),
      ])
    ),
  })
})

afterAll(() => unregisterPluginI18n(PRESENTATIONS_PLUGIN_ID))

describe("PresentationResultCard", () => {
  it("renders deck title, slide count, version, and one set of findings badges", () => {
    const Card = createPresentationResultCard({ openArtifact: jest.fn() })
    render(
      <Card
        part={part({
          ok: true,
          artifactId: "a1",
          version: 3,
          deck: { title: "Launch", slides: [{}, {}] },
          findings: [{ severity: "error" }, { severity: "warning" }, { severity: "warning" }],
        })}
      />
    )
    expect(screen.getByTestId("presentation-result-card")).toBeInTheDocument()
    expect(screen.getByTestId("presentation-result-title")).toHaveTextContent("Launch")
    expect(screen.getByTestId("presentation-result-slides")).toHaveTextContent("Slides: 2")
    expect(screen.getByText("v3")).toBeInTheDocument()
    // Each count appears once — the header no longer repeats the body badge.
    expect(screen.getAllByText("Errors: 1")).toHaveLength(1)
    expect(screen.getAllByText("Warnings: 2")).toHaveLength(1)
    expect(screen.queryByTestId("presentation-result-card-badge")).toBeNull()
  })

  it("invokes the bound open action with a touch-sized button", () => {
    const openArtifact = jest.fn()
    const Card = createPresentationResultCard({ openArtifact })
    render(<Card part={part({ ok: true, artifactId: "a7" })} />)
    const open = screen.getByTestId("presentation-result-open")
    expect(open.className).toContain("h-9")
    expect(open.className).toContain("sm:h-7")
    fireEvent.click(open)
    expect(openArtifact).toHaveBeenCalledWith("a7")
  })

  it("shows the exported size only for a successful export", () => {
    const Card = createPresentationResultCard()
    const { rerender } = render(
      <Card part={part({ ok: true, saved: true, artifactId: "a1", byteLength: 2048 })} />
    )
    expect(screen.getByTestId("presentation-result-exported")).toHaveTextContent("Exported 2.0 KB")

    rerender(
      <Card
        part={part({
          ok: false,
          artifactId: "a1",
          byteLength: 2048,
          requiresConfirmation: true,
        })}
      />
    )
    expect(screen.queryByTestId("presentation-result-exported")).toBeNull()
  })

  it("has no open action when no opener is bound", () => {
    const Card = createPresentationResultCard()
    render(<Card part={part({ ok: true, artifactId: "a1", deck: { slides: [{}] } })} />)
    expect(screen.getByText("Presentation")).toBeInTheDocument()
    expect(screen.queryByTestId("presentation-result-open")).toBeNull()
  })

  it.each([
    ["a cancelled result", { ok: false, cancelled: true }],
    ["an unparseable payload", "not json"],
    ["an empty object", {}],
  ])("renders nothing for %s", (_label, output) => {
    const Card = createPresentationResultCard()
    const { container } = render(<Card part={part(output)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
