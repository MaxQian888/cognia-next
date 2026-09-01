/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { ExecutorChoiceList } from "./executor-choice"
import type { ChatExecutor, ChatExecutorSquad } from "./use-chat-executor"
import compositionMessages from "@/i18n/messages/en/agentComposition.json"

const messages = { agentComposition: compositionMessages }

function squad(over: Partial<ChatExecutorSquad> & { id: string }): ChatExecutorSquad {
  return {
    name: over.id,
    status: "idle",
    memberCount: 0,
    live: false,
    waiting: false,
    ...over,
  }
}

function executor(over: Partial<ChatExecutor> = {}): ChatExecutor {
  return {
    squadId: null,
    squadName: null,
    squads: [],
    select: jest.fn(async () => undefined),
    bindable: true,
    ...over,
  }
}

function renderList(exec: ChatExecutor, disabled = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ExecutorChoiceList executor={exec} disabled={disabled} />
    </NextIntlClientProvider>
  )
}

describe("ExecutorChoiceList", () => {
  it("always offers the single-agent option", () => {
    renderList(executor())
    expect(screen.getByTestId("executor-single-agent")).toBeInTheDocument()
  })

  it("lists every Squad and marks the bound one", () => {
    renderList(
      executor({
        squadId: "b",
        squadName: "Bravo",
        squads: [squad({ id: "a", name: "Alpha" }), squad({ id: "b", name: "Bravo" })],
      })
    )
    const rows = screen.getAllByTestId("executor-squad")
    expect(rows.map((r) => within(r).getByText(/Alpha|Bravo/).textContent)).toEqual([
      "Alpha",
      "Bravo",
    ])
    expect(rows[1]).toHaveAttribute("aria-pressed", "true")
    expect(rows[0]).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("executor-single-agent")).toHaveAttribute("aria-pressed", "false")
  })

  it("binds the conversation when a Squad is picked", async () => {
    const select = jest.fn(async () => undefined)
    renderList(executor({ squads: [squad({ id: "a", name: "Alpha" })], select }))
    await userEvent.click(screen.getByTestId("executor-squad"))
    expect(select).toHaveBeenCalledWith("a")
  })

  it("unbinds back to a single agent", async () => {
    const select = jest.fn(async () => undefined)
    renderList(
      executor({
        squadId: "a",
        squadName: "Alpha",
        squads: [squad({ id: "a", name: "Alpha" })],
        select,
      })
    )
    await userEvent.click(screen.getByTestId("executor-single-agent"))
    expect(select).toHaveBeenCalledWith(null)
  })

  it("explains an empty list rather than showing one unexplained row", () => {
    renderList(executor())
    expect(screen.getByText(compositionMessages.executor.noSquads)).toBeInTheDocument()
  })

  it("gives a different explanation before the conversation exists", () => {
    // "No Squads yet" would be a lie here. There may be plenty, there is just
    // nothing to bind them to.
    renderList(executor({ bindable: false, squads: [squad({ id: "a", name: "Alpha" })] }))
    expect(screen.getByText(compositionMessages.executor.needsSession)).toBeInTheDocument()
    expect(screen.queryByText(compositionMessages.executor.noSquads)).not.toBeInTheDocument()
    expect(screen.getByTestId("executor-single-agent")).toBeDisabled()
    expect(screen.getByTestId("executor-squad")).toBeDisabled()
  })

  it("disables every choice while a turn is in flight", () => {
    renderList(executor({ squads: [squad({ id: "a", name: "Alpha" })] }), true)
    expect(screen.getByTestId("executor-single-agent")).toBeDisabled()
    expect(screen.getByTestId("executor-squad")).toBeDisabled()
  })
})

describe("ExecutorChoiceList rows", () => {
  it("shows the portrait and the roster size, not just a name", () => {
    renderList(executor({ squads: [squad({ id: "a", name: "Alpha", memberCount: 3 })] }))
    const row = screen.getByTestId("executor-squad")
    expect(within(row).getByTestId("agent-team-avatar-a")).toBeInTheDocument()
    expect(within(row).getByText("3 members")).toBeInTheDocument()
  })

  it("separates a Squad that is running from one parked on a question", () => {
    renderList(
      executor({
        squads: [
          squad({ id: "idle", name: "Idle" }),
          squad({ id: "live", name: "Live", live: true, status: "executing" }),
          squad({ id: "wait", name: "Wait", waiting: true, live: true, status: "executing" }),
        ],
      })
    )
    const states = screen
      .getAllByTestId("executor-squad-status")
      .map((dot) => dot.getAttribute("data-state"))
    expect(states).toEqual(["idle", "live", "waiting"])
    // Waiting outranks live: a Squad blocked on a person is the one that will
    // not move on its own, so it must not read as merely busy.
    expect(screen.getByLabelText("Needs you")).toBeInTheDocument()
  })

  it("names each state for a screen reader instead of relying on colour", () => {
    renderList(executor({ squads: [squad({ id: "a", name: "Alpha" })] }))
    expect(screen.getByRole("img", { name: "Idle" })).toBeInTheDocument()
  })
})

describe("ExecutorChoiceList filtering", () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    squad({ id: `s${i}`, name: i === 0 ? "Refactor Crew" : `Squad ${i}` })
  )

  it("stays filter-free while the whole list fits on screen", () => {
    renderList(executor({ squads: many.slice(0, 5) }))
    expect(screen.queryByTestId("executor-search")).toBeNull()
  })

  it("offers a filter once the list is long enough to need one", async () => {
    renderList(executor({ squads: many }))
    const search = screen.getByTestId("executor-search")
    await userEvent.type(search, "refactor")
    const rows = screen.getAllByTestId("executor-squad")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText("Refactor Crew")).toBeInTheDocument()
    // Single agent is not a Squad and is never filtered out of reach.
    expect(screen.getByTestId("executor-single-agent")).toBeInTheDocument()
  })

  it("says a filter matched nothing rather than claiming there are no Squads", async () => {
    renderList(executor({ squads: many }))
    await userEvent.type(screen.getByTestId("executor-search"), "zzzz")
    expect(screen.queryAllByTestId("executor-squad")).toHaveLength(0)
    expect(screen.getByText(compositionMessages.executor.noMatches)).toBeInTheDocument()
    expect(screen.queryByText(compositionMessages.executor.noSquads)).toBeNull()
  })
})
