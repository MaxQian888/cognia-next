/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import type { BrowserApi } from "@ext/src/lib/browser-api"

import { MarkdownView } from "./markdown-view"

function api() {
  const opened: string[] = []
  return {
    opened,
    api: {
      openUrl: async (url: string) => {
        opened.push(url)
      },
    } as unknown as BrowserApi,
  }
}

describe("MarkdownView", () => {
  it("renders structure as elements", () => {
    const { api: fake } = api()
    const { container } = render(
      <MarkdownView
        api={fake}
        source={
          "# Title\n\n- **one**\n- `two`\n\n1. a\n\n> quoted\n\n| h |\n|---|\n| c |\n\n```\ncode\n```\n\n---"
        }
      />
    )
    expect(container.querySelector("h3")?.textContent).toBe("Title")
    expect(container.querySelector("ul strong")?.textContent).toBe("one")
    expect(container.querySelector("ul code")?.textContent).toBe("two")
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("1")
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted")
    expect(container.querySelector("th")?.textContent).toBe("h")
    expect(container.querySelector("td")?.textContent).toBe("c")
    expect(container.querySelector("pre")?.textContent).toBe("code")
    expect(container.querySelector("hr")).not.toBeNull()
  })

  it("never renders markup from the answer", () => {
    const { api: fake } = api()
    const { container } = render(
      <MarkdownView api={fake} source={'<img src=x onerror="alert(1)"> <b>bold</b>'} />
    )
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("b")).toBeNull()
    expect(container.textContent).toContain("<b>bold</b>")
  })

  it("opens links through the extension rather than in the panel", () => {
    const { api: fake, opened } = api()
    render(<MarkdownView api={fake} source="[docs](https://docs.test/a)" />)
    const link = screen.getByText("docs")
    expect(link.closest("a")?.getAttribute("rel")).toBe("noreferrer noopener")
    fireEvent.click(link)
    expect(opened).toEqual(["https://docs.test/a"])
  })
})
