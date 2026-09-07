/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import { resolveBotPolicy } from "@/lib/bot/policy/ceilings"

import { BotPolicySection } from "./policy-section"

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    executor: "handler",
    status: "enabled",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [],
    armedTriggers: 0,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    policy: resolveBotPolicy([]),
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

describe("BotPolicySection", () => {
  it("names the layer that set each value, which is the question a ceiling raises", () => {
    // "What can this Bot do" is usually guessable. "Why" is not, and
    // "your organisation set this" and "the plugin author set this" lead to
    // two completely different next steps.
    render(
      <BotPolicySection
        row={row({
          policy: resolveBotPolicy([
            { name: "organization", policy: { maxRunDurationMs: 60_000 } },
            { name: "definition", policy: { maxConcurrentRuns: 2 } },
          ]),
        })}
      />
    )
    const panel = screen.getByTestId("bot-policy")
    expect(panel).toHaveTextContent("Time ceiling")
    expect(panel).toHaveTextContent("60s per run")
    expect(panel).toHaveTextContent("Organisation")
    expect(panel).toHaveTextContent("Definition")
  })

  it("reports a layer that asked to widen and was overruled", () => {
    // The difference between "the plugin never asked for this" and "the
    // plugin asked and was told no".
    render(
      <BotPolicySection
        row={row({
          policy: resolveBotPolicy([
            { name: "organization", policy: { maxConcurrentRuns: 1 } },
            { name: "installation", policy: { maxConcurrentRuns: 8 } },
          ]),
        })}
      />
    )
    expect(screen.getByTestId("bot-policy-refusals")).toBeInTheDocument()
    expect(screen.getByTestId("bot-policy-refusal-maxConcurrentRuns")).toHaveTextContent(
      "Installation asked to widen Concurrent runs and was overruled."
    )
  })

  it("renders a boolean as a word rather than the literal true", () => {
    render(
      <BotPolicySection
        row={row({
          policy: resolveBotPolicy([
            { name: "definition", policy: { requireApprovalForWrites: true } },
          ]),
        })}
      />
    )
    expect(screen.getByTestId("bot-policy")).toHaveTextContent("Approve every write")
    expect(screen.getByTestId("bot-policy")).toHaveTextContent("Yes")
    expect(screen.getByTestId("bot-policy")).not.toHaveTextContent("true")
  })

  it("says no layer set a limit, rather than showing a blank card", () => {
    // A blank card reads as a load failure. Running under the same defaults
    // as any other run is a real answer.
    render(<BotPolicySection row={row()} />)
    expect(screen.getByText("No ceiling set")).toBeInTheDocument()
  })

  it("says there is nothing to fold for an orphan", () => {
    render(<BotPolicySection row={row({ orphaned: true, policy: undefined })} />)
    expect(screen.getByText("Definition missing")).toBeInTheDocument()
  })
})
