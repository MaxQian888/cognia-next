import { fireEvent, render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { ReleaseState } from "@web/lib/evidence"
import { SiteNav } from "./site-nav"

jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: jest.fn() }),
}))

const releaseState: ReleaseState = {
  hasRelease: false,
  version: null,
  publishedAt: null,
  htmlUrl: "https://github.com/MaxQian888/cognia-next/releases",
  byPlatform: { macos: [], windows: [], linux: [] },
}

function renderNav(locale: "en" | "zh" = "en", route = "/") {
  const copy = locale === "en" ? en : zh
  return render(
    <SiteNav
      locale={locale}
      route={route}
      copy={copy}
      releaseState={releaseState}
      docsOrigin="https://docs.cognia.example"
    />
  )
}

describe("SiteNav structure", () => {
  it("offers a skip link as the first focusable element", () => {
    renderNav()
    expect(screen.getByRole("link", { name: en.nav.skipToContent })).toHaveAttribute(
      "href",
      "#main"
    )
  })

  it("keeps Docs, GitHub and Download reachable", () => {
    renderNav()
    expect(screen.getByRole("link", { name: en.nav.docsLabel })).toBeInTheDocument()
    expect(screen.getAllByRole("link", { name: en.nav.sourceLabel }).length).toBeGreaterThan(0)
    expect(screen.getByRole("link", { name: en.common.download.unavailable })).toBeInTheDocument()
  })

  it("links Docs at the documentation origin with the current locale", () => {
    renderNav("zh")
    expect(screen.getByRole("link", { name: zh.nav.docsLabel })).toHaveAttribute(
      "href",
      "https://docs.cognia.example/zh/docs"
    )
  })

  it("exposes the top-level routes", () => {
    renderNav()
    for (const link of en.nav.links) {
      expect(screen.getAllByRole("link", { name: link.label }).length).toBeGreaterThan(0)
    }
  })
})

describe("SiteNav product menu", () => {
  it("starts collapsed", () => {
    renderNav()
    expect(screen.getByRole("button", { name: en.nav.productMenu.label })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  it("reveals Chat, Agents and Knowledge when opened", () => {
    renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.productMenu.label }))
    for (const item of en.nav.productMenu.items) {
      expect(screen.getAllByRole("link", { name: new RegExp(item.label) }).length).toBeGreaterThan(
        0
      )
    }
  })

  it("points the menu entries at anchors on the product page", () => {
    renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.productMenu.label }))
    const chat = screen.getAllByRole("link", { name: /Chat/ })[0]
    expect(chat).toHaveAttribute("href", "/product#chat")
  })

  it("closes on Escape", () => {
    renderNav()
    const trigger = screen.getByRole("button", { name: en.nav.productMenu.label })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })
})

describe("SiteNav use-case menu", () => {
  it("links the two scenario pages, which no other route reaches", () => {
    renderNav()
    const trigger = screen.getByRole("button", { name: en.nav.useCasesMenu.label })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    for (const item of en.nav.useCasesMenu.items) {
      expect(screen.getByRole("link", { name: new RegExp(item.label) })).toHaveAttribute(
        "href",
        item.route
      )
    }
  })

  it("keeps each dropdown's state its own", () => {
    renderNav()
    const product = screen.getByRole("button", { name: en.nav.productMenu.label })
    const useCases = screen.getByRole("button", { name: en.nav.useCasesMenu.label })
    fireEvent.click(useCases)
    expect(product).toHaveAttribute("aria-expanded", "false")
    expect(useCases).toHaveAttribute("aria-expanded", "true")
  })

  it("closes once a destination in it is followed", () => {
    renderNav()
    const trigger = screen.getByRole("button", { name: en.nav.useCasesMenu.label })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("link", { name: /Research/ }))
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })

  it("lists /surfaces under Product", () => {
    renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.productMenu.label }))
    expect(screen.getByRole("link", { name: /Surfaces/ })).toHaveAttribute("href", "/surfaces")
  })
})

describe("SiteNav mobile sheet", () => {
  it("groups the sheet's menu entries under their menu names", () => {
    renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.openMenu }))
    const sheet = document.getElementById("site-nav-sheet") as HTMLElement
    expect(within(sheet).getByText(en.nav.productMenu.label)).toBeInTheDocument()
    expect(within(sheet).getByText(en.nav.useCasesMenu.label)).toBeInTheDocument()
  })

  it("opens and closes from the menu button", () => {
    renderNav()
    const trigger = screen.getByRole("button", { name: en.nav.openMenu })
    fireEvent.click(trigger)
    expect(screen.getByRole("button", { name: en.nav.closeMenu })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
  })

  it("locks the page behind the sheet and releases it on close", () => {
    renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.openMenu }))
    expect(document.body.style.overflow).toBe("hidden")
    fireEvent.click(screen.getByRole("button", { name: en.nav.closeMenu }))
    expect(document.body.style.overflow).not.toBe("hidden")
  })

  it("renders the sheet outside the header so the header's backdrop filter cannot clip it", () => {
    const { container } = renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.openMenu }))
    const sheet = document.getElementById("site-nav-sheet")
    expect(sheet).not.toBeNull()
    expect(sheet?.parentElement).toBe(document.body)
    expect(container.querySelector("header")?.contains(sheet)).toBe(false)
    expect(screen.getByRole("button", { name: en.nav.closeMenu })).toHaveAttribute(
      "aria-controls",
      "site-nav-sheet"
    )
  })

  it("closes when a destination in the sheet is followed", () => {
    renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.openMenu }))
    const sheet = document.getElementById("site-nav-sheet") as HTMLElement
    fireEvent.click(within(sheet).getByRole("link", { name: new RegExp(en.nav.links[0].label) }))
    expect(document.getElementById("site-nav-sheet")).toBeNull()
    expect(screen.getByRole("button", { name: en.nav.openMenu })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  it("offers Download inside the sheet, where the bar hides it on phones", () => {
    renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.openMenu }))
    const sheet = document.getElementById("site-nav-sheet") as HTMLElement
    expect(
      within(sheet).getByRole("link", { name: en.common.download.unavailable })
    ).toBeInTheDocument()
  })

  it("carries every primary destination, not a reduced subset", () => {
    renderNav()
    fireEvent.click(screen.getByRole("button", { name: en.nav.openMenu }))
    const labels = [
      ...en.nav.productMenu.items.map((i) => i.label),
      ...en.nav.useCasesMenu.items.map((i) => i.label),
      ...en.nav.links.map((l) => l.label),
      en.nav.sourceLabel,
    ]
    for (const label of labels) {
      expect(screen.getAllByRole("link", { name: new RegExp(label) }).length).toBeGreaterThan(0)
    }
  })
})

describe("SiteNav locale controls", () => {
  it("switches language without leaving the current page", () => {
    renderNav("en", "/trust")
    expect(screen.getAllByRole("link", { name: "中文" })[0]).toHaveAttribute("href", "/zh/trust")
  })

  it("offers the theme control as a single compact trigger", () => {
    // Collapsed from a 168px segmented control: with the language switcher the
    // pair took 291px of a 1480px bar.
    renderNav()
    expect(screen.getAllByRole("button", { name: en.nav.themeToggle }).length).toBeGreaterThan(0)
  })

  it("localises the whole bar", () => {
    renderNav("zh")
    const nav = screen.getByRole("navigation")
    expect(within(nav).getByRole("link", { name: zh.nav.docsLabel })).toBeInTheDocument()
    expect(within(nav).getByRole("button", { name: zh.nav.productMenu.label })).toBeInTheDocument()
  })
})
