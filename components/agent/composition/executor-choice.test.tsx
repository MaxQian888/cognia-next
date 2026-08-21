/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { ExecutorChoiceList } from "./executor-choice"
import type { ChatExecutor } from "./use-chat-executor"
import compositionMessages from "@/i18n/messages/en/agentComposition.json"

const messages = { agentComposition: compositionMessages }

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
        squads: [
          { id: "a", name: "Alpha" },
          { id: "b", name: "Bravo" },
        ],
      })
    )
    const rows = screen.getAllByTestId("executor-squad")
    expect(rows.map((r) => r.textContent)).toEqual(["Alpha", "Bravo"])
    expect(rows[1]).toHaveAttribute("aria-pressed", "true")
    expect(rows[0]).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("executor-single-agent")).toHaveAttribute("aria-pressed", "false")
  })

  it("binds the conversation when a Squad is picked", async () => {
    const select = jest.fn(async () => undefined)
    renderList(executor({ squads: [{ id: "a", name: "Alpha" }], select }))
    await userEvent.click(screen.getByTestId("executor-squad"))
    expect(select).toHaveBeenCalledWith("a")
  })

  it("unbinds back to a single agent", async () => {
    const select = jest.fn(async () => undefined)
    renderList(
      executor({ squadId: "a", squadName: "Alpha", squads: [{ id: "a", name: "Alpha" }], select })
    )
    await userEvent.click(screen.getByTestId("executor-single-agent"))
    expect(select).toHaveBeenCalledWith(null)
  })

  it("explains an empty list rather than showing one unexplained row", () => {
    renderList(executor())
    expect(screen.getByText(compositionMessages.executor.noSquads)).toBeInTheDocument()
  })

  it("gives a different explanation before the conversation exists", () => {
    // "No Squads yet" would be a lie here — there may be plenty; there is just
    // nothing to bind them to.
    renderList(executor({ bindable: false, squads: [{ id: "a", name: "Alpha" }] }))
    expect(screen.getByText(compositionMessages.executor.needsSession)).toBeInTheDocument()
    expect(screen.queryByText(compositionMessages.executor.noSquads)).not.toBeInTheDocument()
    expect(screen.getByTestId("executor-single-agent")).toBeDisabled()
    expect(screen.getByTestId("executor-squad")).toBeDisabled()
  })

  it("disables every choice while a turn is in flight", () => {
    renderList(executor({ squads: [{ id: "a", name: "Alpha" }] }), true)
    expect(screen.getByTestId("executor-single-agent")).toBeDisabled()
    expect(screen.getByTestId("executor-squad")).toBeDisabled()
  })
})
