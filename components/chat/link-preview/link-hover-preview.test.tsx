import { act, fireEvent, render, screen } from "@testing-library/react"
import { __resetLinkPreviewStoreForTesting } from "@/lib/web/link-preview/preview-store"
import { LINK_PREVIEW_LONG_PRESS_MS, LinkHoverPreview } from "./link-hover-preview"

const mockHasHover = { current: true }
jest.mock("@/hooks/ui/use-pointer", () => ({
  useHasHover: () => mockHasHover.current,
}))
jest.mock("@/lib/network/platform-fetch", () => ({
  ...jest.requireActual("@/lib/network/platform-fetch"),
  platformFetchKind: () => "tauri",
}))

const URL_ = "https://example.com/post"

beforeEach(() => {
  __resetLinkPreviewStoreForTesting({
    kind: "tauri",
    fetchImpl: async () =>
      new Response("<head><title>Post title</title></head>", {
        headers: { "content-type": "text/html" },
      }),
  })
})
afterEach(() => {
  mockHasHover.current = true
  jest.useRealTimers()
})

describe("LinkHoverPreview", () => {
  it("renders the link untouched until the card opens", () => {
    render(
      <LinkHoverPreview url={URL_} allowFetch>
        <a href={URL_}>post</a>
      </LinkHoverPreview>
    )
    expect(screen.getByRole("link", { name: "post" })).toHaveAttribute("href", URL_)
    expect(screen.queryByTestId("link-preview-card")).not.toBeInTheDocument()
  })

  it("opens a card on long press on touch devices and swallows the follow-up click", async () => {
    jest.useFakeTimers()
    mockHasHover.current = false
    const onClick = jest.fn()
    render(
      <LinkHoverPreview url={URL_} allowFetch={false}>
        <a href={URL_} onClick={onClick}>
          post
        </a>
      </LinkHoverPreview>
    )
    const link = screen.getByRole("link", { name: "post" })
    fireEvent.pointerDown(link, { pointerType: "touch", clientX: 5, clientY: 5 })
    act(() => {
      jest.advanceTimersByTime(LINK_PREVIEW_LONG_PRESS_MS)
    })
    expect(await screen.findByTestId("link-preview-card")).toHaveAttribute("data-state", "local")
    fireEvent.pointerUp(link, { pointerType: "touch" })
    fireEvent.click(link)
    expect(onClick).not.toHaveBeenCalled()
    // The next, ordinary tap follows the link again.
    fireEvent.click(link)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("treats a drifting press as a scroll", () => {
    jest.useFakeTimers()
    mockHasHover.current = false
    render(
      <LinkHoverPreview url={URL_} allowFetch={false}>
        <a href={URL_}>post</a>
      </LinkHoverPreview>
    )
    const link = screen.getByRole("link", { name: "post" })
    fireEvent.pointerDown(link, { pointerType: "touch", clientX: 0, clientY: 0 })
    fireEvent.pointerMove(link, { pointerType: "touch", clientX: 0, clientY: 40 })
    act(() => {
      jest.advanceTimersByTime(LINK_PREVIEW_LONG_PRESS_MS * 2)
    })
    expect(screen.queryByTestId("link-preview-card")).not.toBeInTheDocument()
  })

  it("ignores mouse presses on the touch path", () => {
    jest.useFakeTimers()
    mockHasHover.current = false
    render(
      <LinkHoverPreview url={URL_} allowFetch={false}>
        <a href={URL_}>post</a>
      </LinkHoverPreview>
    )
    fireEvent.pointerDown(screen.getByRole("link"), { pointerType: "mouse" })
    act(() => {
      jest.advanceTimersByTime(LINK_PREVIEW_LONG_PRESS_MS * 2)
    })
    expect(screen.queryByTestId("link-preview-card")).not.toBeInTheDocument()
  })
})
