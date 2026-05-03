/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { ExtensionRegistration } from "@/types/plugin/plugin-extended"

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

import { PluginExtensionSlot } from "./plugin-extension-slot"

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
})
