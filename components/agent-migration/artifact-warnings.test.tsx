/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"
import { MIGRATION_ARTIFACT_STATUSES } from "@/lib/agent-migration/types"

import { ArtifactWarnings } from "./artifact-warnings"

const renderWarnings = (props: React.ComponentProps<typeof ArtifactWarnings>) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ArtifactWarnings {...props} />
    </NextIntlClientProvider>
  )

describe("ArtifactWarnings", () => {
  it("renders every warning string", () => {
    // These used to be computed by each importer and dropped on the floor.
    renderWarnings({
      status: "ready",
      warnings: ["review.md: unknown frontmatter key `agent`", "plan.md: missing description"],
    })
    expect(screen.getByText(/unknown frontmatter key/)).toBeInTheDocument()
    expect(screen.getByText(/missing description/)).toBeInTheDocument()
  })

  it("explains a shared status instead of leaving it as 'imported 0'", () => {
    renderWarnings({ status: "shared", warnings: [] })
    expect(screen.getByTestId("artifact-warnings")).toHaveTextContent(
      "Cognia already reads this location"
    )
  })

  it.each(["empty", "unsupported", "error"] as const)("explains %s", (status) => {
    renderWarnings({ status, warnings: [] })
    expect(screen.getByTestId("artifact-warnings").textContent).not.toBe("")
  })

  it("renders nothing for a clean ready artifact", () => {
    const { container } = renderWarnings({ status: "ready", warnings: [] })
    expect(container).toBeEmptyDOMElement()
  })

  it("folds a long warning list into a remainder line", () => {
    renderWarnings({
      status: "ready",
      warnings: Array.from({ length: 9 }, (_, index) => `file-${index}.md: could not parse`),
    })
    expect(screen.getAllByRole("listitem")).toHaveLength(6)
    expect(screen.getByTestId("fidelity-summary-more")).toHaveTextContent("and 3 more")
  })

  it("never renders a stray empty paragraph when there is only an explanation", () => {
    renderWarnings({ status: "shared", warnings: [] })
    expect(screen.queryByRole("list")).toBeNull()
    const paragraphs = screen.getByTestId("artifact-warnings").querySelectorAll("p")
    expect([...paragraphs].every((node) => node.textContent !== "")).toBe(true)
  })

  describe("message catalogue coverage", () => {
    // `lint:i18n` cannot follow `t(`explain.${status}`)`, so a new status that
    // reaches this component without a key would render blank in production.
    it.each([
      ["en", en],
      ["zh-CN", zh],
    ])("covers every explained status in %s", (_locale, messages) => {
      const explain = (messages as unknown as Record<string, Record<string, unknown>>)
        .agentMigration.explain as Record<string, string>
      for (const status of MIGRATION_ARTIFACT_STATUSES) {
        if (status === "ready") continue
        expect(explain[status]).toBeTruthy()
      }
    })
  })
})
