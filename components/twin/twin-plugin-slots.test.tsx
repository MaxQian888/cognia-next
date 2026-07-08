/**
 * @jest-environment jsdom
 */

// Unit coverage for the four twin-panel plugin extension anchors. Mirrors
// `plugin-extension-slot-coverage.test.tsx`: we drive real registrations
// through `registerMockExtension` and assert each wrapper (a) renders a
// contribution, (b) renders nothing when no plugin occupies the point, and
// (c) forwards its redacted context bag. The static slot audit
// (`pnpm audit:slots`) independently verifies the contract wiring.

import { render, screen } from "@testing-library/react"
import {
  TwinHeaderPluginSlot,
  TwinPersonaPluginSlot,
  TwinSettingsPluginSlot,
  TwinOverviewPluginSlot,
} from "./twin-plugin-slots"
import {
  registerMockExtension,
  clearAllMockExtensions,
} from "@/components/plugins/test-utils/register-mock-extension"

afterEach(() => {
  clearAllMockExtensions()
})

// Reads the host-provided context bag so we can assert exactly what each
// wrapper forwards. `context` is passed by `PluginExtensionSlot` at runtime on
// top of the base `ExtensionProps`.
function ContextProbe(props: {
  pluginId: string
  extensionId: string
  context?: Record<string, unknown>
}) {
  return <span data-testid="ctx">{JSON.stringify(props.context)}</span>
}

describe("twin plugin slots", () => {
  it("renders a header contribution and nothing when empty", () => {
    const empty = render(<TwinHeaderPluginSlot twinId="t1" tab="sources" />)
    expect(empty.container.firstChild).toBeNull()
    empty.unmount()

    registerMockExtension("twin.panel.header", () => <span data-testid="hdr">hi</span>)
    render(<TwinHeaderPluginSlot twinId="t1" tab="sources" />)
    expect(screen.getByTestId("hdr")).toBeInTheDocument()
  })

  it("forwards the header context bag (ids + tab only)", () => {
    registerMockExtension("twin.panel.header", ContextProbe)
    render(<TwinHeaderPluginSlot twinId="t9" tab="persona" />)
    expect(JSON.parse(screen.getByTestId("ctx").textContent ?? "{}")).toEqual({
      twinId: "t9",
      tab: "persona",
    })
  })

  it("renders a persona contribution and forwards the aggregate counts", () => {
    const empty = render(
      <TwinPersonaPluginSlot twinId="t1" entityCount={0} playbookCount={0} styleCount={0} />
    )
    expect(empty.container.firstChild).toBeNull()
    empty.unmount()

    registerMockExtension("twin.persona.panel", ContextProbe)
    render(<TwinPersonaPluginSlot twinId="t7" entityCount={3} playbookCount={2} styleCount={1} />)
    expect(JSON.parse(screen.getByTestId("ctx").textContent ?? "{}")).toEqual({
      twinId: "t7",
      entityCount: 3,
      playbookCount: 2,
      styleCount: 1,
    })
  })

  it("renders a settings contribution and nothing when empty", () => {
    const empty = render(<TwinSettingsPluginSlot twinId="t1" />)
    expect(empty.container.firstChild).toBeNull()
    empty.unmount()

    registerMockExtension("twin.settings.cards", ContextProbe)
    render(<TwinSettingsPluginSlot twinId="t2" />)
    expect(JSON.parse(screen.getByTestId("ctx").textContent ?? "{}")).toEqual({ twinId: "t2" })
  })

  it("renders an overview contribution and forwards source/chunk aggregates", () => {
    const empty = render(<TwinOverviewPluginSlot twinId="t1" sourceCount={0} chunkCount={0} />)
    expect(empty.container.firstChild).toBeNull()
    empty.unmount()

    registerMockExtension("twin.overview.panel", ContextProbe)
    render(<TwinOverviewPluginSlot twinId="t3" sourceCount={12} chunkCount={340} />)
    expect(JSON.parse(screen.getByTestId("ctx").textContent ?? "{}")).toEqual({
      twinId: "t3",
      sourceCount: 12,
      chunkCount: 340,
    })
  })
})
