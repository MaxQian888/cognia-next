/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import {
  TABLE_AUTO_RENDER_MAX_ROWS,
  countRowCells,
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

  // jsdom applies no stylesheet, so these assert the CONTRACT that lets typeset
  // own the rhythm: the block elements carry no competing utility. A stray
  // `my-2` here would silently outrank typeset (utilities layer beats
  // components) and the preset knobs would stop moving these elements.
  it("leaves the block elements bare so the typeset preset owns their rhythm", () => {
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
    expect(container.querySelector("ul")).not.toHaveAttribute("class")
    expect(container.querySelector("ol")).not.toHaveAttribute("class")
    expect(container.querySelector("p")).toHaveTextContent("para")
    expect(container.querySelector("p")).not.toHaveAttribute("class")
    expect(container.querySelector("hr")).toBeInTheDocument()
    expect(container.querySelector("hr")).not.toHaveAttribute("class")
  })

  it("keeps the Cognia accent on blockquotes but not their spacing", () => {
    const { blockquote: Blockquote } = createSharedMarkdownComponents({ enableAlerts: false })
    const { container } = renderNode(<Blockquote>quoted</Blockquote>)
    const quote = container.querySelector("blockquote")
    expect(quote).toHaveClass("border-l-4", "border-primary/30", "italic", "text-muted-foreground")
    // Indent and vertical rhythm belong to typeset.
    expect(quote?.className).not.toMatch(/\bpl-\d|\bmy-\d/)
  })

  it("wraps tables in typeset's own wide-block scroller", () => {
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
    expect(container.querySelector(".typeset-scroll")).toBeInTheDocument()
    expect(screen.getByText("head").tagName).toBe("TH")
    expect(screen.getByText("cell").tagName).toBe("TD")
    // The grid and the header fill stay ours, and the cell padding has to as
    // well — typeset zeroes `padding-inline-start` on first-column cells.
    expect(screen.getByText("head")).toHaveClass("border", "bg-muted", "px-4", "py-2")
    expect(screen.getByText("cell")).toHaveClass("border", "px-4", "py-2")
  })
})

// Headings live here rather than on the finalised branch alone: styled only by
// `MarkdownRenderer`, they rendered at body size for the whole stream and then
// snapped when the turn finalised. Sharing one definition is what keeps the two
// branches identical.
describe("createSharedMarkdownComponents — headings", () => {
  const LEVELS = [1, 2, 3, 4, 5, 6] as const

  it.each(LEVELS)("renders h%i with no size of its own so typeset scales it", (level) => {
    const c = createSharedMarkdownComponents()
    const Heading = c[`h${level}` as const]
    renderNode(<Heading>title</Heading>)
    const heading = screen.getByRole("heading", { level })
    // `scroll-mt-20` clears the sticky chat header on a permalink jump —
    // typeset's own `scroll-margin-block-start` is one flow step, far too
    // small — so it is the one utility a heading is allowed to carry.
    expect(heading).toHaveClass("scroll-mt-20")
    // An absolute `text-2xl` would not track the container, which is the whole
    // reason the heading scale moved to typeset's `em`-relative one.
    expect(heading.className).not.toMatch(/\btext-(xs|sm|base|lg|xl|\dxl)\b/)
    expect(heading.className).not.toMatch(/\bfont-(bold|semibold|medium)\b/)
    // Anchored on a class boundary: `\b` alone also matches inside
    // `scroll-mt-20`, which is the one margin utility a heading keeps.
    expect(heading.className).not.toMatch(/(^|\s)m[tb]-\d/)
  })

  it("neutralises typeset's uppercase label treatment on h6", () => {
    const { h6: H6 } = createSharedMarkdownComponents()
    renderNode(<H6>small heading</H6>)
    // Upstream renders h6 as an uppercase, letter-spaced label. This product
    // does not use that treatment, but the 0.8125em size stays — pinning h6
    // back to `text-sm` would make it larger than h5.
    expect(screen.getByRole("heading", { level: 6 })).toHaveClass("normal-case", "tracking-normal")
  })

  it("passes a rehype-assigned id through and omits it mid-stream", () => {
    const { h2: H2 } = createSharedMarkdownComponents()
    const { rerender } = renderNode(<H2 id="why-it-broke">Why it broke</H2>)
    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute("id", "why-it-broke")

    // The streaming branch runs no `rehypeMarkdownHeadingIds`, so `id` is absent.
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <H2>Why it broke</H2>
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("heading", { level: 2 })).not.toHaveAttribute("id")
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

describe("table row budget", () => {
  const row = (i: number) => (
    <tr key={i}>
      <td>{`cell ${i}`}</td>
      <td>{`other ${i}`}</td>
    </tr>
  )

  function renderBody(count: number) {
    const components = createSharedMarkdownComponents()
    const Tbody = components.tbody as React.ComponentType<{ children?: React.ReactNode }>
    return render(
      <table>
        <Tbody>{Array.from({ length: count }, (_, i) => row(i))}</Tbody>
      </table>
    )
  }

  it("renders a small table in full, with no notice", () => {
    const { container, queryByRole } = renderBody(5)

    expect(container.querySelectorAll("tbody tr")).toHaveLength(5)
    expect(queryByRole("button", { name: /show all/i })).toBeNull()
  })

  it("leaves a table exactly at the budget untouched", () => {
    const { container, queryByRole } = renderBody(TABLE_AUTO_RENDER_MAX_ROWS)

    expect(container.querySelectorAll("tbody tr")).toHaveLength(TABLE_AUTO_RENDER_MAX_ROWS)
    expect(queryByRole("button", { name: /show all/i })).toBeNull()
  })

  it("caps an oversized table and says what it withheld", () => {
    const { container, getByRole } = renderBody(TABLE_AUTO_RENDER_MAX_ROWS + 50)

    // Capped rows plus the one notice row.
    expect(container.querySelectorAll("tbody tr")).toHaveLength(TABLE_AUTO_RENDER_MAX_ROWS + 1)
    expect(getByRole("button", { name: /show all/i })).toBeInTheDocument()
    // The notice text itself is i18n's job (and `lint:i18n` + the ICU
    // validator cover it); what matters here is that rows were withheld and
    // the reader is told so.
    expect(container.textContent).toContain("rows")
    expect(container.textContent).not.toContain("cell 200")
  })

  it("spans the notice across every column", () => {
    const { container } = renderBody(TABLE_AUTO_RENDER_MAX_ROWS + 1)
    const notice = container.querySelector("tbody tr:last-child td")

    expect(notice?.getAttribute("colspan")).toBe("2")
  })

  it("renders every row once the reader asks", () => {
    const { container, getByRole } = renderBody(TABLE_AUTO_RENDER_MAX_ROWS + 50)

    fireEvent.click(getByRole("button", { name: /show all/i }))

    expect(container.querySelectorAll("tbody tr")).toHaveLength(TABLE_AUTO_RENDER_MAX_ROWS + 50)
  })
})

describe("countRowCells", () => {
  it("counts the cells of a row", () => {
    expect(
      countRowCells(
        <tr>
          <td>a</td>
          <td>b</td>
          <td>c</td>
        </tr>
      )
    ).toBe(3)
  })

  it("falls back to a single column for anything unrecognisable", () => {
    expect(countRowCells("not an element")).toBe(1)
    expect(countRowCells(undefined)).toBe(1)
    expect(countRowCells(<tr />)).toBe(1)
  })
})
