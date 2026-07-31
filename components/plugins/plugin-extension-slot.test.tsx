/**
 * @jest-environment jsdom
 */

import { render, screen, act } from "@testing-library/react"
import type { ExtensionRegistration } from "@/types/plugin/plugin"
// Real (un-mocked) context-key store — drives the slot's second
// useSyncExternalStore for when-clause reactivity.
import {
  setContextKey,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"

let mockRegistrations: ExtensionRegistration[] = []
const subscribers = new Set<() => void>()
let revision = 0

jest.mock("@/lib/plugin/api/extension-api", () => ({
  getExtensionsForPoint: () => mockRegistrations,
  getExtensionRevision: () => revision,
  subscribeExtensionChanges: (l: () => void) => {
    subscribers.add(l)
    return () => subscribers.delete(l)
  },
}))

jest.mock("@/lib/plugin/utils/analytics", () => ({
  trackPluginEvent: jest.fn(),
}))

import { PluginExtensionSlot, usePluginSlotHasExtensions } from "./plugin-extension-slot"
import type { CanonicalExtensionPoint } from "@/lib/plugin/contracts/plugin-points"

beforeEach(() => {
  mockRegistrations = []
  revision++
})

function makeReg(pluginId: string, Component: React.FC, priority?: number): ExtensionRegistration {
  return {
    id: `${pluginId}-ext`,
    pluginId,
    point: "chat.input.above" as never,
    component: Component as never,
    options: { priority },
  }
}

describe("PluginExtensionSlot", () => {
  it("renders nothing when no extensions are registered", () => {
    const { container } = render(<PluginExtensionSlot point="chat.input.above" />)
    expect(container.firstChild).toBeNull()
  })

  it("renders a fallback when no extensions are registered", () => {
    render(<PluginExtensionSlot point="chat.input.above" fallback={<span>fallback-here</span>} />)
    expect(screen.getByText("fallback-here")).toBeInTheDocument()
  })

  it("renders registered extensions in priority order", () => {
    const Low = () => <span>low-ext</span>
    const High = () => <span>high-ext</span>
    mockRegistrations = [makeReg("a", Low, 1), makeReg("b", High, 100)]
    const { container } = render(<PluginExtensionSlot point="chat.input.above" />)
    const text = container.textContent ?? ""
    expect(text.indexOf("high-ext")).toBeLessThan(text.indexOf("low-ext"))
  })

  it("respects the limit prop", () => {
    const A = () => <span>A</span>
    const B = () => <span>B</span>
    const C = () => <span>C</span>
    mockRegistrations = [makeReg("a", A), makeReg("b", B), makeReg("c", C)]
    render(<PluginExtensionSlot point="chat.input.above" limit={2} />)
    expect(screen.queryByText("C")).not.toBeInTheDocument()
  })

  it("isolates a throwing extension behind ErrorBoundary", () => {
    const Boom: React.FC = () => {
      throw new Error("kaboom")
    }
    const Healthy = () => <span>still-rendered</span>
    mockRegistrations = [makeReg("bad", Boom), makeReg("good", Healthy)]
    // Suppress React's expected error log for this test.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    render(<PluginExtensionSlot point="chat.input.above" />)
    expect(screen.getByText("still-rendered")).toBeInTheDocument()
    errSpy.mockRestore()
  })

  it("annotates the wrapper with point + count attributes", () => {
    const Tiny = () => <span>x</span>
    mockRegistrations = [makeReg("a", Tiny)]
    const { container } = render(<PluginExtensionSlot point="chat.input.above" />)
    const wrapper = container.querySelector("[data-plugin-extension-slot='chat.input.above']")
    expect(wrapper).toBeInTheDocument()
    expect(wrapper?.getAttribute("data-extension-count")).toBe("1")
  })

  it("re-renders when context keys change (when-clause reactivity)", () => {
    // The real context-key store drives the second useSyncExternalStore in the
    // slot. Flipping a key bumps the revision → React re-runs the component →
    // it reads the (now-updated) registration set. We simulate a when-gated
    // extension by letting the mocked getExtensionsForPoint follow a flag the
    // store flip toggles in lockstep.
    __resetContextKeysForTesting()

    const Gated = () => <span>gated-ext</span>
    // Initially hidden (clause unmet).
    mockRegistrations = []
    const { container } = render(<PluginExtensionSlot point="chat.input.above" />)
    expect(container.textContent).not.toContain("gated-ext")

    // Plugin's when-clause becomes true: the registry would now return it, and
    // the context-key change forces the slot to re-read.
    mockRegistrations = [makeReg("g", Gated)]
    act(() => {
      setContextKey("chat.active", true)
    })
    expect(container.textContent).toContain("gated-ext")

    __resetContextKeysForTesting()
  })

  it("delivers the host context bag to a chat.tool-call.actions extension", () => {
    const ToolAction: React.FC<{ context?: Record<string, unknown> }> = ({ context }) => (
      <span>tool:{String(context?.toolName)}</span>
    )
    mockRegistrations = [makeReg("a", ToolAction as React.FC)]
    render(
      <PluginExtensionSlot
        point="chat.tool-call.actions"
        context={{ toolName: "Bash", toolState: "output-available", messageId: "m1" }}
      />
    )
    expect(screen.getByText("tool:Bash")).toBeInTheDocument()
  })

  it("delivers the host context bag to a chat.message-part.actions extension", () => {
    const PartAction: React.FC<{ context?: Record<string, unknown> }> = ({ context }) => (
      <span>part:{String(context?.partType)}</span>
    )
    mockRegistrations = [makeReg("a", PartAction as React.FC)]
    render(
      <PluginExtensionSlot
        point="chat.message-part.actions"
        context={{ partType: "my-plugin.chart", messageId: "m1", sessionId: "s1" }}
      />
    )
    expect(screen.getByText("part:my-plugin.chart")).toBeInTheDocument()
  })
})

describe("style containment", () => {
  it("wraps each extension in its plugin's scope root", () => {
    // `manifest.styles` is injected as `@scope ([data-plugin-root="<id>"])`, so
    // without this attribute the whole sheet silently matches nothing.
    const Ext = () => <span>scoped-ext</span>
    mockRegistrations = [makeReg("acme", Ext)]
    const { container } = render(<PluginExtensionSlot point="chat.input.above" />)
    const root = container.querySelector('[data-plugin-root="acme"]')
    expect(root).not.toBeNull()
    expect(root).toContainElement(screen.getByText("scoped-ext"))
  })

  it("gives each plugin its own scope root", () => {
    const A = () => <span>a-ext</span>
    const B = () => <span>b-ext</span>
    mockRegistrations = [makeReg("alpha", A), makeReg("beta", B)]
    const { container } = render(<PluginExtensionSlot point="chat.input.above" />)
    expect(container.querySelector('[data-plugin-root="alpha"]')).not.toBeNull()
    expect(container.querySelector('[data-plugin-root="beta"]')).not.toBeNull()
  })

  it("uses a real query-container box for every plugin surface", () => {
    // Container queries require a principal box; display: contents would make
    // containerType ineffective and silently disable responsive plugin CSS.
    const Ext = () => <span>btn</span>
    mockRegistrations = [makeReg("acme", Ext)]
    const { container } = render(<PluginExtensionSlot point="chat.input.actions" />)
    const root = container.querySelector<HTMLElement>('[data-plugin-root="acme"]')
    expect(root?.style.display).toBe("block")
    expect(root?.style.containerType).toBe("inline-size")
  })

  it("keeps an empty scope root when a compact extension crashes", () => {
    const Boom = () => {
      throw new Error("boom")
    }
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    mockRegistrations = [makeReg("acme", Boom)]
    const { container } = render(<PluginExtensionSlot point="chat.input.actions" />)
    expect(container.querySelector('[data-plugin-root="acme"]')).toBeEmptyDOMElement()
    spy.mockRestore()
  })
})

describe("layout signal", () => {
  it("makes the slot a query container so plugin CSS can use @container", () => {
    const Ext = () => <span>x</span>
    mockRegistrations = [makeReg("acme", Ext)]
    const { container } = render(<PluginExtensionSlot point="chat.input.above" />)
    const slot = container.querySelector<HTMLElement>("[data-plugin-extension-slot]")
    expect(slot?.style.containerType).toBe("inline-size")
  })

  it("passes the point's form factor to the contributed component", () => {
    const seen: string[] = []
    const Ext = (props: { formFactor?: string }) => {
      seen.push(props.formFactor ?? "none")
      return <span>x</span>
    }
    mockRegistrations = [makeReg("acme", Ext as React.FC)]
    render(<PluginExtensionSlot point="statusbar.right" />)
    expect(seen).toEqual(["icon"])
  })

  it("reports the form factor on the wrapper for host-side styling", () => {
    const Ext = () => <span>x</span>
    mockRegistrations = [makeReg("acme", Ext)]
    const { container } = render(<PluginExtensionSlot point="sidebar.right.top" />)
    expect(
      container.querySelector("[data-plugin-extension-slot]")?.getAttribute("data-form-factor")
    ).toBe("panel")
  })
})

describe("usePluginSlotHasExtensions", () => {
  // Every consumer mocks this hook out, so its own module is the only place it
  // can be exercised against the real registry.
  function Probe({ point }: { point: CanonicalExtensionPoint }) {
    return <span data-testid="probe">{String(usePluginSlotHasExtensions(point))}</span>
  }

  it("reports whether the point currently has a visible contribution", () => {
    mockRegistrations = []
    const { rerender } = render(<Probe point="chat.input.above" />)
    expect(screen.getByTestId("probe")).toHaveTextContent("false")

    mockRegistrations = [makeReg("acme", () => <span>x</span>)]
    act(() => {
      revision++
      subscribers.forEach((notify) => notify())
    })
    rerender(<Probe point="chat.input.above" />)
    expect(screen.getByTestId("probe")).toHaveTextContent("true")
  })
})

describe("width hints", () => {
  function renderWithHints(options: { minWidth?: number; maxWidth?: number }) {
    const Ext = () => <span>sized</span>
    const registration = makeReg("acme", Ext)
    registration.options = { ...registration.options, ...options }
    mockRegistrations = [registration]
    const { container } = render(<PluginExtensionSlot point="chat.input.actions" />)
    return container.querySelector<HTMLElement>('[data-plugin-root="acme"]')!
  }

  it("keeps a bounded query-container box when no hint is declared", () => {
    const root = renderWithHints({})
    expect(root.style.display).toBe("block")
    expect(root.style.containerType).toBe("inline-size")
    expect(root.style.minWidth).toBe("")
    expect(root.style.maxWidth).toBe("")
  })

  it("clamps a declared floor to the slot's own inline size", () => {
    const root = renderWithHints({ minWidth: 200 })
    expect(root.style.display).toBe("block")
    expect(root.style.minWidth).toBe("min(200px, 100%)")
    // A floor with no declared ceiling still gets one — otherwise the floor is
    // exactly what would push the box past the slot edge under flex pressure.
    expect(root.style.maxWidth).toBe("100%")
  })

  it("clamps a declared ceiling too, so no number can exceed the slot", () => {
    const root = renderWithHints({ maxWidth: 320 })
    expect(root.style.display).toBe("block")
    expect(root.style.maxWidth).toBe("min(320px, 100%)")
    expect(root.style.minWidth).toBe("")
  })

  it("applies both bounds together", () => {
    const root = renderWithHints({ minWidth: 120, maxWidth: 240 })
    expect(root.style.minWidth).toBe("min(120px, 100%)")
    expect(root.style.maxWidth).toBe("min(240px, 100%)")
  })

  it("reuses one style object per hint pair so re-renders do not rewrite the attribute", () => {
    const first = renderWithHints({ minWidth: 150, maxWidth: 300 })
    const second = renderWithHints({ minWidth: 150, maxWidth: 300 })
    expect(first.getAttribute("style")).toBe(second.getAttribute("style"))
  })
})
