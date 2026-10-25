/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import {
  __resetOutboundAskStoreForTesting,
  requestOutboundAsk,
  useOutboundAskStore,
} from "@/stores/outbound/outbound-ask-store"

import { OutboundAskDialog } from "./outbound-ask-dialog"

const QUESTION = {
  site: "https://forms.example.com",
  basis: "request" as const,
  operation: "POST",
  asker: "chat" as const,
  forRequestOffered: true,
}

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <OutboundAskDialog />
    </NextIntlClientProvider>
  )
}

beforeEach(() => __resetOutboundAskStoreForTesting())

describe("OutboundAskDialog", () => {
  it("lets questions be asked only while it is mounted", () => {
    const { unmount } = renderDialog()
    expect(useOutboundAskStore.getState().hosts).toBe(1)
    unmount()
    expect(requestOutboundAsk(QUESTION, { ttlMs: 60_000 })).toBeNull()
  })

  it("asks about a held submission and answers allow for this request", async () => {
    renderDialog()
    let asked: Promise<unknown> | null = null
    act(() => {
      asked = requestOutboundAsk(QUESTION, { ttlMs: 60_000 })
    })
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "An agent action is sending data (POST) to https://forms.example.com. It waits for your answer."
    )
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Refusing blocks this site for the rest of the request."
    )
    expect(screen.getByRole("alertdialog")).toHaveTextContent("From a conversation")
    fireEvent.click(screen.getByRole("button", { name: "Allow for this request" }))
    await expect(asked).resolves.toBe("request")
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("asks about an action that may submit, offering no request grant where there is none", async () => {
    renderDialog()
    let asked: Promise<unknown> | null = null
    act(() => {
      asked = requestOutboundAsk(
        {
          ...QUESTION,
          site: null,
          basis: "possible",
          operation: "press:Enter",
          asker: "external-bridge",
          forRequestOffered: false,
        },
        { ttlMs: 60_000 }
      )
    })
    const dialog = screen.getByRole("alertdialog")
    expect(dialog).toHaveTextContent(
      "The agent wants to press Enter on a page of a page with no web address."
    )
    expect(dialog).toHaveTextContent("Refusing blocks only this submission.")
    expect(dialog).toHaveTextContent("From an app connected through the External Bridge")
    expect(screen.queryByRole("button", { name: "Allow for this request" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Refuse" }))
    await expect(asked).resolves.toBe("refuse")
  })

  it("shows the oldest question first and says how many wait", async () => {
    renderDialog()
    let first: Promise<unknown> | null = null
    act(() => {
      first = requestOutboundAsk(QUESTION, { ttlMs: 60_000 })
      void requestOutboundAsk({ ...QUESTION, operation: "WS" }, { ttlMs: 60_000 })
      void requestOutboundAsk({ ...QUESTION, operation: "PUT" }, { ttlMs: 60_000 })
    })
    expect(screen.getByTestId("outbound-ask-waiting")).toHaveTextContent("2 more questions waiting")
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    await expect(first).resolves.toBe("once")
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "An agent action is sending a WebSocket message to https://forms.example.com."
    )
    expect(screen.getByTestId("outbound-ask-waiting")).toBeInTheDocument()
  })

  it("is not dismissed without an answer", () => {
    renderDialog()
    act(() => {
      void requestOutboundAsk(QUESTION, { ttlMs: 60_000 })
    })
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" })
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  })
})
