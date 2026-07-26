import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { ReleaseState } from "@web/lib/evidence"
import { DownloadCta } from "./download-cta"

const RELEASES_URL = "https://github.com/MaxQian888/cognia-next/releases"

const noRelease: ReleaseState = {
  hasRelease: false,
  version: null,
  publishedAt: null,
  htmlUrl: RELEASES_URL,
  byPlatform: { macos: [], windows: [], linux: [] },
}

const withRelease: ReleaseState = {
  hasRelease: true,
  version: "v0.2.0",
  publishedAt: "2026-07-20T00:00:00.000Z",
  htmlUrl: "https://github.com/MaxQian888/cognia-next/releases/tag/v0.2.0",
  byPlatform: {
    macos: [{ name: "Cognia.dmg", url: "u", size: 1 }],
    windows: [],
    linux: [],
  },
}

describe("DownloadCta with no published release", () => {
  it("offers building from source rather than a download that does not exist", () => {
    render(<DownloadCta locale="en" copy={en.common} state={noRelease} docsOrigin="https://d" />)
    expect(screen.getByRole("link", { name: en.common.download.unavailable })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: en.common.download.available })).toBeNull()
  })

  it("still points the primary action at the download page", () => {
    render(<DownloadCta locale="en" copy={en.common} state={noRelease} docsOrigin="https://d" />)
    expect(screen.getByRole("link", { name: en.common.download.unavailable })).toHaveAttribute(
      "href",
      "/download"
    )
  })

  it("explains why, and links to releases as a note rather than a third button", () => {
    render(<DownloadCta locale="en" copy={en.common} state={noRelease} docsOrigin="https://d" />)
    expect(
      screen.getByText(en.common.download.unavailableExplain, { exact: false })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: en.common.download.unavailableSecondary })
    ).toHaveAttribute("href", RELEASES_URL)
  })

  it("keeps View source as the secondary action", () => {
    render(<DownloadCta locale="en" copy={en.common} state={noRelease} docsOrigin="https://d" />)
    expect(screen.getByRole("link", { name: en.common.viewSource })).toHaveAttribute(
      "href",
      "https://github.com/MaxQian888/cognia-next"
    )
  })

  it("shows no version line when there is no version", () => {
    render(<DownloadCta locale="en" copy={en.common} state={noRelease} docsOrigin="https://d" />)
    expect(screen.queryByText(/Version/)).toBeNull()
  })
})

describe("DownloadCta with a published release", () => {
  it("becomes a download action", () => {
    render(<DownloadCta locale="en" copy={en.common} state={withRelease} docsOrigin="https://d" />)
    expect(screen.getByRole("link", { name: en.common.download.available })).toHaveAttribute(
      "href",
      "/download"
    )
  })

  it("states the version and drops the build-from-source explanation", () => {
    render(<DownloadCta locale="en" copy={en.common} state={withRelease} docsOrigin="https://d" />)
    expect(screen.getByText(/v0\.2\.0/)).toBeInTheDocument()
    expect(screen.queryByText(en.common.download.unavailableExplain, { exact: false })).toBeNull()
  })
})

describe("DownloadCta variants and locales", () => {
  it("renders a single compact button for the navigation", () => {
    render(
      <DownloadCta
        locale="en"
        copy={en.common}
        state={noRelease}
        variant="compact"
        docsOrigin="https://d"
      />
    )
    expect(screen.getAllByRole("link")).toHaveLength(1)
    expect(screen.queryByRole("link", { name: en.common.viewSource })).toBeNull()
  })

  it("localises the action and prefixes the route", () => {
    render(<DownloadCta locale="zh" copy={zh.common} state={noRelease} docsOrigin="https://d" />)
    expect(screen.getByRole("link", { name: zh.common.download.unavailable })).toHaveAttribute(
      "href",
      "/zh/download"
    )
  })
})
