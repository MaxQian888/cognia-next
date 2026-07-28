import { render, screen, within } from "@testing-library/react"
import { en } from "@web/content/en"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

/**
 * `download-page.test.tsx` runs against the committed evidence snapshot, which
 * has no published release — so the entire installer table, the version line
 * and the "all platforms" link never render there. This file supplies a
 * snapshot that has one, which is the state the page exists for.
 *
 * A separate file rather than `jest.resetModules()` in that one: reset plus a
 * dynamic import hands the page a second React instance and its hooks then run
 * with a null dispatcher.
 */
jest.mock("@web/content/generated/evidence.json", () => ({
  ...jest.requireActual("@web/content/generated/evidence.json"),
  releases: [
    {
      tagName: "v0.2.0",
      name: "Cognia 0.2.0",
      prerelease: false,
      publishedAt: "2026-07-01T00:00:00Z",
      htmlUrl: "https://example.test/releases/v0.2.0",
      body: "Ships the notice area.",
      assets: [
        { name: "Cognia_0.2.0_universal.dmg", url: "https://example.test/mac.dmg", size: 1 },
        { name: "Cognia_0.2.0_x64.msi", url: "https://example.test/win.msi", size: 2 },
        {
          name: "Cognia_0.2.0_amd64.AppImage",
          url: "https://example.test/linux.AppImage",
          size: 3,
        },
        // Carries no platform token — must not land in any column.
        { name: "checksums.txt", url: "https://example.test/checksums.txt", size: 4 },
      ],
    },
  ],
}))

import { DownloadPage } from "./download-page"

describe("DownloadPage with a published release", () => {
  it("names the version and publication date instead of a hand-written string", () => {
    render(<DownloadPage locale="en" />)
    expect(screen.getByText(en.download.platformsTitle)).toBeInTheDocument()
    // The version line under the section title — the CTA above also names the
    // tag, so this is scoped to the one that carries the publication date.
    expect(
      screen.getByText((_, node) => {
        const text = node?.textContent ?? ""
        return (
          node?.tagName === "P" &&
          text.includes(en.common.download.version) &&
          text.includes("v0.2.0") &&
          text.includes(en.common.download.published)
        )
      })
    ).toBeInTheDocument()
  })

  it("files each installer under the platform it targets", () => {
    render(<DownloadPage locale="en" />)
    expect(screen.getByRole("link", { name: "Cognia_0.2.0_universal.dmg" })).toHaveAttribute(
      "href",
      "https://example.test/mac.dmg"
    )
    expect(screen.getByRole("link", { name: "Cognia_0.2.0_x64.msi" })).toHaveAttribute(
      "href",
      "https://example.test/win.msi"
    )
    expect(screen.getByRole("link", { name: "Cognia_0.2.0_amd64.AppImage" })).toHaveAttribute(
      "href",
      "https://example.test/linux.AppImage"
    )
  })

  it("leaves an asset whose name names no platform out of the table", () => {
    render(<DownloadPage locale="en" />)
    expect(screen.queryByRole("link", { name: "checksums.txt" })).toBeNull()
  })

  it("links out to the full release for anything the table does not cover", () => {
    render(<DownloadPage locale="en" />)
    const link = screen.getByRole("link", { name: en.common.download.allPlatforms })
    expect(link).toHaveAttribute("href", "https://example.test/releases/v0.2.0")
    expect(link).toHaveAttribute("rel", "noreferrer")
  })

  it("still offers the build-from-source route beside the installers", () => {
    render(<DownloadPage locale="en" />)
    expect(screen.getByText(en.download.buildFromSource.title)).toBeInTheDocument()
  })

  it("localises the released surface", () => {
    render(<DownloadPage locale="zh" />)
    const { zh } = jest.requireActual("@web/content/zh") as typeof import("@web/content/zh")
    expect(screen.getByText(zh.download.platformsTitle)).toBeInTheDocument()
  })

  it("groups the columns in a stable platform order", () => {
    const { container } = render(<DownloadPage locale="en" />)
    const grid = container.querySelector(".md\\:grid-cols-3")
    expect(grid).not.toBeNull()
    const columns = within(grid as HTMLElement).getAllByRole("listitem")
    expect(columns.length).toBe(3)
  })
})
