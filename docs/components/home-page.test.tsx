/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react"
import type { HomeGroup } from "../lib/home-sections"
import { HomePage } from "./home-page"

const setOpenSearch = jest.fn()
let searchEnabled = true

jest.mock("fumadocs-ui/contexts/search", () => ({
  useSearchContext: () => ({ enabled: searchEnabled, open: false, hotKey: [], setOpenSearch }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const groups: HomeGroup[] = [
  {
    label: "Core architecture",
    sections: [
      {
        title: "Core Architecture",
        href: "/en/docs/core/architecture",
        pageCount: 3,
        preview: ["Architecture", "Runtime", "Sidecar"],
      },
    ],
  },
  {
    label: "Technical reference",
    sections: [
      { title: "ADR", href: "/en/docs/adr", pageCount: 220, preview: ["ADR index"] },
      { title: "Plugins", href: "/en/docs/plugins/ocr", pageCount: 4, preview: ["OCR"] },
    ],
  },
]

function renderHome(overrides: Partial<React.ComponentProps<typeof HomePage>> = {}) {
  return render(
    <HomePage
      lang="en"
      groups={groups}
      gettingStartedHref="/en/docs/getting-started"
      overviewHref="/en/docs"
      repoUrl="https://github.com/MaxQian888/cognia-next"
      websiteUrl="https://cognia.example"
      {...overrides}
    />
  )
}

beforeEach(() => {
  setOpenSearch.mockClear()
  searchEnabled = true
})

describe("HomePage hero", () => {
  it("leads with the title and both calls to action", () => {
    renderHome()
    expect(screen.getByRole("heading", { level: 1, name: "title" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /primaryCta/ })).toHaveAttribute(
      "href",
      "/en/docs/getting-started"
    )
    expect(screen.getByRole("link", { name: "secondaryCta" })).toHaveAttribute("href", "/en/docs")
  })

  it("opens the site search from the hero", () => {
    renderHome()
    fireEvent.click(screen.getByRole("button", { name: /searchHint/ }))
    expect(setOpenSearch).toHaveBeenCalledWith(true)
  })

  it("hides the search trigger when search is disabled", () => {
    searchEnabled = false
    renderHome()
    expect(screen.queryByRole("button", { name: /searchHint/ })).toBeNull()
  })

  it("links the website in the reader's language, and omits it when unconfigured", () => {
    const { unmount } = renderHome({ lang: "zh" })
    expect(screen.getByRole("link", { name: /website/ })).toHaveAttribute(
      "href",
      "https://cognia.example/zh"
    )
    unmount()
    renderHome({ websiteUrl: null })
    expect(screen.queryByRole("link", { name: /website/ })).toBeNull()
    expect(screen.getByRole("link", { name: /github/ })).toHaveAttribute(
      "href",
      "https://github.com/MaxQian888/cognia-next"
    )
  })
})

describe("HomePage area index", () => {
  it("renders a card per area, tagged with its group", () => {
    renderHome()
    expect(screen.getAllByRole("listitem")).toHaveLength(3)
    expect(
      within(screen.getByRole("link", { name: /Plugins/ })).getByText("Technical reference")
    ).toBeInTheDocument()
    const adr = screen.getByRole("link", { name: /ADR/ })
    expect(adr).toHaveAttribute("href", "/en/docs/adr")
    expect(within(adr).getByText('pageCount:{"count":220}')).toBeInTheDocument()
  })

  it("previews the first pages of an area", () => {
    renderHome()
    const core = screen.getByRole("link", { name: /Core Architecture/ })
    for (const name of ["Architecture", "Runtime", "Sidecar"]) {
      expect(within(core).getByText(name)).toBeInTheDocument()
    }
  })

  it("points agents at the locale's llms-full export", () => {
    renderHome({ lang: "zh" })
    expect(screen.getByRole("link", { name: "llmsFull" })).toHaveAttribute(
      "href",
      "/zh/llms-full.txt"
    )
    expect(screen.getByRole("link", { name: "llmsIndex" })).toHaveAttribute("href", "/llms.txt")
  })
})
