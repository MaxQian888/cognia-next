/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import {
  PLUGIN_SOURCES,
  PluginSourceBadge,
  isDevelopmentSource,
  parsePluginSource,
  shadowedSources,
} from "./plugin-source-badge"

function renderBadge(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

describe("plugin source vocabulary", () => {
  it("every PluginSource member has a label in both locales", () => {
    // `t(source)` is a dynamic key, which `lint:i18n` skips. Adding a member
    // to the union without a label would otherwise render the raw key.
    for (const source of PLUGIN_SOURCES) {
      expect(enMessages.plugins.source[source]).toBeTruthy()
    }
  })

  it("parses a known stored value and rejects an unknown one", () => {
    expect(parsePluginSource("dev")).toBe("dev")
    expect(parsePluginSource("something-new")).toBeNull()
  })

  it("counts dev and local as development origins", () => {
    expect(isDevelopmentSource("dev")).toBe(true)
    expect(isDevelopmentSource("local")).toBe(true)
    expect(isDevelopmentSource("marketplace")).toBe(false)
    expect(isDevelopmentSource("builtin")).toBe(false)
  })
})

describe("shadowedSources", () => {
  it("is empty when the plugin has only ever been seen at one origin", () => {
    expect(shadowedSources("dev", ["dev"])).toEqual([])
    expect(shadowedSources("dev")).toEqual([])
  })

  it("lists the origins this build stands in front of", () => {
    expect(shadowedSources("dev", ["marketplace", "dev"])).toEqual(["marketplace"])
  })

  it("de-duplicates repeated observations", () => {
    expect(shadowedSources("dev", ["marketplace", "marketplace", "dev"])).toEqual(["marketplace"])
  })
})

describe("PluginSourceBadge", () => {
  it("renders the localized label, not the raw enum", () => {
    renderBadge(<PluginSourceBadge source="dev" />)
    expect(screen.getByText(enMessages.plugins.source.dev)).toBeInTheDocument()
    expect(screen.getByTestId("plugin-source-badge-dev")).toBeInTheDocument()
  })

  it("forwards className", () => {
    renderBadge(<PluginSourceBadge source="builtin" className="custom-cls" />)
    expect(screen.getByTestId("plugin-source-badge-builtin")).toHaveClass("custom-cls")
  })

  it("says when this build replaces an installed one", () => {
    // A dev build silently shadowing the marketplace copy is how an author
    // ends up debugging code they are not running.
    renderBadge(<PluginSourceBadge source="dev" observedSources={["marketplace", "dev"]} />)
    const badge = screen.getByTestId("plugin-source-badge-dev")
    expect(badge).toHaveAttribute("data-shadowing", "marketplace")
    expect(badge).toHaveAttribute("title", expect.stringContaining("replaces the installed"))
  })

  it("carries no shadowing marker when nothing is shadowed", () => {
    renderBadge(<PluginSourceBadge source="marketplace" observedSources={["marketplace"]} />)
    expect(screen.getByTestId("plugin-source-badge-marketplace")).not.toHaveAttribute(
      "data-shadowing"
    )
  })

  it("shows an unknown stored value as-is rather than rendering a translation key", () => {
    renderBadge(<PluginSourceBadge source="from-the-future" />)
    const badge = screen.getByTestId("plugin-source-badge-from-the-future")
    expect(badge).toHaveTextContent("from-the-future")
    expect(badge).toHaveAttribute("data-known", "false")
  })
})
