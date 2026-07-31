/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import {
  PluginRuntimeWarnings,
  PluginStatusPill,
  readPluginRuntimeWarnings,
} from "./plugin-status-badge"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("PluginStatusPill", () => {
  it("renders the error variant when status === 'error'", () => {
    render(<PluginStatusPill status="error" enabled={true} />)
    expect(screen.getByText("error")).toBeInTheDocument()
  })

  it("renders the loading variant when loading=true", () => {
    render(<PluginStatusPill status="enabled" enabled={true} loading />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("renders the disabled variant when enabled=false (and not errored / not loading)", () => {
    render(<PluginStatusPill status="loaded" enabled={false} />)
    expect(screen.getByText("disabled")).toBeInTheDocument()
  })

  it("renders the suspended variant when idle-suspended (status suspended, still enabled)", () => {
    render(<PluginStatusPill status="suspended" enabled={true} />)
    expect(screen.getByText("suspended")).toBeInTheDocument()
  })

  it("renders the enabled variant otherwise", () => {
    render(<PluginStatusPill status="enabled" enabled={true} />)
    expect(screen.getByText("enabled")).toBeInTheDocument()
  })

  it("forwards className to the badge", () => {
    const { container } = render(
      <PluginStatusPill status="enabled" enabled={true} className="custom-x" />
    )
    expect(container.querySelector(".custom-x")).not.toBeNull()
  })
})

describe("readPluginRuntimeWarnings", () => {
  it("returns [] when no warnings field is present", () => {
    expect(readPluginRuntimeWarnings({ manifest: {} })).toEqual([])
  })

  it("returns [] when warnings field is not an array", () => {
    expect(readPluginRuntimeWarnings({ manifest: { _cogniaWarnings: "boom" } })).toEqual([])
  })

  it("filters out non-string entries and returns the rest", () => {
    expect(
      readPluginRuntimeWarnings({
        manifest: { _cogniaWarnings: ["a", 42, null, "b"] },
      })
    ).toEqual(["a", "b"])
  })
})

describe("PluginRuntimeWarnings", () => {
  it("renders nothing when there are no warnings", () => {
    const { container } = render(<PluginRuntimeWarnings plugin={{ manifest: {} }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a chip per declared warning code", () => {
    render(
      <PluginRuntimeWarnings
        plugin={{
          manifest: { _cogniaWarnings: ["python-runtime-unavailable", "other-issue"] },
        }}
      />
    )
    expect(
      screen.getByTestId("plugin-runtime-warning-python-runtime-unavailable")
    ).toBeInTheDocument()
    expect(screen.getByTestId("plugin-runtime-warning-other-issue")).toBeInTheDocument()
  })
})
