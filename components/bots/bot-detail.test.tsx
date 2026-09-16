/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import { resolveBotPolicy } from "@/lib/bot/policy/ceilings"

import { BotDetail } from "./bot-detail"

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
    triggers: [{ id: "push", kind: "event", armed: true }],
    armedTriggers: 1,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    config: {},
    deadLetters: 0,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

describe("BotDetail", () => {
  it("distinguishes no synchronization from a failed or successful synchronization", () => {
    const polling = row({ triggers: [{ id: "poll", kind: "poll", armed: true, everyMs: 60000 }] })
    const { rerender } = render(<BotDetail row={polling} />)
    expect(screen.getByText("No successful sync yet")).toBeInTheDocument()
    rerender(
      <BotDetail
        row={{
          ...polling,
          activatedAt: 10,
          monitor: { lastSuccessAt: 20, lastError: "GitHub rate limit", retryAt: 30 },
        }}
      />
    )
    expect(screen.getByText("GitHub rate limit")).toBeInTheDocument()
    rerender(<BotDetail row={{ ...polling, monitor: { lastSuccessAt: 20, lastError: null } }} />)
    expect(screen.getByText("Up to date")).toBeInTheDocument()
  })
  it("explains an empty pane rather than rendering a blank one", () => {
    render(<BotDetail row={null} />)
    expect(screen.getByTestId("bot-detail-empty")).toBeInTheDocument()
  })

  it("skeletons while the first installations read is in flight", () => {
    // A spinner says "nothing is known"; bars in the pane's own shape say the
    // read is in flight, which is the difference between a console that
    // opened and one that looks broken.
    render(<BotDetail row={null} loading />)
    expect(screen.getByTestId("bot-detail-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("bot-detail-empty")).not.toBeInTheDocument()
  })

  it("says a followed link missed rather than greeting it as a fresh visit", () => {
    // `?bot=` naming an installation this device does not have used to fall
    // through to the pick-one copy — the reader could not tell a broken link
    // from a page that had not been asked for anything.
    render(<BotDetail row={null} missing />)
    expect(screen.getByText("That Bot is not here")).toBeInTheDocument()
  })

  it("keeps the identity card to facts the hero does not already print", () => {
    render(<BotDetail row={row()} />)
    const identity = screen.getByTestId("console-section-identity")
    // Definition id appears once — here, not in the hero's meta line.
    expect(within(identity).getByText("acme:review")).toBeInTheDocument()
    expect(screen.getAllByText("acme:review")).toHaveLength(1)
    // Source, executor and scope are the hero meta; printing them again here
    // was the same three answers twice.
    expect(within(identity).queryByText("Plugin")).not.toBeInTheDocument()
    expect(within(identity).queryByText("Account-wide")).not.toBeInTheDocument()
  })

  it("renders the identity record and the triggers side by side", () => {
    render(<BotDetail row={row()} />)
    expect(screen.getByTestId("console-section-identity")).toBeInTheDocument()
    expect(screen.getByTestId("console-section-triggers")).toBeInTheDocument()
    expect(screen.getByTestId("bot-trigger-push")).toBeInTheDocument()
  })

  it("carries the credential and policy sections, not only identity and triggers", () => {
    render(
      <BotDetail
        row={row({
          credentials: [{ id: "token", label: "GitHub token", optional: false, bound: false }],
          requiredSlots: [{ id: "token", label: "GitHub token" }],
          unboundSlots: ["token"],
          policy: resolveBotPolicy([{ name: "definition", policy: { maxConcurrentRuns: 1 } }]),
        })}
      />
    )
    expect(screen.getByTestId("console-section-credentials")).toBeInTheDocument()
    expect(screen.getByTestId("bot-credential-token")).toHaveTextContent("Needs binding")
    expect(screen.getByTestId("console-section-policy")).toBeInTheDocument()
    expect(screen.getByTestId("bot-policy")).toHaveTextContent("Concurrent runs")
  })

  it("counts bound credentials on the section header, where the shortfall shows", () => {
    render(
      <BotDetail
        row={row({
          requiredSlots: [
            { id: "token", label: "Token" },
            { id: "chat", label: "Chat" },
          ],
          unboundSlots: ["token"],
          credentials: [
            { id: "token", label: "Token", optional: false, bound: false },
            { id: "chat", label: "Chat", optional: false, bound: true },
          ],
        })}
      />
    )
    expect(screen.getByTestId("console-section-credentials")).toHaveTextContent("1/2")
  })

  it("states each resolution problem separately, not as one unavailable line", () => {
    // The three kinds need three different actions: reinstall the plugin,
    // accept a version that moved, or fix a handler that never loaded.
    render(
      <BotDetail
        row={row({
          problems: [
            { kind: "version_drift", pinned: "1.0.0", available: "1.1.0" },
            { kind: "handler_missing", definitionId: "acme:review" },
          ],
        })}
      />
    )
    expect(screen.getByTestId("bot-problem-version_drift")).toHaveTextContent(
      "Running a different version"
    )
    expect(screen.getByTestId("bot-problem-handler_missing")).toHaveTextContent(
      "Handler did not load"
    )
  })

  it("says an orphan is inert, and offers no control that would act on nothing", () => {
    render(
      <BotDetail
        row={row({ orphaned: true, executor: undefined, triggers: [], armedTriggers: 0 })}
      />
    )
    expect(screen.getByTestId("bot-orphan-alert")).toHaveTextContent("This Bot has no definition")
  })

  it("resets the scroll when the selection changes", () => {
    // Carrying the old offset lands you in the middle of a different Bot's
    // trigger list with nothing to say that is what happened.
    const { rerender } = render(<BotDetail row={row()} />)
    const scroller = screen.getByTestId("bot-detail").querySelector("div.overflow-y-auto")
    expect(scroller).toBeTruthy()
    ;(scroller as HTMLElement).scrollTop = 400

    rerender(<BotDetail row={row({ id: "boti_2", name: "Digest" })} />)
    expect((scroller as HTMLElement).scrollTop).toBe(0)
  })
})
