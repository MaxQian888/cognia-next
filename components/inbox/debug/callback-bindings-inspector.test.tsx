/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    message: jest.fn(),
  },
}))

const dispatchSpy = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({
    dispatchConnectorCallback: (...args: unknown[]) => dispatchSpy(...args),
  }),
}))

import { CallbackBindingsInspector } from "./callback-bindings-inspector"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  dispatchSpy.mockClear()
})

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

function seedBinding(
  partial: Partial<ConnectorCallbackBindingRow> & { actionId: string }
): ConnectorCallbackBindingRow {
  return {
    id: `${partial.adapterId ?? "lark-1"}:${partial.actionId}`,
    adapterId: partial.adapterId ?? "lark-1",
    actionId: partial.actionId,
    kind: partial.kind ?? "callback_query",
    surfaceId: partial.surfaceId ?? "s1",
    componentId: partial.componentId ?? "btn-1",
    conversationKey: partial.conversationKey ?? "lark:lark-1:c1",
    createdAt: partial.createdAt ?? Date.now(),
  }
}

describe("CallbackBindingsInspector", () => {
  it("renders empty state when no bindings exist for the conversation", async () => {
    wrap(
      <CallbackBindingsInspector
        open
        onOpenChange={() => undefined}
        conversationKey="lark:lark-1:c1"
        adapterId="lark-1"
      />
    )
    await waitFor(() => expect(screen.getByTestId("bindings-scroll")).toBeInTheDocument())
    expect(screen.getByText(/no bindings/i)).toBeInTheDocument()
  })

  it("lists recent bindings for the conversation", async () => {
    await getDb()
      .connectorCallbackBindings.bulkAdd([
        seedBinding({ actionId: "approve" }),
        seedBinding({ actionId: "deny" }),
      ])
      .catch(() => undefined)
    wrap(
      <CallbackBindingsInspector
        open
        onOpenChange={() => undefined}
        conversationKey="lark:lark-1:c1"
        adapterId="lark-1"
      />
    )
    await waitFor(() => expect(screen.getByTestId("binding-row-approve")).toBeInTheDocument())
    expect(screen.getByTestId("binding-row-deny")).toBeInTheDocument()
  })

  it("clicking test drives dispatchConnectorCallback with the action id", async () => {
    await getDb()
      .connectorCallbackBindings.bulkAdd([seedBinding({ actionId: "approve" })])
      .catch(() => undefined)
    wrap(
      <CallbackBindingsInspector
        open
        onOpenChange={() => undefined}
        conversationKey="lark:lark-1:c1"
        adapterId="lark-1"
      />
    )
    await waitFor(() => expect(screen.getByTestId("binding-test-approve")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("binding-test-approve"))
    await waitFor(() =>
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ actionId: "approve" }))
    )
  })

  it("delete removes the binding row", async () => {
    await getDb()
      .connectorCallbackBindings.bulkAdd([seedBinding({ actionId: "drop" })])
      .catch(() => undefined)
    wrap(
      <CallbackBindingsInspector
        open
        onOpenChange={() => undefined}
        conversationKey="lark:lark-1:c1"
        adapterId="lark-1"
      />
    )
    await waitFor(() => expect(screen.getByTestId("binding-delete-drop")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("binding-delete-drop"))
    await waitFor(async () => {
      const all = await getDb().connectorCallbackBindings.toArray()
      expect(all.find((r) => r.actionId === "drop")).toBeUndefined()
    })
  })

  it("renders the failures banner when audit rows report callback.unbound", async () => {
    await getDb()
      .connectorCallbackBindings.bulkAdd([seedBinding({ actionId: "x" })])
      .catch(() => undefined)
    await getDb().connectorAudit.add({
      id: "a1",
      adapterId: "lark-1",
      kind: "callback.unbound",
      at: Date.now(),
      conversationKey: "lark:lark-1:c1",
      reason: "missing_binding",
    })
    wrap(
      <CallbackBindingsInspector
        open
        onOpenChange={() => undefined}
        conversationKey="lark:lark-1:c1"
        adapterId="lark-1"
      />
    )
    await waitFor(() => expect(screen.getByTestId("bindings-failures-banner")).toBeInTheDocument())
  })
})
