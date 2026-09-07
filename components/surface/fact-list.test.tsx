/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { FactList, FactRow } from "./fact-list"

describe("FactRow", () => {
  it("renders the pair as a description list entry", () => {
    render(
      <FactList>
        <FactRow label="Base URL">https://host.example</FactRow>
      </FactList>
    )
    expect(screen.getByText("Base URL")).toBeInTheDocument()
    expect(screen.getByText("https://host.example")).toBeInTheDocument()
  })

  it("breaks a long monospace value instead of truncating it", () => {
    // A fingerprint is exactly the fact someone opened the pane to read, and
    // half of one is not useful.
    render(
      <FactList>
        <FactRow label="Fingerprint" mono>
          abcdef
        </FactRow>
      </FactList>
    )
    expect(screen.getByText("abcdef").className).toContain("break-all")
  })
})

describe("FactList", () => {
  it("sizes its columns off the card container of the pane it was told about", () => {
    // A viewport breakpoint here seats three columns in a 300px card purely
    // because the monitor is wide.
    const { container, rerender } = render(
      <FactList>
        <FactRow label="a">1</FactRow>
      </FactList>
    )
    expect(container.querySelector("dl")?.className).toContain("@sm/console-card:grid-cols-2")

    rerender(
      <FactList pane="device-pane">
        <FactRow label="a">1</FactRow>
      </FactList>
    )
    expect(container.querySelector("dl")?.className).toContain("@sm/device-card:grid-cols-2")
  })
})
