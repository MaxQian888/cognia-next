/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import en from "@/i18n/messages/en.json"
import type {
  InstalledRuntime,
  RuntimeResolution,
} from "@/lib/ai/agent/external/installed-runtimes"

import { RuntimeDetectionBadge } from "./runtime-detection-badge"

const labels = en.externalAgent as unknown as Record<string, string>

// `app/layout.tsx` mounts the provider app-wide; a unit render has to supply
// its own or every tooltip trigger throws on the missing context.
const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

function detected(overrides: Partial<InstalledRuntime> = {}): InstalledRuntime {
  return {
    runtimeId: "codex-app-server",
    command: "codex",
    resolution: "installed",
    executablePath: "/opt/homebrew/bin/codex",
    version: "0.48.1",
    detail: null,
    ...overrides,
  }
}

describe("RuntimeDetectionBadge", () => {
  const cases: Array<{ resolution: RuntimeResolution; labelKey: string }> = [
    { resolution: "installed", labelKey: "detectionInstalled" },
    { resolution: "missing", labelKey: "detectionMissing" },
    { resolution: "package-runner", labelKey: "detectionPackageRunner" },
    { resolution: "not-local", labelKey: "detectionNotLocal" },
  ]

  it.each(cases)("renders the translated label for $resolution", ({ resolution, labelKey }) => {
    render(wrap(<RuntimeDetectionBadge detection={detected({ resolution })} />))
    expect(screen.getByText(labels[labelKey])).toBeInTheDocument()
  })

  it("renders nothing at all when nothing is known", () => {
    // The state that matters most. An unknown answer drawn as a neutral badge
    // reads as "we checked", and the user acts on a check that never happened.
    const { container } = render(wrap(<RuntimeDetectionBadge detection={undefined} />))
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the version only when asked and only when one was read", () => {
    render(wrap(<RuntimeDetectionBadge detection={detected()} showVersion />))
    expect(screen.getByText(/0\.48\.1/)).toBeInTheDocument()
  })

  it("falls back to the plain label when the version could not be read", () => {
    render(wrap(<RuntimeDetectionBadge detection={detected({ version: null })} showVersion />))
    expect(screen.getByText(labels.detectionInstalled)).toBeInTheDocument()
  })

  it("never calls a runtime installed just because a version came with it", () => {
    // `versionOutput` is allowed on every row of the wire shape, so a host that
    // reports the last-fetched version of a package-runner runtime must not
    // flip this badge into the one label that claims the binary is here.
    render(
      wrap(
        <RuntimeDetectionBadge
          detection={detected({ resolution: "package-runner", version: "1.2.3" })}
          showVersion
        />
      )
    )
    expect(screen.getByText(labels.detectionPackageRunner)).toBeInTheDocument()
    expect(screen.queryByText(/1\.2\.3/)).toBeNull()
  })

  it("carries the resolved path so two same-named binaries are tellable apart", () => {
    const { container } = render(wrap(<RuntimeDetectionBadge detection={detected()} />))
    expect(container.querySelector('[data-detection="installed"]')).not.toBeNull()
    expect(screen.getByText(labels.detectionInstalled)).toBeInTheDocument()
  })
})
