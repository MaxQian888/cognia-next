import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { HostProfile } from "@/lib/platform/capabilities"

import {
  CONNECTOR_CONTROL_BLOCKS,
  connectorControlReach,
  type ConnectorControlRequirement,
} from "./control-reach"

const PROFILES: readonly HostProfile[] = [
  "desktop",
  "mobile-companion",
  "cloud-companion",
  "web-standalone",
  "headless",
]

describe("connectorControlReach", () => {
  it("lets the desktop do everything", () => {
    expect(connectorControlReach("desktop")).toEqual({ available: true })
    expect(connectorControlReach("desktop", "desktop-shell")).toEqual({ available: true })
  })

  /**
   * The correction this module exists for. A companion's bots are running on
   * the paired host — the Inbox next to these controls is replying through the
   * relay — so "adapters require the desktop app" is false. What is true is
   * that these controls talk to the runtime process and the browser has no
   * route to it.
   */
  it.each(["mobile-companion", "cloud-companion"] as const)(
    "tells a %s that the runtime is on the paired host",
    (profile) => {
      expect(connectorControlReach(profile)).toEqual({
        available: false,
        block: "runs-on-host",
      })
    }
  )

  it("tells a standalone browser there is no runtime anywhere", () => {
    expect(connectorControlReach("web-standalone")).toEqual({
      available: false,
      block: "no-runtime",
    })
  })

  /**
   * "You have no bot" outranks "your tunnel needs the desktop app": pointing a
   * standalone browser at the desktop-shell answer would skip the part where
   * there is nothing to tunnel to.
   */
  it("prefers no-runtime over the shell answer when both apply", () => {
    expect(connectorControlReach("web-standalone", "desktop-shell").block).toBe("no-runtime")
  })

  it("separates the desktop-process controls from the runtime ones", () => {
    expect(connectorControlReach("cloud-companion", "desktop-shell")).toEqual({
      available: false,
      block: "needs-desktop-shell",
    })
  })

  // Headless runs adapters; it just never renders this UI today.
  it("keeps a headless host able to run runtime controls but not shell ones", () => {
    expect(connectorControlReach("headless").available).toBe(true)
    expect(connectorControlReach("headless", "desktop-shell").block).toBe("needs-desktop-shell")
  })

  it("answers every profile × requirement pair with a known block", () => {
    const requirements: ConnectorControlRequirement[] = ["connector-runtime", "desktop-shell"]
    for (const profile of PROFILES) {
      for (const requirement of requirements) {
        const reach = connectorControlReach(profile, requirement)
        if (reach.available) expect(reach.block).toBeUndefined()
        else expect(CONNECTOR_CONTROL_BLOCKS).toContain(reach.block)
      }
    }
  })
})

/**
 * `t(`block.${x}`)` is a template-literal key and `pnpm lint:i18n` skips every
 * one of those, so the union is pinned against the catalogue here — the same
 * guard the capability vocabulary carries.
 */
describe.each(["en", "zh-CN"])("connectors.control catalogue — %s", (locale) => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "i18n/messages", locale, "connectors.json"), "utf8")
  ).control as { block: Record<string, string>; nextStep: Record<string, string> }

  it("has a reason and a next step for every block", () => {
    expect(Object.keys(messages.block).sort()).toEqual([...CONNECTOR_CONTROL_BLOCKS].sort())
    expect(Object.keys(messages.nextStep).sort()).toEqual([...CONNECTOR_CONTROL_BLOCKS].sort())
  })
})
