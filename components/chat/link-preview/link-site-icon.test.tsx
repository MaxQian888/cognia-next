import { fireEvent, render, waitFor } from "@testing-library/react"
import { __resetLinkPreviewStoreForTesting } from "@/lib/web/link-preview/preview-store"
import { faviconCandidate, LinkSiteIcon } from "./link-site-icon"

const mockKind = { current: "capacitor" as "tauri" | "capacitor" | "browser" }
jest.mock("@/lib/network/platform-fetch", () => ({
  ...jest.requireActual("@/lib/network/platform-fetch"),
  platformFetchKind: () => mockKind.current,
}))

afterEach(() => {
  mockKind.current = "capacitor"
  __resetLinkPreviewStoreForTesting()
})

const icon = (container: HTMLElement) =>
  container.querySelector("[data-link-site-icon]") as HTMLElement

describe("LinkSiteIcon", () => {
  it("uses the local brand mark without any request", () => {
    const fetchImpl = jest.fn()
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    mockKind.current = "tauri"
    const { container } = render(
      <LinkSiteIcon url="https://github.com/deepseek-ai/dsh-libreoffice-kit" allowFetch />
    )
    expect(icon(container)).toHaveAttribute("data-link-site-icon", "brand")
    expect(icon(container)).toHaveAttribute("src", "/icons/lobe/github.svg")
    expect(icon(container)).toHaveAttribute("aria-hidden")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("loads the site favicon when fetching is allowed", () => {
    __resetLinkPreviewStoreForTesting({ kind: "capacitor" })
    const { container } = render(<LinkSiteIcon url="https://example.org/a/b" allowFetch />)
    expect(icon(container)).toHaveAttribute("data-link-site-icon", "favicon")
    expect(icon(container)).toHaveAttribute("src", "https://example.org/favicon.ico")
    expect(icon(container)).toHaveAttribute("referrerpolicy", "no-referrer")
  })

  it("falls back to the globe after the favicon fails, and remembers it", () => {
    __resetLinkPreviewStoreForTesting({ kind: "capacitor" })
    const { container } = render(<LinkSiteIcon url="https://example.org/" allowFetch />)
    fireEvent.error(icon(container))
    expect(icon(container)).toHaveAttribute("data-link-site-icon", "globe")
    const second = render(<LinkSiteIcon url="https://example.org/other" allowFetch />)
    expect(icon(second.container)).toHaveAttribute("data-link-site-icon", "globe")
  })

  it("shows the globe and fetches nothing when fetching is not allowed", () => {
    const fetchImpl = jest.fn()
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    mockKind.current = "tauri"
    const { container } = render(<LinkSiteIcon url="https://example.org/" allowFetch={false} />)
    expect(icon(container)).toHaveAttribute("data-link-site-icon", "globe")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("inlines the favicon on the desktop", async () => {
    const bytes = new Uint8Array([0, 0, 1, 0])
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          url: "",
          headers: new Headers({ "content-type": "image/x-icon" }),
          arrayBuffer: async () => bytes.buffer.slice(0),
          text: async () => "",
        }) as unknown as Response
    )
    mockKind.current = "tauri"
    __resetLinkPreviewStoreForTesting({ kind: "tauri", fetchImpl })
    const { container } = render(<LinkSiteIcon url="https://example.org/" allowFetch />)
    expect(icon(container)).toHaveAttribute("data-link-site-icon", "globe")
    await waitFor(() => expect(icon(container)).toHaveAttribute("data-link-site-icon", "favicon"))
    expect(icon(container).getAttribute("src")).toMatch(/^data:image\/x-icon;base64,/)
  })
})

describe("faviconCandidate", () => {
  it("defaults to /favicon.ico on the link's origin and rejects non-web URLs", () => {
    expect(faviconCandidate("https://www.example.org/a?b=1")).toBe(
      "https://www.example.org/favicon.ico"
    )
    expect(faviconCandidate("mailto:a@b.c")).toBeNull()
    expect(faviconCandidate("nope")).toBeNull()
  })
})
