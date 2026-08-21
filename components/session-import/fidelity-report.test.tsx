/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { FidelityReport } from "./fidelity-report"
import en from "@/i18n/messages/en.json"
import type { SessionLossReport } from "@cognia/agent-config-types/canonical-session"

const renderReport = (loss: SessionLossReport, reverseFidelity?: SessionLossReport["fidelity"]) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <FidelityReport loss={loss} reverseFidelity={reverseFidelity} />
    </NextIntlClientProvider>
  )

describe("FidelityReport", () => {
  it("shows the fidelity badge, its meaning, and a lossless state", () => {
    renderReport({ fidelity: "structured", losses: [] })
    expect(screen.getByTestId("fidelity-badge")).toHaveTextContent("Structured")
    expect(screen.getByText(/Text and tool history carry over/)).toBeInTheDocument()
    expect(screen.getByTestId("no-losses")).toHaveTextContent("Converted without loss.")
    expect(screen.queryByTestId("rebuilt-badge")).not.toBeInTheDocument()
  })

  it("lists every loss entry by kind with its path and detail", () => {
    renderReport({
      fidelity: "contextual",
      losses: [
        { path: "turns[1].reasoning", kind: "dropped", detail: "thinking is runtime-private" },
        { path: "nested", kind: "summarized" },
      ],
    })
    expect(screen.getByTestId("loss-count")).toHaveTextContent("2 items were not carried over")
    expect(screen.getByText("turns[1].reasoning")).toBeInTheDocument()
    expect(screen.getByText(/Dropped: thinking is runtime-private/)).toBeInTheDocument()
    expect(screen.getByText(/Summarized/)).toBeInTheDocument()
  })

  it("marks rebuilt records with provenance and never dresses up unsupported", () => {
    renderReport({ fidelity: "unsupported", losses: [], rebuilt: true })
    expect(screen.getByTestId("fidelity-badge")).toHaveTextContent("Unsupported")
    expect(screen.getByTestId("rebuilt-badge")).toHaveTextContent("Reconstructed")
    expect(screen.getByText(/does not claim to be the original/)).toBeInTheDocument()
    expect(screen.getByText(/not supported for this source/)).toBeInTheDocument()
  })

  it("labels the reverse direction as defined-but-unavailable", () => {
    // Working Rule 7's UI axis for `SessionCodec.materialize`: the capability is
    // declared by the claude-code and pi codecs and called by nothing outside
    // the conformance suite, so the report says so instead of staying silent.
    renderReport({ fidelity: "structured", losses: [] }, "contextual")
    expect(screen.getByTestId("reverse-dormant")).toBeInTheDocument()
  })

  it("says nothing about a reverse direction for an import-only source", () => {
    renderReport({ fidelity: "structured", losses: [] })
    expect(screen.queryByTestId("reverse-dormant")).toBeNull()
  })
})
