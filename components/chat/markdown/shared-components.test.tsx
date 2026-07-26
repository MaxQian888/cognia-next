/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import {
  createSharedMarkdownComponents,
  extractTextContent,
  isAudioUrl,
  isVideoUrl,
  parseTaskListItem,
} from "./shared-components"

// The factory's job is ROUTING (which markdown node lands on which block
// renderer), not rendering media. Stub the leaf renderers so a failure here
// always means the routing broke, never that AudioBlock changed its markup.
jest.mock("@/components/chat/renderers/image-block", () => ({
  ImageBlock: ({ src, alt, title }: { src: string; alt?: string; title?: string }) => (
    <div data-testid="image-block" data-src={src} data-alt={alt} data-title={title} />
  ),
}))
jest.mock("@/components/chat/renderers/video-block", () => ({
  VideoBlock: ({ src, title }: { src: string; title?: string }) => (
    <div data-testid="video-block" data-src={src} data-title={title} />
  ),
}))
jest.mock("@/components/chat/renderers/audio-block", () => ({
  AudioBlock: ({ src, title }: { src: string; title?: string }) => (
    <div data-testid="audio-block" data-src={src} data-title={title} />
  ),
}))
jest.mock("@/components/chat/renderers/alert-block", () => ({
  // `parseAlertFromBlockquote` is the real branch predicate under test here,
  // so only the presentational component is stubbed.
  ...jest.requireActual("@/components/chat/renderers/alert-block"),
  AlertBlock: ({ type, children }: { type: string; children: React.ReactNode }) => (
    <div data-testid="alert-block" data-type={type}>
      {children}
    </div>
  ),
}))
jest.mock("@/components/chat/renderers/details-block", () => ({
  DetailsBlock: ({
    summary,
    children,
  }: {
    summary: React.ReactNode
    children: React.ReactNode
  }) => (
    <div data-testid="details-block">
      <div data-testid="details-summary">{summary}</div>
      <div data-testid="details-body">{children}</div>
    </div>
  ),
}))
jest.mock("@/components/chat/renderers/kbd-inline", () => ({
  KbdInline: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="kbd-inline">{children}</span>
  ),
}))
jest.mock("@/components/chat/renderers/task-list", () => ({
  TaskListItem: ({ checked, children }: { checked: boolean; children: React.ReactNode }) => (
    <li data-testid="task-item" data-checked={String(checked)}>
      {children}
    </li>
  ),
}))

const messages = {
  chat: { renderers: { details: { defaultSummary: "Details" } } },
}

function renderNode(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

describe("createSharedMarkdownComponents — img routing", () => {
  it("drops an image with no usable src", () => {
    const { img: Img } = createSharedMarkdownComponents()
    const { container } = renderNode(<Img />)
    expect(container).toBeEmptyDOMElement()
  })

  it("routes a video URL to VideoBlock before the image path", () => {
    const { img: Img } = createSharedMarkdownComponents()
    renderNode(<Img src="https://cdn.example.com/clip.mp4" alt="clip" />)
    expect(screen.getByTestId("video-block")).toHaveAttribute("data-title", "clip")
    expect(screen.queryByTestId("image-block")).not.toBeInTheDocument()
  })

  it("routes an audio URL to AudioBlock", () => {
    const { img: Img } = createSharedMarkdownComponents()
    renderNode(<Img src="https://cdn.example.com/song.mp3" title="song" />)
    expect(screen.getByTestId("audio-block")).toHaveAttribute("data-title", "song")
  })

  it("routes a plain image to the enhanced ImageBlock by default", () => {
    const { img: Img } = createSharedMarkdownComponents()
    renderNode(<Img src="https://cdn.example.com/pic.png" alt="pic" title="a title" />)
    const block = screen.getByTestId("image-block")
    expect(block).toHaveAttribute("data-src", "https://cdn.example.com/pic.png")
    expect(block).toHaveAttribute("data-alt", "pic")
    expect(block).toHaveAttribute("data-title", "a title")
  })

  it("falls back to a bare lazy <img> when enhanced images are disabled", () => {
    const { img: Img } = createSharedMarkdownComponents({ enableEnhancedImages: false })
    renderNode(<Img src="https://cdn.example.com/pic.png" alt="pic" />)
    expect(screen.queryByTestId("image-block")).not.toBeInTheDocument()
    const el = screen.getByAltText("pic")
    expect(el.tagName).toBe("IMG")
    expect(el).toHaveAttribute("loading", "lazy")
  })

  it("keeps video/audio URLs on the image path when the embeds are disabled", () => {
    const { img: Img } = createSharedMarkdownComponents({
      enableVideoEmbed: false,
      enableAudioEmbed: false,
    })
    renderNode(<Img src="https://cdn.example.com/clip.mp4" alt="clip" />)
    expect(screen.queryByTestId("video-block")).not.toBeInTheDocument()
    expect(screen.getByTestId("image-block")).toBeInTheDocument()
  })
})

describe("createSharedMarkdownComponents — blockquote alerts", () => {
  it("promotes a GitHub alert blockquote to AlertBlock", () => {
    const { blockquote: Blockquote } = createSharedMarkdownComponents()
    renderNode(<Blockquote>{"[!WARNING]\nmind the gap"}</Blockquote>)
    const alert = screen.getByTestId("alert-block")
    expect(alert).toHaveAttribute("data-type", "warning")
    expect(alert).toHaveTextContent("mind the gap")
  })

  it("leaves an ordinary blockquote alone", () => {
    const { blockquote: Blockquote } = createSharedMarkdownComponents()
    const { container } = renderNode(<Blockquote>just a quote</Blockquote>)
    expect(screen.queryByTestId("alert-block")).not.toBeInTheDocument()
    expect(container.querySelector("blockquote")).toHaveTextContent("just a quote")
  })

  it("does not promote alerts when they are disabled", () => {
    const { blockquote: Blockquote } = createSharedMarkdownComponents({ enableAlerts: false })
    const { container } = renderNode(<Blockquote>{"[!NOTE]\nhello"}</Blockquote>)
    expect(screen.queryByTestId("alert-block")).not.toBeInTheDocument()
    expect(container.querySelector("blockquote")).toBeInTheDocument()
  })
})

describe("createSharedMarkdownComponents — details", () => {
  it("lifts a <summary> child into the DetailsBlock summary slot", () => {
    const { details: Details } = createSharedMarkdownComponents()
    renderNode(
      <Details>
        <summary>Why this happened</summary>
        <p>because</p>
      </Details>
    )
    expect(screen.getByTestId("details-summary")).toHaveTextContent("Why this happened")
    expect(screen.getByTestId("details-body")).toHaveTextContent("because")
  })

  it("uses the translated fallback summary when the markdown omits one", () => {
    const { details: Details } = createSharedMarkdownComponents()
    renderNode(
      <Details>
        <p>orphan body</p>
      </Details>
    )
    expect(screen.getByTestId("details-summary")).toHaveTextContent("Details")
    expect(screen.getByTestId("details-body")).toHaveTextContent("orphan body")
  })
})

describe("createSharedMarkdownComponents — lists and inline", () => {
  it("routes a GFM task item to TaskListItem and keeps its label", () => {
    const { li: Li } = createSharedMarkdownComponents()
    renderNode(
      <Li>
        <input type="checkbox" checked readOnly />
        {"ship it"}
      </Li>
    )
    const item = screen.getByTestId("task-item")
    expect(item).toHaveAttribute("data-checked", "true")
    expect(item).toHaveTextContent("ship it")
  })

  it("leaves an ordinary list item as a plain <li>", () => {
    const { li: Li } = createSharedMarkdownComponents()
    renderNode(<Li>plain</Li>)
    expect(screen.queryByTestId("task-item")).not.toBeInTheDocument()
    expect(screen.getByText("plain").tagName).toBe("LI")
  })

  it("renders kbd through KbdInline", () => {
    const { kbd: Kbd } = createSharedMarkdownComponents()
    renderNode(<Kbd>Ctrl</Kbd>)
    expect(screen.getByTestId("kbd-inline")).toHaveTextContent("Ctrl")
  })

  it("renders the structural elements", () => {
    const c = createSharedMarkdownComponents()
    const { container } = renderNode(
      <div>
        <c.ul>
          <li>a</li>
        </c.ul>
        <c.ol>
          <li>b</li>
        </c.ol>
        <c.p>para</c.p>
        <c.hr />
      </div>
    )
    expect(container.querySelector("ul")).toHaveClass("list-disc")
    expect(container.querySelector("ol")).toHaveClass("list-decimal")
    expect(container.querySelector("p")).toHaveTextContent("para")
    expect(container.querySelector("hr")).toBeInTheDocument()
  })

  it("wraps tables in a horizontally scrollable container", () => {
    const c = createSharedMarkdownComponents()
    const { container } = renderNode(
      <c.table>
        <thead>
          <tr>
            <c.th>head</c.th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <c.td>cell</c.td>
          </tr>
        </tbody>
      </c.table>
    )
    expect(container.querySelector(".overflow-x-auto")).toBeInTheDocument()
    expect(screen.getByText("head").tagName).toBe("TH")
    expect(screen.getByText("cell").tagName).toBe("TD")
  })
})

describe("helpers", () => {
  it("parseTaskListItem returns null without a checkbox child", () => {
    expect(parseTaskListItem(<span>no box</span>)).toBeNull()
  })

  it("parseTaskListItem reports the unchecked state and strips the input", () => {
    const parsed = parseTaskListItem([
      <input key="i" type="checkbox" readOnly />,
      <span key="s">todo</span>,
    ])
    expect(parsed?.checked).toBe(false)
    expect(parsed?.label).toHaveLength(1)
  })

  it("extractTextContent walks strings, numbers, arrays and elements", () => {
    expect(extractTextContent("a")).toBe("a")
    expect(extractTextContent(7)).toBe("7")
    expect(extractTextContent(["a", 1])).toBe("a1")
    expect(extractTextContent(<span>deep</span>)).toBe("deep")
    expect(extractTextContent(null)).toBe("")
  })

  it("isVideoUrl matches extensions and known hosts, and tolerates junk", () => {
    expect(isVideoUrl("https://x.test/a.mp4")).toBe(true)
    expect(isVideoUrl("https://www.youtube.com/watch?v=1")).toBe(true)
    expect(isVideoUrl("https://x.test/a.png")).toBe(false)
    expect(isVideoUrl("not a url")).toBe(false)
  })

  it("isAudioUrl matches audio extensions only", () => {
    expect(isAudioUrl("https://x.test/a.flac")).toBe(true)
    expect(isAudioUrl("https://x.test/a.mp4")).toBe(false)
  })
})
