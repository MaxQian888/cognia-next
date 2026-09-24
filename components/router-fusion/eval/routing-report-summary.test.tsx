/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"

import {
  runSimulatedRoutingExperiment,
  type RoutingExperimentReport,
} from "@/lib/ai/eval/routing-experiment"

import { formatMicrousd, formatShare, RoutingReportSummary } from "./routing-report-summary"

type Gate = NonNullable<RoutingExperimentReport["gate"]["gate"]>

const EMPTY_SHA = "0".repeat(64)

function bootstrap(over: Partial<Gate> = {}): Gate {
  const arm = {
    runCount: 40,
    acceptedCount: 20,
    totalCostMicrousd: 400_000,
    costPerAcceptedMicrousd: 20_000,
    passRate: 0.5,
  }
  return {
    verdict: "pass",
    passed: true,
    reasons: [],
    seed: 1,
    iterations: 10_000,
    confidenceLevel: 0.95,
    pairedGroupCount: 32,
    unpairedGroupCount: 0,
    candidate: arm,
    baseline: arm,
    costPerAcceptedDeltaMicrousd: { estimate: -2_000, low: -3_000, high: -1_200 },
    passRateDelta: { estimate: 0.01, low: 0, high: 0.02 },
    undefinedReplicates: 0,
    thresholds: { maxCostPerAcceptedDeltaMicrousd: 0, minPassRateDelta: -0.01 },
    ...over,
  }
}

function report(over: Partial<RoutingExperimentReport> = {}): RoutingExperimentReport {
  return {
    schema: "cognia.routing-experiment/v1",
    version: 1,
    label: "live",
    disclaimer: "LIVE: every sample is a run this device really made.",
    claims: { quality: "non-inferior", costSavingMicrousd: 1_200 },
    createdAt: "2026-03-01T00:00:00.000Z",
    featuresVersion: "router-fusion-features/1",
    sampleCount: 120,
    acceptedCost: {
      runCount: 120,
      acceptedCount: 48,
      totalCostMicrousd: 1_234_567,
      costPerAcceptedMicrousd: 25_720.1,
      passRate: 0.4,
    },
    byAction: [
      {
        actionId: "cascade_schema",
        actionHash: "hash-cascade",
        runCount: 60,
        acceptedCount: 30,
        totalCostMicrousd: 330_000,
        costPerAcceptedMicrousd: 11_000,
        passRate: 0.5,
      },
      {
        actionId: "direct_economy",
        actionHash: "hash-direct",
        runCount: 60,
        acceptedCount: 18,
        totalCostMicrousd: 72_000,
        costPerAcceptedMicrousd: 4_000,
        passRate: 0.3,
      },
    ],
    split: {
      strategy: "grouped-time-shifted",
      seed: 1,
      testFraction: 0.2,
      testStartsAt: 0,
      calibrationFraction: 0.2,
      partitions: {
        train: { groups: 10, samples: 72 },
        calibration: { groups: 3, samples: 24 },
        test: { groups: 3, samples: 24 },
        excluded: { groups: 0, samples: 0 },
      },
      groupsSha256: {
        train: EMPTY_SHA,
        calibration: EMPTY_SHA,
        test: EMPTY_SHA,
        excluded: EMPTY_SHA,
      },
    },
    heads: [
      {
        actionId: "cascade_schema",
        actionHash: "hash-cascade",
        calibrated: true,
        publishable: true,
        withheldReasons: [],
        trainingSamples: 36,
        calibrationSamples: 12,
        testSamples: 12,
        testBrier: 0.2,
        testExpectedCalibrationError: 0.05,
      },
    ],
    training: { manifestSha256: EMPTY_SHA },
    publication: { status: "published", manifestSha256: EMPTY_SHA, withheldHeads: [] },
    gate: {
      gate: bootstrap(),
      passed: true,
      refusals: [],
      candidateMatched: 40,
      baselineMatched: 40,
      deterministicSamples: 0,
    },
    caveats: [],
    ...over,
  }
}

describe("formatMicrousd", () => {
  it("renders integer microusd as dollars to four places", () => {
    expect(formatMicrousd(0)).toBe("$0.0000")
    expect(formatMicrousd(42_000)).toBe("$0.0420")
    expect(formatMicrousd(1_500_000)).toBe("$1.5000")
    expect(formatMicrousd(25_720.1)).toBe("$0.0257")
  })

  it("has no value for an undefined or non-finite amount", () => {
    expect(formatMicrousd(null)).toBeNull()
    expect(formatMicrousd(Number.NaN)).toBeNull()
    expect(formatMicrousd(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe("formatShare", () => {
  it("renders a ratio as a percentage to one place", () => {
    expect(formatShare(0)).toBe("0.0%")
    expect(formatShare(0.4102)).toBe("41.0%")
    expect(formatShare(1)).toBe("100.0%")
  })

  it("has no value for an undefined or non-finite ratio", () => {
    expect(formatShare(null)).toBeNull()
    expect(formatShare(Number.NaN)).toBeNull()
    expect(formatShare(Number.NEGATIVE_INFINITY)).toBeNull()
  })
})

describe("RoutingReportSummary", () => {
  it("leads a live report with its label, its verdict and the saving it claims", () => {
    render(<RoutingReportSummary report={report()} />)

    const label = screen.getByText("Live")
    expect(label).toHaveAttribute("data-variant", "default")
    expect(screen.getByTestId("routing-report-verdict")).toHaveTextContent("Promotion gate: Pass")
    expect(
      screen.getByText("LIVE: every sample is a run this device really made.")
    ).toBeInTheDocument()
    expect(screen.getByTestId("routing-report-claim")).toHaveTextContent(
      "Claimed saving per accepted run: $0.0012"
    )
  })

  it("makes cost per accepted run the headline beside samples, share and total", () => {
    render(<RoutingReportSummary report={report()} />)

    const stat = (term: string) => screen.getByText(term).nextElementSibling
    expect(stat("Samples")).toHaveTextContent("120")
    expect(screen.getByTestId("routing-report-accepted-cost")).toHaveTextContent("$0.0257")
    expect(stat("Cost per accepted run")).toBe(screen.getByTestId("routing-report-accepted-cost"))
    expect(stat("Accepted share")).toHaveTextContent("40.0%")
    expect(stat("Total cost")).toHaveTextContent("$1.2346")
  })

  it("lists accepted cost by action and each head with its sample counts", () => {
    render(
      <RoutingReportSummary
        report={report({
          heads: [
            ...report().heads,
            {
              actionId: "panel_review",
              actionHash: "hash-panel",
              calibrated: false,
              publishable: false,
              withheldReasons: ["SINGLE_CLASS_TRAINING"],
              trainingSamples: 5,
              calibrationSamples: 0,
              testSamples: 2,
              testBrier: null,
              testExpectedCalibrationError: null,
            },
          ],
        })}
      />
    )

    const byAction = screen.getByRole("heading", { name: "By action" }).parentElement!
    const actionRows = within(byAction).getAllByRole("listitem")
    expect(actionRows.map((row) => row.textContent)).toEqual([
      "cascade_schema$0.0110",
      "direct_economy$0.0040",
    ])

    const heads = screen.getByRole("heading", { name: "Heads" }).parentElement!
    const headRows = within(heads).getAllByRole("listitem")
    expect(headRows).toHaveLength(2)
    expect(headRows[0]).toHaveTextContent(
      "cascade_schemaCalibrated · 36 train · 12 calibration · 12 test"
    )
    expect(headRows[1]).toHaveTextContent("panel_reviewWithheld · 5 train · 0 calibration · 2 test")
  })

  it("writes out that nothing was accepted instead of showing an undefined ratio as a number", () => {
    render(
      <RoutingReportSummary
        report={report({
          acceptedCost: {
            runCount: 0,
            acceptedCount: 0,
            totalCostMicrousd: Number.NaN,
            costPerAcceptedMicrousd: null,
            passRate: null,
          },
          byAction: [
            {
              actionId: "direct_economy",
              actionHash: "hash-direct",
              runCount: 3,
              acceptedCount: 0,
              totalCostMicrousd: 9_000,
              costPerAcceptedMicrousd: null,
              passRate: 0,
            },
          ],
        })}
      />
    )

    expect(screen.getByTestId("routing-report-accepted-cost")).toHaveTextContent(
      "Nothing was accepted"
    )
    expect(screen.getByText("Accepted share").nextElementSibling).toHaveTextContent("—")
    expect(screen.getByText("Total cost").nextElementSibling).toHaveTextContent("—")
    const byAction = screen.getByRole("heading", { name: "By action" }).parentElement!
    expect(within(byAction).getByRole("listitem")).toHaveTextContent(
      "direct_economyNothing was accepted"
    )
  })

  it("states that it makes no claim when there is no saving to claim", () => {
    render(
      <RoutingReportSummary
        report={report({
          claims: { quality: null, costSavingMicrousd: null },
          gate: {
            gate: bootstrap({
              verdict: "inconclusive",
              passed: false,
              reasons: ["INSUFFICIENT_GROUPS"],
            }),
            passed: false,
            refusals: [],
            candidateMatched: 3,
            baselineMatched: 4,
            deterministicSamples: 10,
          },
        })}
      />
    )

    expect(screen.getByTestId("routing-report-verdict")).toHaveTextContent(
      "Promotion gate: Inconclusive"
    )
    expect(screen.getByTestId("routing-report-claim")).toHaveTextContent(
      "This report makes no claim about real quality, cost or saving."
    )
  })

  it("reports a failed gate verdict", () => {
    render(
      <RoutingReportSummary
        report={report({
          claims: { quality: null, costSavingMicrousd: null },
          gate: {
            gate: bootstrap({ verdict: "fail", passed: false, reasons: ["COST_NOT_REDUCED"] }),
            passed: false,
            refusals: [],
            candidateMatched: 30,
            baselineMatched: 30,
            deterministicSamples: 0,
          },
        })}
      />
    )

    expect(screen.getByTestId("routing-report-verdict")).toHaveTextContent("Promotion gate: Fail")
  })

  it("explains why no comparison was attempted when the gate refused", () => {
    render(
      <RoutingReportSummary
        report={report({
          claims: { quality: null, costSavingMicrousd: null },
          gate: {
            gate: null,
            passed: false,
            refusals: ["DETERMINISTIC_LOGGING", "NO_PREDICTOR"],
            candidateMatched: 0,
            baselineMatched: 0,
            deterministicSamples: 120,
          },
        })}
      />
    )

    expect(screen.getByTestId("routing-report-verdict")).toHaveTextContent(
      "Promotion gate: Not attempted"
    )
    expect(
      screen.getByText(
        "Every run was routed by the deterministic rules router, so no comparison is identifiable."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText("No head could be published, so there was no candidate to compare against.")
    ).toBeInTheDocument()
  })

  it("shows caveats under their own heading, and omits the section and the refusal list when empty", () => {
    const { rerender } = render(<RoutingReportSummary report={report()} />)
    expect(screen.queryByRole("heading", { name: "Read this first" })).not.toBeInTheDocument()
    // Only the by-action and heads lists render without refusals or caveats.
    expect(screen.getAllByRole("list")).toHaveLength(2)

    rerender(
      <RoutingReportSummary
        report={report({ caveats: ["Some samples carry an estimated bill.", "Second caveat."] })}
      />
    )
    const caveats = screen.getByRole("heading", { name: "Read this first" }).parentElement!
    expect(
      within(caveats)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["Some samples carry an estimated bill.", "Second caveat."])
  })

  it("never reads a real simulated report as evidence (EVAL-04)", async () => {
    const { report: simulated } = await runSimulatedRoutingExperiment({
      seed: 1,
      createdAt: "2026-03-01T00:00:00.000Z",
      iterations: 20,
    })

    render(<RoutingReportSummary report={simulated} />)

    const label = screen.getByText("Simulated")
    expect(label).toHaveAttribute("data-variant", "secondary")
    expect(screen.getByText(simulated.disclaimer, { selector: "p" })).toBeInTheDocument()
    expect(screen.getByTestId("routing-report-claim")).toHaveTextContent(
      "This report makes no claim about real quality, cost or saving."
    )
    expect(screen.getByTestId("routing-report-accepted-cost")).toHaveTextContent(
      formatMicrousd(simulated.acceptedCost.costPerAcceptedMicrousd)!
    )
    const heads = screen.getByRole("heading", { name: "Heads" }).parentElement!
    expect(within(heads).getAllByRole("listitem")).toHaveLength(simulated.heads.length)
  })
})
