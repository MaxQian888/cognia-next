import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { ReleaseState } from "@web/lib/evidence"
import { FinalCta } from "./final-cta"

const DOCS = "https://docs.cognia.example"

const noRelease: ReleaseState = {
  hasRelease: false,
  version: null,
  publishedAt: null,
  htmlUrl: "https://github.com/MaxQian888/cognia-next/releases",
  byPlatform: { macos: [], windows: [], linux: [] },
}

function renderCta(locale: "en" | "zh" = "en", state = noRelease) {
  const copy = locale === "en" ? en : zh
  return render(<FinalCta locale={locale} copy={copy} releaseState={state} docsOrigin={DOCS} />)
}

describe("FinalCta", () => {
  it("closes with the single headline", () => {
    renderCta()
    expect(screen.getByRole("heading", { name: en.home.finalCta.title })).toBeInTheDocument()
  })

  it("repeats the same primary action as the hero, including its degraded wording", () => {
    renderCta()
    expect(screen.getByRole("link", { name: en.common.download.unavailable })).toHaveAttribute(
      "href",
      "/download"
    )
  })

  it("becomes a download action once a release exists", () => {
    renderCta("en", { ...noRelease, hasRelease: true, version: "v0.2.0" })
    expect(screen.getByRole("link", { name: en.common.download.available })).toBeInTheDocument()
  })

  it("offers source and docs as the quieter follow-ups", () => {
    renderCta()
    expect(screen.getByRole("link", { name: en.common.viewSource })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: en.common.readDocs })).toHaveAttribute(
      "href",
      `${DOCS}/en/docs`
    )
  })

  it("carries the support line", () => {
    renderCta()
    expect(screen.getByText(en.home.finalCta.support)).toBeInTheDocument()
  })

  it("localises the close", () => {
    renderCta("zh")
    expect(screen.getByRole("heading", { name: zh.home.finalCta.title })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: zh.common.readDocs })).toHaveAttribute(
      "href",
      `${DOCS}/zh/docs`
    )
  })
})
