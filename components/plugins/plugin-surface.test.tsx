/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PluginSurface } from "./plugin-surface"
import type { PluginSurfaceFormFactor } from "@/types/plugin/plugin-surface"
import { recordPluginPointDiagnostic } from "@/lib/plugin/contracts/diagnostics-store"
import { trackPluginEvent } from "@/lib/plugin/utils/analytics"

jest.mock("@/lib/plugin/contracts/diagnostics-store", () => ({
  recordPluginPointDiagnostic: jest.fn(),
}))

jest.mock("@/lib/plugin/utils/analytics", () => ({
  trackPluginEvent: jest.fn(),
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: (
    selector: (state: { plugins: Record<string, { manifest: { name: string } }> }) => unknown
  ) =>
    selector({
      plugins: {
        "acme.reference": { manifest: { name: "Manifest Reference" } },
      },
    }),
}))

const formFactors: PluginSurfaceFormFactor[] = ["icon", "row", "block", "panel"]

function Boom({ enabled = true }: { enabled?: boolean }) {
  if (enabled) throw new Error("reference crash")
  return <span>recovered content</span>
}

describe("PluginSurface", () => {
  it("uses phrasing content and a host fallback for inline failures", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const { container } = render(
      <p>
        <PluginSurface
          pluginId="acme.reference"
          surfaceId="inline"
          formFactor="row"
          inline
          fallback={<a href="https://example.com">Original link</a>}
        >
          <Boom />
        </PluginSurface>
      </p>
    )
    const link = screen.getByRole("link", { name: "Original link" })
    expect(link.parentElement?.tagName).toBe("SPAN")
    expect(link.parentElement).toHaveStyle({ display: "contents" })
    expect(container.querySelector("p div")).toBeNull()
    await waitFor(() => expect(recordPluginPointDiagnostic).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each(formFactors)("renders healthy %s content inside the plugin scope root", (formFactor) => {
    const { container } = render(
      <PluginSurface
        pluginId="acme.reference"
        surfaceId={`surface-${formFactor}`}
        formFactor={formFactor}
      >
        <span>healthy content</span>
      </PluginSurface>
    )

    const root = container.querySelector<HTMLElement>('[data-plugin-root="acme.reference"]')
    expect(root).toContainElement(screen.getByText("healthy content"))
    expect(root).toHaveAttribute("data-plugin-surface", `surface-${formFactor}`)
    expect(root).toHaveAttribute("data-plugin-form-factor", formFactor)
  })

  it.each(["icon", "row"] satisfies PluginSurfaceFormFactor[])(
    "silently removes a crashed %s surface while reporting it",
    async (formFactor) => {
      const onSilentFailure = jest.fn()
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      const { container } = render(
        <PluginSurface
          pluginId="acme.reference"
          surfaceId={`surface-${formFactor}`}
          formFactor={formFactor}
          onSilentFailure={onSilentFailure}
        >
          <Boom />
        </PluginSurface>
      )

      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(container.querySelector('[data-plugin-root="acme.reference"]')).toBeEmptyDOMElement()
      expect(onSilentFailure).toHaveBeenCalledTimes(1)
      await waitFor(() => {
        expect(recordPluginPointDiagnostic).toHaveBeenCalledWith(
          "acme.reference",
          expect.objectContaining({
            code: "plugin.silent-failure",
            pointId: `surface-${formFactor}`,
            message: `Plugin surface "surface-${formFactor}" crashed while rendering: reference crash`,
            hint: "The failed compact contribution was removed without affecting the surrounding UI.",
          })
        )
        expect(trackPluginEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            pluginId: "acme.reference",
            eventType: "error",
            success: false,
          })
        )
      })
      errorSpy.mockRestore()
    }
  )

  it.each(["block", "panel"] satisfies PluginSurfaceFormFactor[])(
    "renders an inline diagnostic for a crashed %s surface and retries successfully",
    async (formFactor) => {
      let shouldThrow = true
      const Recoverable = () => <Boom enabled={shouldThrow} />
      const onSilentFailure = jest.fn()
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      render(
        <PluginSurface
          pluginId="acme.reference"
          pluginName="Reference Plugin"
          surfaceId={`surface-${formFactor}`}
          formFactor={formFactor}
          onSilentFailure={onSilentFailure}
        >
          <Recoverable />
        </PluginSurface>
      )

      expect(screen.getByRole("alert")).toHaveTextContent("Reference Plugin")
      expect(screen.getByRole("alert")).toHaveTextContent("reference crash")
      // A visible retryable card means the contribution is still present — the
      // silent-removal signal must not fire.
      expect(onSilentFailure).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(recordPluginPointDiagnostic).toHaveBeenCalledWith(
          "acme.reference",
          expect.objectContaining({
            hint: "Retry the surface. If it fails again, inspect the plugin component and diagnostics.",
          })
        )
      )
      shouldThrow = false
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
      expect(await screen.findByText("recovered content")).toBeInTheDocument()
      errorSpy.mockRestore()
    }
  )

  it("uses the registered manifest name when a host omits pluginName", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    render(
      <PluginSurface pluginId="acme.reference" surfaceId="panel" formFactor="panel">
        <Boom />
      </PluginSurface>
    )

    expect(screen.getByRole("alert")).toHaveTextContent("Manifest Reference")
    errorSpy.mockRestore()
  })

  it("stays a query container without width hints and clamps declared hints", () => {
    const { container, rerender } = render(
      <PluginSurface pluginId="acme.reference" surfaceId="slot" formFactor="row">
        <span>content</span>
      </PluginSurface>
    )
    const root = () => container.querySelector<HTMLElement>('[data-plugin-root="acme.reference"]')!

    // A hint-less slot still needs a principal box: `container-type` is inert on
    // `display: contents`, so a plugin's `@container` rules would never match.
    expect(root().style.display).toBe("block")
    expect(root().style.containerType).toBe("inline-size")
    expect(root().style.minWidth).toBe("")
    expect(root().style.maxWidth).toBe("")
    // Containment hides the contents from layout, so a flex row collapses
    // this box to 0px; clipping keeps them from painting over the next host
    // control instead of fixing the width (nothing was declared).
    expect(root().style.overflow).toBe("hidden")
    rerender(
      <PluginSurface
        pluginId="acme.reference"
        surfaceId="slot"
        formFactor="row"
        minWidth={320}
        maxWidth={640}
      >
        <span>content</span>
      </PluginSurface>
    )
    expect(root().style.display).toBe("block")
    expect(root().style.containerType).toBe("inline-size")
    // `flex-basis` is the width source a flex row can honour — the same
    // containment collapse resolves the min/max percentages to 0.
    expect(root().style.flexBasis).toBe("320px")
    expect(root().style.minWidth).toBe("min(320px, 100%)")
    expect(root().style.maxWidth).toBe("min(640px, 100%)")
    expect(root().style.overflow).toBe("hidden")
  })

  it("supports one-sided width hints and reuses cached styles", () => {
    const { container, rerender } = render(
      <PluginSurface pluginId="acme.reference" surfaceId="slot" formFactor="row" maxWidth={240}>
        <span>content</span>
      </PluginSurface>
    )
    const root = () => container.querySelector<HTMLElement>("[data-plugin-surface]")!
    expect(root().style.minWidth).toBe("")
    expect(root().style.maxWidth).toBe("min(240px, 100%)")
    expect(root().style.flexBasis).toBe("240px")

    rerender(
      <PluginSurface pluginId="acme.reference" surfaceId="slot" formFactor="row" minWidth={120}>
        <span>content</span>
      </PluginSurface>
    )
    expect(root().style.minWidth).toBe("min(120px, 100%)")
    expect(root().style.maxWidth).toBe("100%")
    expect(root().style.flexBasis).toBe("120px")

    rerender(
      <PluginSurface pluginId="acme.reference" surfaceId="slot" formFactor="row" minWidth={120}>
        <span>content</span>
      </PluginSurface>
    )
    expect(root().style.minWidth).toBe("min(120px, 100%)")
  })

  it("falls back to the plugin id when no manifest name is registered", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    render(
      <PluginSurface pluginId="unknown.plugin" surfaceId="panel" formFactor="panel">
        <Boom />
      </PluginSurface>
    )

    expect(screen.getByRole("alert")).toHaveTextContent("unknown.plugin")
    errorSpy.mockRestore()
  })

  it("omits the CSS scope anchor for iframe surfaces", () => {
    const { container } = render(
      <PluginSurface
        pluginId="acme.reference"
        surfaceId="webview"
        formFactor="panel"
        variant="iframe"
      >
        <iframe title="plugin webview" />
      </PluginSurface>
    )

    expect(container.querySelector("[data-plugin-root]")).toBeNull()
    expect(container.querySelector('[data-plugin-surface="webview"]')).toBeInTheDocument()
  })

  it("can opt out of layout containment for context panels", () => {
    // Width hints are what make this assertion load-bearing: without them the
    // hint-less branch is taken and `containerType` is empty for every host, so
    // the opt-out would pass whether or not `container` was honored.
    const { container, rerender } = render(
      <PluginSurface
        pluginId="acme.reference"
        surfaceId="context-panel"
        formFactor="panel"
        container={false}
        minWidth={320}
        maxWidth={640}
      >
        <span>panel</span>
      </PluginSurface>
    )

    const root = () => container.querySelector<HTMLElement>("[data-plugin-surface]")
    expect(root()?.style.containerType).toBe("")
    expect(root()?.style.minWidth).toBe("min(320px, 100%)")
    expect(root()?.style.maxWidth).toBe("min(640px, 100%)")
    // The opt-out keeps `overflow: visible` — it exists for panels whose
    // positioned descendants must escape the box.
    expect(root()?.style.overflow).toBe("")

    // With no hints the opt-out gets the host layout back untouched, which is
    // the reason context panels ask for it — containment re-anchors absolutely
    // positioned descendants.
    rerender(
      <PluginSurface
        pluginId="acme.reference"
        surfaceId="context-panel"
        formFactor="panel"
        container={false}
      >
        <span>panel</span>
      </PluginSurface>
    )
    expect(root()?.style.display).toBe("contents")
    expect(root()?.style.containerType).toBe("")
  })
})
