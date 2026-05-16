/**
 * @jest-environment jsdom
 */

// Coverage harness for the 24 implemented `CanonicalExtensionPoint`s. Pairs
// with `scripts/audit-plugin-slots.ts`: the audit verifies each implemented
// point has a host JSX mount in the right file; this test verifies the slot
// API + the test helper actually render an extension at every point.
//
// Mounting each real host (TitleBar, ChatHeader, MessageRenderer, etc.)
// would require ~14 separate mock setups for i18n, Tauri, Dexie, stores,
// and chat state. Because every host wires the same `PluginExtensionSlot`
// (or its `WithOverflow` variant), exercising the slot + helper across
// every point is sufficient integration coverage; the audit catches the
// "slot lives in the wrong file" failure mode independently.

import { render, screen } from "@testing-library/react"
import { PluginExtensionSlot } from "./plugin-extension-slot"
import { PluginExtensionSlotWithOverflow } from "./plugin-extension-slot-with-overflow"
import { registerMockExtension, clearAllMockExtensions } from "./test-utils/register-mock-extension"
import {
  CANONICAL_EXTENSION_POINTS,
  getExtensionPointContract,
  type CanonicalExtensionPoint,
} from "@/lib/plugin/contracts/plugin-points"

afterEach(() => {
  clearAllMockExtensions()
})

const IMPLEMENTED_POINTS: CanonicalExtensionPoint[] = CANONICAL_EXTENSION_POINTS.filter(
  (point) => getExtensionPointContract(point).status === "implemented"
)

describe("plugin slot coverage — every implemented extension point", () => {
  it.each(IMPLEMENTED_POINTS)("renders a registered extension at point %s", (point) => {
    const TestExtension = () => <span data-testid={`ext-for-${point}`}>plugin content</span>
    registerMockExtension(point, TestExtension)
    render(<PluginExtensionSlot point={point} />)
    expect(screen.getByTestId(`ext-for-${point}`)).toBeInTheDocument()
  })

  it("the WithOverflow wrapper renders inline + overflow for the actions point", () => {
    const First = () => <span data-testid="ext-1">1</span>
    const Second = () => <span data-testid="ext-2">2</span>
    const Third = () => <span data-testid="ext-3">3</span>
    const Fourth = () => <span data-testid="ext-4">4</span>
    registerMockExtension("chat.input.actions", First, { priority: 4 })
    registerMockExtension("chat.input.actions", Second, { priority: 3 })
    registerMockExtension("chat.input.actions", Third, { priority: 2 })
    registerMockExtension("chat.input.actions", Fourth, { priority: 1 })
    render(
      <PluginExtensionSlotWithOverflow
        point="chat.input.actions"
        limit={3}
        overflowLabel="More plugin actions"
      />
    )
    expect(screen.getByTestId("ext-1")).toBeInTheDocument()
    expect(screen.getByTestId("ext-2")).toBeInTheDocument()
    expect(screen.getByTestId("ext-3")).toBeInTheDocument()
    // The 4th lives inside the overflow DropdownMenu (closed by default).
    expect(screen.queryByTestId("ext-4")).not.toBeInTheDocument()
    // Overflow trigger is rendered.
    expect(screen.getByTestId("plugin-extension-overflow-chat.input.actions")).toBeInTheDocument()
  })

  it("the WithOverflow wrapper uses the caller-provided aria-label on the overflow trigger", () => {
    const First = () => <span data-testid="ext-1">1</span>
    const Second = () => <span data-testid="ext-2">2</span>
    registerMockExtension("chat.input.actions", First, { priority: 2 })
    registerMockExtension("chat.input.actions", Second, { priority: 1 })
    render(
      <PluginExtensionSlotWithOverflow
        point="chat.input.actions"
        limit={1}
        overflowLabel="Custom localized label"
      />
    )
    expect(screen.getByRole("button", { name: "Custom localized label" })).toBeInTheDocument()
  })

  it("the WithOverflow wrapper renders nothing when no extensions registered", () => {
    const { container } = render(
      <PluginExtensionSlotWithOverflow
        point="chat.input.actions"
        limit={3}
        overflowLabel="More plugin actions"
      />
    )
    expect(container.firstChild).toBeNull()
  })
})
