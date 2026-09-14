/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { PresentationResultCard, setPresentationResultBridge } from "./card"
import { translate } from "./i18n"

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-presentations_create",
    state: "output-available",
    input: {},
    output,
  } as unknown as ToolUIPart
}

afterEach(() => setPresentationResultBridge(null))

describe("PresentationResultCard", () => {
  it("renders deck title, slide count, version, and findings badges", () => {
    setPresentationResultBridge({
      t: (key, vars) => translate("en", key, vars),
      openArtifact: jest.fn(),
    })
    render(
      <PresentationResultCard
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
    // "Errors: 1" appears in the header badge and the body badge.
    expect(screen.getAllByText("Errors: 1")).toHaveLength(2)
    expect(screen.getByText("Warnings: 2")).toBeInTheDocument()
    expect(screen.getByTestId("presentation-result-card-badge")).toHaveTextContent("Errors: 1")
  })

  it("invokes the bridge open action for artifact results", () => {
    const openArtifact = jest.fn()
    setPresentationResultBridge({ t: (key, vars) => translate("en", key, vars), openArtifact })
    render(<PresentationResultCard part={part({ ok: true, artifactId: "a7" })} />)
    fireEvent.click(screen.getByTestId("presentation-result-open"))
    expect(openArtifact).toHaveBeenCalledWith("a7")
  })

  it("renders the exported byte size for export results", () => {
    render(<PresentationResultCard part={part({ ok: true, artifactId: "a1", byteLength: 2048 })} />)
    expect(screen.getByTestId("presentation-result-exported")).toHaveTextContent("Exported 2.0 KB")
  })

  it("falls back to the English bundle when no bridge is injected", () => {
    render(
      <PresentationResultCard part={part({ ok: true, artifactId: "a1", deck: { slides: [{}] } })} />
    )
    expect(screen.getByText("Presentation")).toBeInTheDocument()
    expect(screen.getByTestId("presentation-result-slides")).toHaveTextContent("Slides: 1")
    // Without a bridge there is no open action.
    expect(screen.queryByTestId("presentation-result-open")).toBeNull()
  })

  it("uses the injected translator when provided", () => {
    setPresentationResultBridge({
      t: (key, vars) => translate("zh-CN", key, vars),
      openArtifact: jest.fn(),
    })
    render(
      <PresentationResultCard part={part({ ok: true, artifactId: "a1", deck: { slides: [{}] } })} />
    )
    expect(screen.getByText("演示文稿")).toBeInTheDocument()
    expect(screen.getByText("幻灯片：1")).toBeInTheDocument()
  })

  it.each([
    ["a cancelled result", { ok: false, cancelled: true }],
    ["an unparseable payload", "not json"],
    ["an empty object", {}],
  ])("renders nothing for %s", (_label, output) => {
    const { container } = render(<PresentationResultCard part={part(output)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
