/**
 * @jest-environment jsdom
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { fireEvent, render, screen } from "@testing-library/react"

import { SubPageShell } from "./sub-page-shell"

const backMock = jest.fn()
const replaceMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ back: backMock, replace: replaceMock, push: jest.fn() }),
}))

describe("<SubPageShell />", () => {
  beforeEach(() => {
    backMock.mockReset()
    replaceMock.mockReset()
  })

  it("does not mark itself a settings panel by default", () => {
    // Most /me pages are bespoke phone screens whose grouped rounded rows are
    // the iOS convention on purpose. Flattening those would be a downgrade.
    const { container } = render(
      <SubPageShell title="Conversation" backAria="Back">
        <p>body</p>
      </SubPageShell>
    )
    expect(container.querySelector("[data-settings-panel]")).toBeNull()
  })

  it("marks the body a settings panel on request, so an embedded desktop section flattens", () => {
    // The flattening is `[data-settings-panel] [data-slot="card"]` in
    // components/ui/card.tsx and globals.css, and only SettingsShell used to
    // set the attribute. The same <AppearanceSection /> therefore rendered as
    // hairline blocks on the desktop panel and as a bordered, tinted card that
    // framed the whole page on /me/appearance.
    const { container } = render(
      <SubPageShell title="Appearance" backAria="Back" settingsPanel>
        <p>body</p>
      </SubPageShell>
    )
    const panel = container.querySelector("[data-settings-panel]")
    expect(panel).not.toBeNull()
    expect(panel).toContainElement(screen.getByText("body"))
  })

  it("renders the title, back link, and children", () => {
    render(
      <SubPageShell title="同步状态" backAria="Back to Me" testid="shell-sync">
        <div data-testid="body">body content</div>
      </SubPageShell>
    )
    expect(screen.getByText("同步状态")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
    const back = screen.getByTestId("mobile-sub-page-back")
    expect(back).toHaveAttribute("aria-label", "Back to Me")
  })

  it("back pops history when there is an entry to pop", () => {
    // jsdom starts with history.length ≥ 1; push one entry so length > 1.
    window.history.pushState(null, "", "/me/backup")
    render(
      <SubPageShell title="备份" backAria="Back">
        body
      </SubPageShell>
    )
    fireEvent.click(screen.getByTestId("mobile-sub-page-back"))
    // Popping (not pushing `/me`) keeps hardware-back from returning the
    // user to the subpage they just left.
    expect(backMock).toHaveBeenCalled()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("falls back to replace(backHref) when history has nothing to pop", () => {
    const lengthSpy = jest.spyOn(window.history, "length", "get").mockReturnValue(1)
    try {
      render(
        <SubPageShell title="离线" backAria="Back" backHref="/">
          body
        </SubPageShell>
      )
      fireEvent.click(screen.getByTestId("mobile-sub-page-back"))
      expect(replaceMock).toHaveBeenCalledWith("/")
      expect(backMock).not.toHaveBeenCalled()
    } finally {
      lengthSpy.mockRestore()
    }
  })

  it("renders the headerAccessory slot when provided", () => {
    render(
      <SubPageShell
        title="Connectors"
        backAria="Back"
        headerAccessory={<div data-testid="accessory">badge</div>}
      >
        body
      </SubPageShell>
    )
    expect(screen.getByTestId("accessory")).toBeInTheDocument()
  })

  it("respects bodyClassName override", () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back" bodyClassName="px-2 py-2">
        body
      </SubPageShell>
    )
    expect(container.querySelector("section")?.className).toMatch(/px-2/)
  })

  it("centers content within a max width on large screens", () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back">
        body
      </SubPageShell>
    )
    // Body section + header inner row both clamp to a centered max width so
    // the page reads correctly on tablets / landscape, not edge-to-edge.
    expect(container.querySelector("section")?.className).toMatch(/max-w-2xl/)
    expect(container.querySelector("header > div")?.className).toMatch(/max-w-2xl/)
  })

  it("lets the body fill the screen it owns, so an empty state can centre", () => {
    // Without `flex-1` on the body, a page whose entire content is an empty
    // state (every PairedOnly gate) rendered as a stub pinned to the top of
    // 700px of blank. `min-h-0` keeps a scrolling child from overflowing.
    const { container } = render(
      <SubPageShell title="X" backAria="Back">
        body
      </SubPageShell>
    )
    const section = container.querySelector("section")?.className ?? ""
    expect(section).toMatch(/\bflex\b/)
    expect(section).toMatch(/\bflex-1\b/)
    expect(section).toMatch(/\bmin-h-0\b/)
    expect(section).toMatch(/\bflex-col\b/)
  })

  it("keeps the default width without the lg relaxation", () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back">
        body
      </SubPageShell>
    )
    expect(container.querySelector("section")?.className).not.toMatch(/lg:max-w-4xl/)
    expect(container.querySelector("header > div")?.className).not.toMatch(/lg:max-w-4xl/)
  })

  it('relaxes the clamp to lg:max-w-4xl when width="wide"', () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back" width="wide">
        body
      </SubPageShell>
    )
    // Both the body and the sticky header widen together so the back button
    // stays aligned with the content edge on large tablets.
    expect(container.querySelector("section")?.className).toMatch(/max-w-2xl/)
    expect(container.querySelector("section")?.className).toMatch(/lg:max-w-4xl/)
    expect(container.querySelector("header > div")?.className).toMatch(/lg:max-w-4xl/)
  })
})

describe("/me pages that embed a desktop settings section", () => {
  // The flattening only fires under `[data-settings-panel]`, so a page that
  // renders a `components/settings/` section without the prop ships that
  // section as a bordered card framing the whole phone screen. Nothing in the
  // type system can catch that, so the catalogue is walked instead.
  const meDir = join(process.cwd(), "app", "me")

  const pagesEmbeddingSettings = readdirSync(meDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ route: entry.name, file: join(meDir, entry.name, "page.tsx") }))
    .map((page) => {
      let source = ""
      try {
        source = readFileSync(page.file, "utf8")
      } catch {
        return null
      }
      return { ...page, source }
    })
    .filter(
      (page): page is { route: string; file: string; source: string } =>
        page !== null &&
        page.source.includes('from "@/components/settings/') &&
        page.source.includes("<SubPageShell")
    )

  it("found pages to check, so an empty walk cannot pass silently", () => {
    expect(pagesEmbeddingSettings.length).toBeGreaterThan(15)
  })

  it.each(pagesEmbeddingSettings.map((page) => [page.route, page.source]))(
    "/me/%s marks its body a settings panel",
    (_route, source) => {
      expect(source).toContain("settingsPanel")
    }
  )
})
