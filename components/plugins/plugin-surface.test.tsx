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
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      const { container } = render(
        <PluginSurface
          pluginId="acme.reference"
          surfaceId={`surface-${formFactor}`}
          formFactor={formFactor}
        >
          <Boom />
        </PluginSurface>
      )

      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(container.querySelector('[data-plugin-root="acme.reference"]')).toBeEmptyDOMElement()
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
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      render(
        <PluginSurface
          pluginId="acme.reference"
          pluginName="Reference Plugin"
          surfaceId={`surface-${formFactor}`}
          formFactor={formFactor}
        >
          <Recoverable />
        </PluginSurface>
      )

      expect(screen.getByRole("alert")).toHaveTextContent("Reference Plugin")
      expect(screen.getByRole("alert")).toHaveTextContent("reference crash")
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

  it("preserves host layout without width hints and clamps declared hints", () => {
    const { container, rerender } = render(
      <PluginSurface pluginId="acme.reference" surfaceId="slot" formFactor="row">
        <span>content</span>
      </PluginSurface>
    )
    const root = () => container.querySelector<HTMLElement>('[data-plugin-root="acme.reference"]')!

    expect(root().style.display).toBe("contents")
    expect(root().style.containerType).toBe("")
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
    expect(root().style.minWidth).toBe("min(320px, 100%)")
    expect(root().style.maxWidth).toBe("min(640px, 100%)")
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

    rerender(
      <PluginSurface pluginId="acme.reference" surfaceId="slot" formFactor="row" minWidth={120}>
        <span>content</span>
      </PluginSurface>
    )
    expect(root().style.minWidth).toBe("min(120px, 100%)")
    expect(root().style.maxWidth).toBe("100%")

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
    const { container } = render(
      <PluginSurface
        pluginId="acme.reference"
        surfaceId="context-panel"
        formFactor="panel"
        container={false}
      >
        <span>panel</span>
      </PluginSurface>
    )

    const root = container.querySelector<HTMLElement>("[data-plugin-surface]")
    expect(root?.style.containerType).toBe("")
  })
})
