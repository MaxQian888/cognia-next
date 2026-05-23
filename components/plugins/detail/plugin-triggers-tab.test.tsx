import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { PluginTriggersTab } from "./plugin-triggers-tab"
import {
  __resetTriggerMutesForTesting,
  __resetTriggerRegistryForTesting,
  isTriggerMuted,
  registerPluginTrigger,
  startPluginTriggerInstance,
} from "@/lib/workflow/triggers/registry"
import type { TriggerRegistration } from "@/lib/workflow/triggers/registry"

function renderTab(pluginId: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PluginTriggersTab pluginId={pluginId} />
    </NextIntlClientProvider>
  )
}

function makeRegistration(pluginId: string, kind: string): TriggerRegistration {
  return {
    kind,
    typeVersion: 1,
    pluginId,
    def: {
      kind,
      typeVersion: 1,
      label: kind,
      description: "",
      start: jest.fn().mockResolvedValue({ stop: jest.fn() }),
    } as unknown as TriggerRegistration["def"],
    instances: new Map(),
  }
}

beforeEach(() => {
  __resetTriggerRegistryForTesting()
  __resetTriggerMutesForTesting()
})

afterEach(() => {
  __resetTriggerRegistryForTesting()
  __resetTriggerMutesForTesting()
})

describe("PluginTriggersTab", () => {
  it("shows the empty state when no workflows subscribe to the plugin's triggers", () => {
    renderTab("foo")
    expect(screen.getByText(/No workflows subscribe/i)).toBeInTheDocument()
  })

  it("lists every (kind, workflow) subscription owned by the plugin", async () => {
    const reg = makeRegistration("foo", "trigger.foo.alpha")
    registerPluginTrigger(reg)
    await startPluginTriggerInstance("trigger.foo.alpha", 1, {
      workflowId: "wf-1",
      params: {},
      emit: () => undefined,
      signal: new AbortController().signal,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    })
    await startPluginTriggerInstance("trigger.foo.alpha", 1, {
      workflowId: "wf-2",
      params: {},
      emit: () => undefined,
      signal: new AbortController().signal,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    })
    renderTab("foo")
    expect(screen.getAllByText("trigger.foo.alpha")).toHaveLength(2)
    expect(screen.getByText("wf-1")).toBeInTheDocument()
    expect(screen.getByText("wf-2")).toBeInTheDocument()
  })

  it("skips triggers owned by other plugins", async () => {
    registerPluginTrigger(makeRegistration("foo", "trigger.foo.alpha"))
    registerPluginTrigger(makeRegistration("bar", "trigger.bar.beta"))
    await startPluginTriggerInstance("trigger.bar.beta", 1, {
      workflowId: "wf-bar",
      params: {},
      emit: () => undefined,
      signal: new AbortController().signal,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    })
    renderTab("foo")
    expect(screen.queryByText("trigger.bar.beta")).not.toBeInTheDocument()
    expect(screen.queryByText("wf-bar")).not.toBeInTheDocument()
  })

  it("toggling mute persists via setTriggerMuted (round-trips through isTriggerMuted)", async () => {
    const user = userEvent.setup()
    registerPluginTrigger(makeRegistration("foo", "trigger.foo.alpha"))
    await act(async () => {
      await startPluginTriggerInstance("trigger.foo.alpha", 1, {
        workflowId: "wf-1",
        params: {},
        emit: () => undefined,
        signal: new AbortController().signal,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      })
    })
    renderTab("foo")
    const toggle = screen.getByRole("switch", { name: /Mute/i })
    expect(isTriggerMuted("foo", "trigger.foo.alpha", "wf-1")).toBe(false)
    await user.click(toggle)
    expect(isTriggerMuted("foo", "trigger.foo.alpha", "wf-1")).toBe(true)
  })
})
