import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetLinkPreviewStoreForTesting } from "@/lib/web/link-preview/preview-store"
import type { LinkPreview } from "@/lib/web/link-preview/fetch-preview"
import { displayUrl, fileTypeLabel, LinkPreviewCard } from "./link-preview-card"

const mockKind = { current: "capacitor" as "tauri" | "capacitor" | "browser" }
jest.mock("@/lib/network/platform-fetch", () => ({
  ...jest.requireActual("@/lib/network/platform-fetch"),
  platformFetchKind: () => mockKind.current,
}))

const mockWriteText = jest.fn(async (_value: string) => ({ kind: "ok" as const }))
jest.mock("@/lib/capacitor/clipboard", () => ({
  writeText: (value: string) => mockWriteText(value),
}))

const URL_ = "https://github.com/deepseek-ai/dsh-libreoffice-kit"
const ready: LinkPreview = {
  url: URL_,
  finalUrl: URL_,
  host: "github.com",
  kind: "page",
  title: "GitHub - deepseek-ai/dsh-libreoffice-kit",
  description: "An internal component used by DeepSeek Harness",
  siteName: "GitHub",
  imageUrl: "https://opengraph.githubassets.com/1/deepseek-ai/dsh-libreoffice-kit",
  faviconUrl: "https://github.com/favicon.svg",
}

beforeEach(() => __resetLinkPreviewStoreForTesting({ kind: "capacitor" }))
afterEach(() => {
  mockKind.current = "capacitor"
  mockWriteText.mockClear()
})

describe("LinkPreviewCard", () => {
  it("renders a fetched page: image, site, title, description and URL", () => {
    render(<LinkPreviewCard url={URL_} state={{ status: "ready", preview: ready }} allowFetch />)
    const card = screen.getByTestId("link-preview-card")
    expect(card).toHaveAttribute("data-state", "ready")
    expect(screen.getByTestId("link-preview-image")).toHaveAttribute("src", ready.imageUrl)
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.getByText(ready.title!)).toBeInTheDocument()
    expect(screen.getByText(ready.description!)).toBeInTheDocument()
    expect(screen.getByText("github.com/deepseek-ai/dsh-libreoffice-kit")).toBeInTheDocument()
  })

  it("renders the local card from the URL alone", () => {
    render(<LinkPreviewCard url={URL_} state={{ status: "local" }} allowFetch={false} />)
    // `describeLink` shortens repo URLs to owner/repo.
    expect(screen.getByText("deepseek-ai/dsh-libreoffice-kit")).toBeInTheDocument()
    expect(screen.getByText("github.com")).toBeInTheDocument()
    expect(screen.queryByTestId("link-preview-image")).not.toBeInTheDocument()
  })

  it("explains that the browser build shows the local card only", () => {
    mockKind.current = "browser"
    render(<LinkPreviewCard url={URL_} state={{ status: "local" }} allowFetch />)
    expect(screen.getByText(/desktop and mobile apps/)).toBeInTheDocument()
  })

  it("shows skeletons while loading and a note on error", () => {
    const { rerender } = render(
      <LinkPreviewCard url={URL_} state={{ status: "loading" }} allowFetch />
    )
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading preview")
    rerender(<LinkPreviewCard url={URL_} state={{ status: "error" }} allowFetch />)
    expect(screen.getByText("No preview available for this page.")).toBeInTheDocument()
  })

  it("labels non-HTML files with their type", () => {
    render(
      <LinkPreviewCard
        url="https://example.com/paper.pdf"
        state={{
          status: "ready",
          preview: {
            url: "https://example.com/paper.pdf",
            finalUrl: "https://example.com/paper.pdf",
            host: "example.com",
            kind: "file",
            contentType: "application/pdf",
          },
        }}
        allowFetch
      />
    )
    expect(screen.getByText("PDF")).toBeInTheDocument()
  })

  it("opens and copies the link", async () => {
    render(<LinkPreviewCard url={URL_} state={{ status: "local" }} allowFetch={false} />)
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute("href", URL_)
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }))
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(URL_))
    expect(await screen.findByText("Copied")).toBeInTheDocument()
  })
})

describe("displayUrl / fileTypeLabel", () => {
  it("strips the scheme, www and a trailing slash", () => {
    expect(displayUrl("https://www.example.com/a/?q=1")).toBe("example.com/a/?q=1")
    expect(displayUrl("https://example.com/")).toBe("example.com")
    expect(displayUrl("nope")).toBe("nope")
  })

  it("shortens MIME types", () => {
    expect(fileTypeLabel("application/pdf")).toBe("PDF")
    expect(fileTypeLabel("application/vnd.ms-excel")).toBe("EXCEL")
    expect(fileTypeLabel(undefined)).toBeNull()
  })
})
