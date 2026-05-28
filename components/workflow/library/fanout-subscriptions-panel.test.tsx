/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { createFanoutSubscription, listForWorkflow } from "@/lib/db/workflow-fanout-subscriptions"
import { FanoutSubscriptionsPanel } from "./fanout-subscriptions-panel"

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

async function seedAdapter() {
  const { defaultGroupChatPolicy } = await import("@/types/connectors/policy")
  return createAdapterInstance({
    type: "lark",
    displayName: "Lark Ops Bot",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    trigger: defaultGroupChatPolicy(),
    defaultMode: "auto",
    credentialsRef: {
      keyringService: "com.cognia.platforms",
      accounts: [],
    },
  })
}

describe("FanoutSubscriptionsPanel", () => {
  it("renders empty state when no subscriptions exist", async () => {
    await seedAdapter()
    render(<FanoutSubscriptionsPanel workflowId="wf_1" />)
    await waitFor(() => {
      expect(screen.getByText(/No mirrors configured/)).toBeInTheDocument()
    })
  })

  it("adds a subscription via the form", async () => {
    const adapter = await seedAdapter()
    const user = userEvent.setup()
    render(<FanoutSubscriptionsPanel workflowId="wf_1" />)
    await waitFor(() => expect(screen.getByTestId("fanout-adapter-select")).not.toBeDisabled())

    fireEvent.change(screen.getByTestId("fanout-conversation-key"), {
      target: { value: "lark:lark:ops:oc_demo" },
    })
    await user.click(screen.getByTestId("fanout-add"))

    await waitFor(async () => {
      const subs = await listForWorkflow("wf_1", { includeDisabled: true })
      expect(subs).toHaveLength(1)
      expect(subs[0]).toMatchObject({
        workflowId: "wf_1",
        adapterId: adapter.id,
        conversationKey: "lark:lark:ops:oc_demo",
        enabled: true,
        createdBy: "settings-ui",
      })
    })
  })

  it("renders existing subscriptions and supports toggle + delete", async () => {
    const adapter = await seedAdapter()
    const sub = await createFanoutSubscription({
      workflowId: "wf_1",
      adapterId: adapter.id,
      conversationKey: "lark:lark:ops:oc_demo",
      createdBy: "settings-ui",
    })
    render(<FanoutSubscriptionsPanel workflowId="wf_1" />)
    await waitFor(() => expect(screen.getByTestId(`fanout-item-${sub.id}`)).toBeInTheDocument())

    // Toggle off
    fireEvent.click(screen.getByTestId(`fanout-toggle-${sub.id}`))
    await waitFor(async () => {
      const row = await getDb().workflowFanoutSubscriptions.get(sub.id)
      expect(row?.enabled).toBe(false)
    })

    // Delete
    fireEvent.click(screen.getByTestId(`fanout-remove-${sub.id}`))
    await waitFor(async () => {
      expect(await getDb().workflowFanoutSubscriptions.get(sub.id)).toBeUndefined()
    })
  })

  it("disables the form when no adapters are enabled", async () => {
    render(<FanoutSubscriptionsPanel workflowId="wf_no_adapters" />)
    await waitFor(() => {
      const add = screen.getByTestId("fanout-add")
      expect(add).toBeDisabled()
    })
  })
})
