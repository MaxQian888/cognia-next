/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"
import type {
  PluginConversionFidelity,
  PluginConversionIssue,
  PluginConversionReport as ReportData,
  PluginEcosystem,
} from "@/lib/plugin/convert/ecosystem"

import { PluginConversionReport } from "./plugin-conversion-report"

const issue = (patch: Partial<PluginConversionIssue> = {}): PluginConversionIssue => ({
  capability: "hooks",
  path: "hooks/pre-tool-use.sh",
  message: "Command hooks have no Cognia equivalent.",
  blocking: false,
  ...patch,
})

const report = (patch: Partial<ReportData> = {}): ReportData => ({
  fidelity: "structured",
  converted: [],
  warnings: [],
  blocking: [],
  ...patch,
})

const renderReport = (data: ReportData, sourceFormat: PluginEcosystem = "claude-code") =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PluginConversionReport sourceFormat={sourceFormat} report={data} />
    </NextIntlClientProvider>
  )

describe("PluginConversionReport", () => {
  it("names the detected source and the fidelity", () => {
    renderReport(report({ fidelity: "contextual" }))
    expect(screen.getByTestId("plugin-conversion-fidelity")).toHaveTextContent("Contextual")
    expect(screen.getByText(/Detected source: Claude Code/)).toBeInTheDocument()
    expect(screen.getByText(/rebuilt from what the source declared/)).toBeInTheDocument()
  })

  it("renders the warning messages, not just their count", () => {
    // The whole point. The previous surface printed "{n} warnings" and dropped
    // every message the converter had written.
    renderReport(
      report({
        converted: [issue({ capability: "skills" })],
        warnings: [
          issue(),
          issue({
            capability: "outputStyles",
            path: "output-styles/x.md",
            message: "Output styles are not a Cognia contribution.",
          }),
        ],
      })
    )
    expect(screen.getByText(/Command hooks have no Cognia equivalent/)).toBeInTheDocument()
    expect(screen.getByText("hooks/pre-tool-use.sh")).toBeInTheDocument()
    expect(screen.getByText("output-styles/x.md")).toBeInTheDocument()
    expect(screen.getByText(/Output styles are not a Cognia contribution/)).toBeInTheDocument()
    expect(screen.getByTestId("plugin-conversion-report")).toHaveTextContent(
      "1 capability converted, 2 warnings, nothing blocking"
    )
  })

  it("puts blockers above warnings", () => {
    renderReport(
      report({
        fidelity: "unsupported",
        warnings: [issue({ capability: "outputStyles" })],
        blocking: [issue({ capability: "lspServers", blocking: true })],
      })
    )
    const items = screen.getAllByRole("listitem")
    expect(items[0]).toHaveTextContent("Blocked")
    expect(items[0]).toHaveTextContent("lspServers")
    expect(items[1]).toHaveTextContent("Warning")
  })

  it("says everything carried over, and still says what was converted", () => {
    // "Everything carried over." on its own drops the fact that anything was
    // converted at all, which is the other half of what the user is deciding on.
    renderReport(report({ fidelity: "native-exact", converted: [issue()] }))
    expect(screen.getByTestId("plugin-conversion-no-issues")).toHaveTextContent(
      "Everything carried over."
    )
    expect(screen.getByTestId("plugin-conversion-report")).toHaveTextContent(
      "1 capability converted, no warnings, nothing blocking"
    )
  })

  it("folds a long issue list into a remainder line", () => {
    renderReport(
      report({ warnings: Array.from({ length: 11 }, (_, i) => issue({ path: `p/${i}` })) })
    )
    expect(screen.getAllByRole("listitem")).toHaveLength(8)
    expect(screen.getByTestId("fidelity-summary-more")).toHaveTextContent("and 3 more")
  })

  it("renders an issue with no path", () => {
    renderReport(report({ warnings: [issue({ path: "" })] }))
    expect(screen.getByText(/Command hooks have no Cognia equivalent/)).toBeInTheDocument()
  })

  describe("message catalogue coverage", () => {
    // `lint:i18n` cannot see `t(`fidelity.${x}`)`, so the dynamic keys get
    // pinned here instead. A new fidelity level or plugin ecosystem that
    // reaches this component without a key would otherwise render blank.
    const FIDELITIES: PluginConversionFidelity[] = [
      "native-exact",
      "structured",
      "contextual",
      "unsupported",
    ]
    const ECOSYSTEMS: PluginEcosystem[] = ["cognia", "claude-code", "codex", "gemini-cli"]

    it.each([
      ["en", en],
      ["zh-CN", zh],
    ])("covers every fidelity and ecosystem in %s", (_locale, messages) => {
      const namespace = (messages as unknown as Record<string, Record<string, unknown>>).plugins
        .conversionReport as Record<string, Record<string, string>>
      for (const fidelity of FIDELITIES) {
        expect(namespace.fidelity[fidelity]).toBeTruthy()
        expect(namespace.fidelityHint[fidelity]).toBeTruthy()
      }
      for (const ecosystem of ECOSYSTEMS) expect(namespace.sources[ecosystem]).toBeTruthy()
    })
  })
})
