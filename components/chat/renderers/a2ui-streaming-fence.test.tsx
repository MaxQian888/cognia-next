import { act, render, screen } from "@testing-library/react"
import { A2UI_PREVIEW_THROTTLE_MS, A2UIStreamingPreview } from "./a2ui-streaming-fence"
import { isA2UIPreviewSurfaceId } from "@/lib/a2ui/streaming-preview"
import { useA2UIStore } from "@/stores/a2ui"

// The real surface pulls in the whole renderer catalog; this stand-in shows
// what the preview surface holds and which props the fence passes.
jest.mock("@/components/a2ui/a2ui-surface", () => ({
  A2UISurface: ({ surfaceId, readOnly }: { surfaceId: string; readOnly?: boolean }) => {
    const { useA2UIStore: store } = jest.requireActual("@/stores/a2ui")
    const surface = store(
      (state: { surfaces: Record<string, { components: object }> }) => state.surfaces[surfaceId]
    )
    return (
      <div data-testid="preview-surface" data-read-only={String(Boolean(readOnly))}>
        {Object.keys(surface?.components ?? {}).join(",")}
      </div>
    )
  },
}))

const fence = JSON.stringify({
  surface: { id: "trip", type: "panel" },
  components: [
    { id: "root", component: "Column", children: ["title", "go"] },
    { id: "title", component: "Text", text: "Plan your trip" },
    { id: "go", component: "Button", text: "Search", action: "search" },
  ],
})

function previewIds(): string[] {
  return Object.keys(useA2UIStore.getState().surfaces).filter(isA2UIPreviewSurfaceId)
}

function draw(code: string) {
  return <A2UIStreamingPreview code={code} isIncomplete language="a2ui" />
}

beforeEach(() => {
  jest.useFakeTimers()
  useA2UIStore.getState().reset()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("A2UIStreamingPreview", () => {
  it("holds a pending frame until a renderable root arrives", () => {
    render(draw('{"surface":{"id":"trip"},"compo'))
    expect(screen.getByRole("status")).toHaveAttribute("data-a2ui-preview", "pending")
    expect(screen.queryByTestId("preview-surface")).not.toBeInTheDocument()
  })

  it("draws the structurally complete prefix into an inline, inert preview surface", () => {
    const cut = fence.indexOf('{"id":"go"')
    const { container } = render(draw(fence.slice(0, cut + 3)))

    const [previewId] = previewIds()
    expect(previewId).toBeDefined()
    const surface = useA2UIStore.getState().surfaces[previewId]
    expect(surface.type).toBe("inline")
    expect(useA2UIStore.getState().surfaces.trip).toBeUndefined()
    expect(useA2UIStore.getState().streamingSurfaces[previewId]).toBe(true)

    expect(screen.getByTestId("preview-surface")).toHaveTextContent("root,title")
    expect(screen.getByTestId("preview-surface")).toHaveAttribute("data-read-only", "true")
    expect(container.querySelector('[data-a2ui-preview="live"]')).toHaveAttribute("inert")
    expect(screen.getByRole("region", { name: "Interactive UI" })).toContainElement(
      container.querySelector<HTMLElement>('[data-a2ui-preview="live"]')
    )
  })

  it("throttles parsing and catches up with the latest prefix", () => {
    const cut = fence.indexOf('{"id":"go"')
    const { rerender } = render(draw(fence.slice(0, cut + 3)))
    rerender(draw(fence))
    expect(screen.getByTestId("preview-surface")).toHaveTextContent("root,title")

    act(() => {
      jest.advanceTimersByTime(A2UI_PREVIEW_THROTTLE_MS)
    })
    expect(screen.getByTestId("preview-surface")).toHaveTextContent("root,title,go")
    expect(previewIds()).toHaveLength(1)
  })

  it("brings computed values in once the fence is complete", () => {
    const cart = JSON.stringify({
      surface: { id: "cart" },
      components: [{ id: "root", component: "Text", text: { path: "/total" } }],
      dataModel: { qty: 2, price: 5 },
      computed: { "/total": { op: "multiply", args: [{ path: "/qty" }, { path: "/price" }] } },
    })
    const { rerender } = render(draw(cart.slice(0, cart.indexOf(',"computed"'))))
    const [previewId] = previewIds()
    expect(useA2UIStore.getState().surfaces[previewId].dataModel.total).toBeUndefined()

    rerender(draw(cart))
    act(() => {
      jest.advanceTimersByTime(A2UI_PREVIEW_THROTTLE_MS)
    })
    expect(useA2UIStore.getState().surfaces[previewId].dataModel.total).toBe(10)
  })

  it("deletes its preview surface when the sealed message replaces it", () => {
    const { unmount } = render(draw(fence))
    expect(previewIds()).toHaveLength(1)
    unmount()
    expect(previewIds()).toHaveLength(0)
  })
})
