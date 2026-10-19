import { fireEvent, render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { Evidence, ReleaseState } from "@web/lib/evidence"
import { FinalCta } from "./final-cta"

const DOCS = "https://docs.cognia.example"

const noRelease: ReleaseState = {
  hasRelease: false,
  version: null,
  publishedAt: null,
  htmlUrl: "https://github.com/MaxQian888/cognia-next/releases",
  byPlatform: { macos: [], windows: [], linux: [] },
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    readAt: "2026-07-26T00:00:00.000Z",
    lastGoodReadAt: "2026-07-26T00:00:00.000Z",
    errors: [],
    repo: { stars: 52, license: "AGPL-3.0-or-later", description: null },
    contributors: 2,
    releases: [],
    changesets: [],
    inventory: {
      plugins: 59,
      connectors: 11,
      workflowNodeKinds: 185,
      crates: 35,
      packages: 32,
      adrs: 167,
      testFiles: 9496,
    },
    ...overrides,
  }
}

function renderCta(locale: "en" | "zh" = "en", state = noRelease, data: Evidence = evidence()) {
  const copy = locale === "en" ? en : zh
  return render(
    <FinalCta locale={locale} copy={copy} releaseState={state} evidence={data} docsOrigin={DOCS} />
  )
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

  it("closes on the execution stage, bookending the hero", () => {
    const { container } = renderCta()
    const section = container.querySelector("section#start")
    expect(section).toHaveClass("bg-stage")
    expect(section).toHaveClass("stage-scope")
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

describe("FinalCta build commands", () => {
  it("opens the right column on the commands /download lists, in order", () => {
    const { container } = renderCta()
    const block = container.querySelector('[data-slot="build-commands"]') as HTMLElement
    expect(block).toHaveTextContent(en.home.finalCta.buildLabel)
    const lines = [...block.querySelectorAll("code > span")].map((line) => line.textContent)
    expect(lines).toEqual(en.download.buildFromSource.steps.map((step) => `$ ${step.command}`))
    // The prompt is decoration, kept out of selection and assistive tech.
    expect(block.querySelector("code > span > span")).toHaveAttribute("aria-hidden")
    expect(block.querySelector("code > span > span")).toHaveClass("select-none")
  })

  it("offers one control that copies the commands, one per line", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    renderCta()
    fireEvent.click(screen.getByRole("button", { name: en.common.copyCommand }))
    expect(writeText).toHaveBeenCalledWith(
      en.download.buildFromSource.steps.map((step) => step.command).join("\n")
    )
    expect(await screen.findByText(en.common.copiedCommand)).toBeInTheDocument()
  })
})

describe("FinalCta index", () => {
  it("does not repeat the licence the trust section states", () => {
    renderCta("en", noRelease, evidence())
    expect(screen.queryByText("AGPL-3.0-or-later")).toBeNull()
  })

  it("shows the changeset count at its value, without counting up to it", () => {
    const { container } = renderCta()
    expect(screen.getByText(en.home.finalCta.changesSuffix).parentElement).toHaveTextContent(
      new RegExp(`^${evidence().changesets.length}`)
    )
    expect(container.querySelector('[data-slot="count-up"]')).toBeNull()
  })

  it("sets the support sentence in the reading face", () => {
    renderCta()
    expect(screen.getByText(en.home.finalCta.support)).not.toHaveClass("font-mono")
  })
})
