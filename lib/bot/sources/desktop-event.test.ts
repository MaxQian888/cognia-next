/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import { listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import { dispatchDesktopEventToBots } from "./desktop-event"

const NOW = 1_700_000_000_000

async function seed(types: string[]) {
  registerBot(
    "watch",
    {
      id: "acme:watch",
      definition: {
        id: "watch",
        name: "Watcher",
        version: "1.0.0",
        executor: "handler",
        triggers: [{ id: "screen", kind: "event", source: "desktop", types }],
      } as PluginBotDef,
      handler: jest.fn(),
    },
    { pluginId: "acme" }
  )
  return installBot({
    id: "boti_1",
    definitionId: "acme:watch",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    now: NOW,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
  await getDb().botEventDeliveries.clear()
}, 15_000)

describe("dispatchDesktopEventToBots", () => {
  it("delivers to a trigger watching the kind", async () => {
    await seed(["desktop.focus-changed"])

    const result = await dispatchDesktopEventToBots({
      type: "desktop.focus-changed",
      sourceRecordId: "uia:focus-changed:1",
      payload: { kind: "focus-changed" },
    })

    expect(result.enqueued).toHaveLength(1)
  })

  it("carries exactly the payload it was handed, and nothing more", async () => {
    // The producer redacts. This module must not look inside, or it becomes a
    // second place the rules for a window title live.
    await seed(["desktop.focus-changed"])
    await dispatchDesktopEventToBots({
      type: "desktop.focus-changed",
      sourceRecordId: "uia:focus-changed:1",
      payload: { kind: "focus-changed", name: "Terminal" },
    })

    const [row] = await listBotDeliveries({ installationId: "boti_1" })
    expect(row.envelope.payload).toEqual({ kind: "focus-changed", name: "Terminal" })
  })

  it("does not deliver to a trigger watching a different kind", async () => {
    await seed(["desktop.window-opened"])

    const result = await dispatchDesktopEventToBots({
      type: "desktop.focus-changed",
      sourceRecordId: "uia:focus-changed:1",
      payload: { kind: "focus-changed" },
    })

    expect(result.enqueued).toEqual([])
  })

  it("is idempotent for the same occurrence", async () => {
    await seed(["desktop.focus-changed"])
    const input = {
      type: "desktop.focus-changed",
      sourceRecordId: "uia:focus-changed:1",
      payload: { kind: "focus-changed" },
    }
    await dispatchDesktopEventToBots(input)
    await dispatchDesktopEventToBots(input)

    expect(await listBotDeliveries({ installationId: "boti_1" })).toHaveLength(1)
  })
})
