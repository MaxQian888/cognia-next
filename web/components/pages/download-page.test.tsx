import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { DownloadPage } from "./download-page"

jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: jest.fn() }) }))

/**
 * These run against the committed evidence snapshot, which has no published
 * release — the state the site actually ships in today.
 */
describe("DownloadPage with no published release", () => {
  it("leads with building from source rather than a download button", () => {
    render(<DownloadPage locale="en" />)
    expect(
      screen.getAllByRole("link", { name: en.common.download.unavailable }).length
    ).toBeGreaterThan(0)
    expect(screen.queryByRole("link", { name: en.common.download.available })).toBeNull()
  })

  it("shows no per-platform installer list, because there are no installers", () => {
    render(<DownloadPage locale="en" />)
    expect(screen.queryByText(en.download.platformsTitle)).toBeNull()
    expect(screen.queryByText(en.common.download.allPlatforms)).toBeNull()
  })

  it("gives the real build commands", () => {
    render(<DownloadPage locale="en" />)
    for (const step of en.download.buildFromSource.steps) {
      expect(screen.getByText(step.command)).toBeInTheDocument()
    }
  })

  it("states the prerequisites, including the Rust toolchain the shell needs", () => {
    render(<DownloadPage locale="en" />)
    for (const item of en.download.requirements.items) {
      expect(screen.getByText(item)).toBeInTheDocument()
    }
  })

  it("carries the page heading", () => {
    render(<DownloadPage locale="en" />)
    expect(
      screen.getByRole("heading", { level: 1, name: en.download.header.title })
    ).toBeInTheDocument()
  })

  it("localises", () => {
    render(<DownloadPage locale="zh" />)
    expect(screen.getByText(zh.download.buildFromSource.steps[1].command)).toBeInTheDocument()
    expect(
      screen.getAllByRole("link", { name: zh.common.download.unavailable }).length
    ).toBeGreaterThan(0)
  })
})
