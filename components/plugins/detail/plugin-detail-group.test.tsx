/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import {
  PluginDetailGroup,
  PluginDetailNone,
  PluginMetaList,
  PluginMetaRow,
} from "./plugin-detail-group"

describe("PluginDetailGroup", () => {
  it("labels the group and renders its body", () => {
    render(
      <PluginDetailGroup title="README" testId="group">
        <p>body</p>
      </PluginDetailGroup>
    )
    expect(screen.getByRole("heading", { name: "README" })).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
  })

  it("renders flat rather than as a card, so nested panes do not stack borders", () => {
    render(
      <PluginDetailGroup title="Keywords" testId="group">
        <span>chips</span>
      </PluginDetailGroup>
    )
    const group = screen.getByTestId("group")
    // The card look was the thing being removed. A group separates with a
    // single top hairline and no radius or shadow of its own.
    expect(group.className).toContain("border-t")
    expect(group.className).not.toContain("rounded")
    expect(group.className).not.toContain("shadow")
  })

  it("puts actions at the end of the title row", () => {
    render(
      <PluginDetailGroup title="Data" actions={<button type="button">refresh</button>}>
        <span>rows</span>
      </PluginDetailGroup>
    )
    expect(screen.getByRole("button", { name: "refresh" })).toBeInTheDocument()
  })
})

describe("PluginMetaRow", () => {
  it("pairs each label with its value", () => {
    render(
      <PluginMetaList>
        <PluginMetaRow label="ID" value="cognia-arknights-theme" mono />
      </PluginMetaList>
    )
    expect(screen.getByText("ID")).toBeInTheDocument()
    const value = screen.getByText("cognia-arknights-theme")
    expect(value).toHaveClass("font-mono")
    // Long ids must wrap inside the pane instead of widening it.
    expect(value.className).toContain("break-all")
  })

  it("drops the mono face for prose values", () => {
    render(
      <PluginMetaList>
        <PluginMetaRow label="Type" value="frontend" />
      </PluginMetaList>
    )
    expect(screen.getByText("frontend")).not.toHaveClass("font-mono")
  })
})

describe("PluginDetailNone", () => {
  it("states the absence and can add a hint", () => {
    render(<PluginDetailNone message="No settings" hint="Nothing to configure" testId="none" />)
    expect(screen.getByTestId("none")).toBeInTheDocument()
    expect(screen.getByText("No settings")).toBeInTheDocument()
    expect(screen.getByText("Nothing to configure")).toBeInTheDocument()
  })

  it("omits the hint line when there is no hint", () => {
    render(<PluginDetailNone message="No settings" testId="none" />)
    expect(screen.getByTestId("none").querySelectorAll("p")).toHaveLength(1)
  })
})
