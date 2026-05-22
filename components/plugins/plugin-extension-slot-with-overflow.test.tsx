import { render, screen } from "@testing-library/react"
import { PluginExtensionSlotWithOverflow } from "./plugin-extension-slot-with-overflow"
import {
  getExtensionsForPoint,
  getExtensionRevision,
  subscribeExtensionChanges,
} from "@/lib/plugin/api"
import type { CanonicalExtensionPoint } from "@/lib/plugin/contracts/plugin-points"

jest.mock("@/lib/plugin/api", () => ({
  getExtensionsForPoint: jest.fn(),
  getExtensionRevision: jest.fn(() => 0),
  subscribeExtensionChanges: jest.fn(() => () => {}),
}))

const POINT = "chat.input.actions" as CanonicalExtensionPoint

interface FakeExt {
  id: string
  pluginId: string
  component: React.ComponentType<{ pluginId: string; extensionId: string }>
  options: { priority?: number }
}

function makeExt(id: string, priority: number | undefined, label: string): FakeExt {
  return {
    id,
    pluginId: "p1",
    component: ({ extensionId }: { extensionId: string }) => (
      <span data-testid={extensionId}>{label}</span>
    ),
    options: { priority },
  }
}

beforeEach(() => {
  ;(getExtensionsForPoint as jest.Mock).mockReset()
  ;(getExtensionRevision as jest.Mock).mockReset().mockReturnValue(0)
  ;(subscribeExtensionChanges as jest.Mock).mockReset().mockReturnValue(() => {})
})

describe("PluginExtensionSlotWithOverflow", () => {
  it("renders the fallback when no extensions are registered", () => {
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue([])
    render(
      <PluginExtensionSlotWithOverflow
        point={POINT}
        limit={3}
        overflowLabel="More"
        fallback={<span>none-yet</span>}
      />
    )
    expect(screen.getByText("none-yet")).toBeInTheDocument()
  })

  it("returns null when no extensions and no fallback", () => {
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue([])
    const { container } = render(
      <PluginExtensionSlotWithOverflow point={POINT} limit={3} overflowLabel="More" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders all extensions inline when count <= limit", () => {
    const exts = [makeExt("a", 10, "Alpha"), makeExt("b", 5, "Beta"), makeExt("c", 0, "Gamma")]
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue(exts)
    render(<PluginExtensionSlotWithOverflow point={POINT} limit={5} overflowLabel="More" />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Gamma")).toBeInTheDocument()
    // No overflow trigger since count <= limit
    expect(screen.queryByTestId(`plugin-extension-overflow-${POINT}`)).not.toBeInTheDocument()
  })

  it("orders extensions by descending priority", () => {
    const exts = [makeExt("low", 1, "Low"), makeExt("high", 100, "High"), makeExt("mid", 50, "Mid")]
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue(exts)
    render(<PluginExtensionSlotWithOverflow point={POINT} limit={5} overflowLabel="More" />)
    const rendered = screen.getAllByText(/^(High|Mid|Low)$/).map((el) => el.textContent)
    expect(rendered).toEqual(["High", "Mid", "Low"])
  })

  it("pushes extensions past the limit into the overflow dropdown trigger", () => {
    const exts = [
      makeExt("a", 100, "A"),
      makeExt("b", 90, "B"),
      makeExt("c", 80, "C"),
      makeExt("d", 70, "D"),
    ]
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue(exts)
    render(<PluginExtensionSlotWithOverflow point={POINT} limit={2} overflowLabel="More" />)
    expect(screen.getByText("A")).toBeInTheDocument()
    expect(screen.getByText("B")).toBeInTheDocument()
    // C and D are inside the dropdown — the trigger button is rendered.
    expect(screen.getByTestId(`plugin-extension-overflow-${POINT}`)).toBeInTheDocument()
  })

  it("exposes data attributes for the counts so audit panels can read them", () => {
    const exts = [makeExt("a", 0, "A"), makeExt("b", 0, "B"), makeExt("c", 0, "C")]
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue(exts)
    const { container } = render(
      <PluginExtensionSlotWithOverflow point={POINT} limit={1} overflowLabel="More" />
    )
    const wrapper = container.querySelector(`[data-plugin-extension-slot="${POINT}"]`)
    expect(wrapper).not.toBeNull()
    expect(wrapper?.getAttribute("data-extension-count")).toBe("3")
    expect(wrapper?.getAttribute("data-extension-overflow")).toBe("2")
  })
})
