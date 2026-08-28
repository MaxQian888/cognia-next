/** @jest-environment jsdom */
import { saveSettings } from "@/lib/db/settings"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { useSettingsStore } from "@/stores/settings"

import {
  BROWSER_COMPANION_COMMANDS,
  createBrowserCompanionDeps,
  isBrowserCompanionCommand,
} from "./host-dispatch"

describe("browser companion command surface", () => {
  it("names exactly the four commands the manifest registers", () => {
    // The Rust side has its own copy (`rpc.rs::BROWSER_COMPANION_COMMANDS`)
    // because the dispatch binding and the caller-id injection both key off
    // it. A mismatch would leave one of them reading an unbound account.
    expect([...BROWSER_COMPANION_COMMANDS].sort()).toEqual([
      "browser_companion_capability",
      "browser_context_get",
      "browser_context_list",
      "browser_context_submit",
    ])
  })

  it("recognises its own commands and nothing adjacent", () => {
    expect(isBrowserCompanionCommand("browser_context_submit")).toBe(true)
    // Neighbours in the same `browser_` namespace that belong to the embedded
    // browser, not to the extension.
    expect(isBrowserCompanionCommand("browser_capability")).toBe(false)
    expect(isBrowserCompanionCommand("browser_runtime_status")).toBe(false)
    expect(isBrowserCompanionCommand("host_state_submit")).toBe(false)
  })
})

describe("the Rust and TypeScript command lists agree", () => {
  it("lists the same four names on both sides", async () => {
    const { readFile } = await import("node:fs/promises")
    const source = await readFile("src-tauri/src/companion_api/rpc.rs", "utf8")
    const block = source.slice(source.indexOf("pub(super) const BROWSER_COMPANION_COMMANDS"))
    const names = [...block.slice(0, block.indexOf("];")).matchAll(/"([a-z_]+)"/g)].map(
      (match) => match[1]
    )
    expect(names.sort()).toEqual([...BROWSER_COMPANION_COMMANDS].sort())
  })

  it("registers each of them in KNOWN_COMMANDS", async () => {
    const { readFile } = await import("node:fs/promises")
    const source = await readFile("src-tauri/src/companion_api/rpc.rs", "utf8")
    const known = source.slice(
      source.indexOf("const KNOWN_COMMANDS"),
      source.indexOf("pub fn known_commands()")
    )
    for (const command of BROWSER_COMPANION_COMMANDS) {
      expect(known).toContain(`"${command}"`)
    }
  })

  it("gives each of them a manifest descriptor with the right capability", async () => {
    const manifest = (await import("@/protocol/companion-commands.json")) as unknown as {
      default?: { commands: { name: string; capability: string; idempotency: string }[] }
      commands?: { name: string; capability: string; idempotency: string }[]
    }
    const commands = manifest.commands ?? manifest.default?.commands ?? []
    const byName = new Map(commands.map((entry) => [entry.name, entry]))
    for (const command of BROWSER_COMPANION_COMMANDS) {
      const descriptor = byName.get(command)
      expect(descriptor).toBeDefined()
      // A browser device holds only these two. A descriptor naming anything
      // else would be unreachable for the only client that calls it.
      expect(["browser.submit", "browser.read-own"]).toContain(descriptor?.capability)
    }
    // The write is the only one on the idempotency ledger, and it must be:
    // that ledger is what makes a retried submission replay instead of
    // creating a second session.
    expect(byName.get("browser_context_submit")?.idempotency).toBe("required")
    expect(byName.get("browser_context_list")?.idempotency).toBe("structural")
  })
})

/**
 * The production dependency object, exercised for real.
 *
 * Every other test in this subsystem hands `service.ts` a stub, which is
 * exactly why the appearance reader could be broken for as long as it was: an
 * injected-deps default is only ever verified by a test that refuses the
 * injection. `createBrowserCompanionDeps` is what runs on a real Host, so it is
 * what this describes.
 */
describe("createBrowserCompanionDeps", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(dbFixture.restore)
  afterAll(dbFixture.dispose)

  it("reads the Host's theme without a hydrated settings store", async () => {
    // The headless brain has no React tree, so nothing ever calls
    // `settings-hydrator.tsx` — and this store stays null for the life of the
    // process. Reading it there answered the stock dark preset for every user,
    // silently, because "null" is also what the first milliseconds after boot
    // look like on the desktop.
    expect(useSettingsStore.getState().settings).toBeNull()
    await saveSettings({ theme: "light" })

    const deps = createBrowserCompanionDeps({}, async () => {
      throw new Error("HostState must not be resolved to answer a capability call")
    })
    const appearance = await deps.appearance()

    expect(appearance.mode).toBe("light")
    expect(Object.keys(appearance.cssVars).length).toBeGreaterThan(0)
    // Still null: the reader went to the database, it did not hydrate anything.
    expect(useSettingsStore.getState().settings).toBeNull()
  })
})
