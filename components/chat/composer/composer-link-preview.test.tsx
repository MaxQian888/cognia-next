import { act, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { LINK_PREVIEW_OPEN_DELAY_MS } from "@/components/chat/link-preview/link-hover-preview"
import { __resetLinkPreviewStoreForTesting } from "@/lib/web/link-preview/preview-store"
import { ComposerLinkPreview, hitTestLink, linkAtCaret } from "./composer-link-preview"

const mockPreview = { current: "hover" as "hover" | "off" }
jest.mock("@/hooks/chat/use-message-display", () => ({
  useMessageDisplay: () => ({ links: { preview: mockPreview.current } }),
}))
jest.mock("@/lib/network/platform-fetch", () => ({
  ...jest.requireActual("@/lib/network/platform-fetch"),
  platformFetchKind: () => "browser",
}))

const URL_ = "https://github.com/deepseek-ai/dsh-libreoffice-kit"
const RECT = { left: 10, right: 110, top: 20, bottom: 36, width: 100, height: 16, x: 10, y: 20 }

function rects(el: Element, list: Array<typeof RECT>) {
  Object.defineProperty(el, "getClientRects", {
    configurable: true,
    value: () => list.map((r) => ({ ...r, toJSON: () => r }) as unknown as DOMRect),
  })
}

function Harness({ touchInput = false }: { touchInput?: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  return (
    <div>
      <div ref={overlayRef} data-testid="overlay">
        <span>see </span>
        <span data-chip="link" data-link-url={URL_} data-link-start="4" data-link-end="20">
          ··dsh-libreoffice-kit
        </span>
      </div>
      <textarea ref={textareaRef} data-testid="ta" defaultValue="see ··dsh-libreoffice-kit now" />
      <ComposerLinkPreview
        textareaRef={textareaRef}
        chipOverlayRef={overlayRef}
        touchInput={touchInput}
      />
    </div>
  )
}

function pointerMove(target: Element, x: number, y: number) {
  const event = new Event("pointermove", { bubbles: true }) as PointerEvent
  Object.assign(event, { clientX: x, clientY: y, pointerType: "mouse" })
  target.dispatchEvent(event)
}

beforeEach(() => __resetLinkPreviewStoreForTesting({ kind: "browser" }))
afterEach(() => {
  mockPreview.current = "hover"
  jest.useRealTimers()
})

describe("hitTestLink / linkAtCaret", () => {
  it("finds the link under a point and the link around a caret", () => {
    const { getByTestId } = render(
      <div data-testid="overlay">
        <span data-chip="link" data-link-url={URL_} data-link-start="4" data-link-end="20">
          label
        </span>
      </div>
    )
    const overlay = getByTestId("overlay")
    rects(overlay.querySelector("[data-chip]")!, [RECT])
    expect(hitTestLink(overlay, 50, 30)?.url).toBe(URL_)
    expect(hitTestLink(overlay, 500, 30)).toBeNull()
    expect(linkAtCaret(overlay, 10)?.url).toBe(URL_)
    // At either edge the caret is beside the label, not in it.
    expect(linkAtCaret(overlay, 4)).toBeNull()
    expect(linkAtCaret(overlay, 20)).toBeNull()
  })

  it("ignores spans that are not web links", () => {
    const { getByTestId } = render(
      <div data-testid="overlay">
        <span data-chip="link" data-link-start="0" data-link-end="5">
          plain
        </span>
      </div>
    )
    const overlay = getByTestId("overlay")
    rects(overlay.querySelector("[data-chip]")!, [RECT])
    expect(hitTestLink(overlay, 50, 30)).toBeNull()
    expect(linkAtCaret(overlay, 2)).toBeNull()
  })
})

describe("ComposerLinkPreview", () => {
  it("opens the card after resting on a link and closes when typing", () => {
    jest.useFakeTimers()
    render(<Harness />)
    rects(screen.getByTestId("overlay").querySelector("[data-chip]")!, [RECT])
    const ta = screen.getByTestId("ta")
    act(() => pointerMove(ta, 50, 30))
    expect(screen.queryByTestId("composer-link-preview")).not.toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(LINK_PREVIEW_OPEN_DELAY_MS)
    })
    expect(screen.getByTestId("composer-link-preview")).toBeInTheDocument()
    expect(screen.getByText("deepseek-ai/dsh-libreoffice-kit")).toBeInTheDocument()
    // The card must not steal the caret.
    expect(ta).not.toHaveFocus()
    act(() => {
      fireEvent.input(ta, { target: { value: "see ··dsh-libreoffice-kit now!" } })
    })
    expect(screen.queryByTestId("composer-link-preview")).not.toBeInTheDocument()
  })

  it("does not open when the pointer passes over plain text", () => {
    jest.useFakeTimers()
    render(<Harness />)
    rects(screen.getByTestId("overlay").querySelector("[data-chip]")!, [RECT])
    act(() => pointerMove(screen.getByTestId("ta"), 500, 30))
    act(() => {
      jest.advanceTimersByTime(LINK_PREVIEW_OPEN_DELAY_MS * 2)
    })
    expect(screen.queryByTestId("composer-link-preview")).not.toBeInTheDocument()
  })

  it("opens on touch when the caret lands inside a label", () => {
    render(<Harness touchInput />)
    rects(screen.getByTestId("overlay").querySelector("[data-chip]")!, [RECT])
    const ta = screen.getByTestId("ta") as HTMLTextAreaElement
    ta.focus()
    act(() => {
      ta.setSelectionRange(10, 10)
      document.dispatchEvent(new Event("selectionchange"))
    })
    expect(screen.getByTestId("composer-link-preview")).toBeInTheDocument()
    act(() => {
      ta.setSelectionRange(28, 28)
      document.dispatchEvent(new Event("selectionchange"))
    })
    expect(screen.queryByTestId("composer-link-preview")).not.toBeInTheDocument()
  })

  it("does nothing when link previews are off", () => {
    jest.useFakeTimers()
    mockPreview.current = "off"
    render(<Harness />)
    rects(screen.getByTestId("overlay").querySelector("[data-chip]")!, [RECT])
    act(() => pointerMove(screen.getByTestId("ta"), 50, 30))
    act(() => {
      jest.advanceTimersByTime(LINK_PREVIEW_OPEN_DELAY_MS * 2)
    })
    expect(screen.queryByTestId("composer-link-preview")).not.toBeInTheDocument()
  })
})
