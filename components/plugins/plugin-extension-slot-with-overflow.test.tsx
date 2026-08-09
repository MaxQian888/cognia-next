import { render, screen, waitFor } from "@testing-library/react"
import { PluginExtensionSlotWithOverflow } from "./plugin-extension-slot-with-overflow"
import {
  getExtensionsForPoint,
  getExtensionRevision,
  subscribeExtensionChanges,
} from "@/lib/plugin/api/extension-api"
import type {
  CanonicalExtensionPoint,
  PluginPointFormFactor,
} from "@/lib/plugin/contracts/plugin-points"
import { recordPluginPointDiagnostic } from "@/lib/plugin/contracts/diagnostics-store"

jest.mock("@/lib/plugin/api/extension-api", () => ({
  getExtensionsForPoint: jest.fn(),
  getExtensionRevision: jest.fn(() => 0),
  subscribeExtensionChanges: jest.fn(() => () => {}),
}))

jest.mock("@/lib/plugin/contracts/diagnostics-store", () => ({
  recordPluginPointDiagnostic: jest.fn(),
}))

jest.mock("@/lib/plugin/utils/analytics", () => ({
  trackPluginEvent: jest.fn(),
}))

const POINT = "chat.input.actions" as CanonicalExtensionPoint

interface FakeExt {
  id: string
  pluginId: string
  component: React.ComponentType<{
    pluginId: string
    extensionId: string
    formFactor: PluginPointFormFactor
  }>
  options: { priority?: number; minWidth?: number; maxWidth?: number }
}

function makeExt(id: string, priority: number | undefined, label: string): FakeExt {
  return {
    id,
    pluginId: "p1",
    component: ({ extensionId, formFactor }) => (
      <span data-testid={extensionId} data-form-factor={formFactor}>
        {label}
      </span>
    ),
    options: { priority },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
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
    expect(screen.getByTestId("a")).toHaveAttribute("data-form-factor", "row")
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

  it("wraps inline contributions in their plugin scope root", () => {
    const exts = [makeExt("inline", 100, "Inline"), makeExt("overflow", 10, "Overflow")]
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue(exts)
    const { container } = render(
      <PluginExtensionSlotWithOverflow point={POINT} limit={1} overflowLabel="More" />
    )

    expect(container.querySelectorAll('[data-plugin-root="p1"]')).toHaveLength(1)
  })

  it("applies width hints through the shared surface wrapper", () => {
    const ext = makeExt("sized", 1, "Sized")
    ext.options.minWidth = 120
    ext.options.maxWidth = 240
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue([ext])
    const { container } = render(
      <PluginExtensionSlotWithOverflow point={POINT} limit={1} overflowLabel="More" />
    )

    const root = container.querySelector<HTMLElement>('[data-plugin-root="p1"]')
    expect(root?.style.minWidth).toBe("min(120px, 100%)")
    expect(root?.style.maxWidth).toBe("min(240px, 100%)")
  })

  it("records a diagnostic when an overflow-slot contribution crashes", async () => {
    const ext = makeExt("broken", 1, "Broken")
    ext.component = () => {
      throw new Error("overflow crash")
    }
    ;(getExtensionsForPoint as jest.Mock).mockReturnValue([ext])
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    render(<PluginExtensionSlotWithOverflow point={POINT} limit={1} overflowLabel="More" />)

    await waitFor(() => {
      expect(recordPluginPointDiagnostic).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          code: "plugin.silent-failure",
          pointId: "broken",
        })
      )
    })
    errorSpy.mockRestore()
  })
})
