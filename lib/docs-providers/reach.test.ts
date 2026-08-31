/**
 * @jest-environment node
 */
import {
  anyDocsProviderAvailable,
  docsProviderReach,
  DOCS_PROVIDER_BLOCKS,
  type DocsProviderBlock,
} from "./reach"
import type { HostProfile } from "@/lib/platform/capabilities"

/** Both built-ins declare exactly this. */
const desktopOnly = { hosts: ["tauri"] } as const
/** A hypothetical provider that works everywhere a webview does. */
const anywhere = { hosts: ["tauri", "browser", "mobile"] } as const

describe("docsProviderReach", () => {
  it("lets the desktop through", () => {
    expect(docsProviderReach(desktopOnly, "desktop")).toEqual({ available: true })
  })

  it.each<[HostProfile, DocsProviderBlock]>([
    // A browser with no paired host: nothing anywhere can open the document.
    ["web-standalone", "no-runtime"],
    // Both companions have a host that already holds the accounts. Saying
    // "desktop only" here would hide the machine sitting next to the user.
    ["mobile-companion", "runs-on-host"],
    ["cloud-companion", "runs-on-host"],
    // A headless host runs plenty, just not the shell these providers need.
    ["headless", "needs-desktop-shell"],
  ])("blocks %s with %s", (profile, block) => {
    expect(docsProviderReach(desktopOnly, profile)).toEqual({ available: false, block })
  })

  it("follows the provider's own host list rather than assuming desktop", () => {
    // The point of reading `hosts`: register a mobile-capable provider and the
    // phone stops being blocked, with no edit to this resolver.
    expect(docsProviderReach(anywhere, "mobile-companion").available).toBe(true)
    expect(docsProviderReach(anywhere, "cloud-companion").available).toBe(true)
    expect(docsProviderReach(anywhere, "headless").available).toBe(false)
  })

  it("never returns a block alongside availability", () => {
    const profiles: HostProfile[] = [
      "desktop",
      "mobile-companion",
      "cloud-companion",
      "web-standalone",
      "headless",
    ]
    for (const profile of profiles) {
      for (const provider of [desktopOnly, anywhere]) {
        const reach = docsProviderReach(provider, profile)
        expect(reach.available).toBe(reach.block === undefined)
      }
    }
  })

  it("only ever emits blocks the i18n catalogue covers", () => {
    const profiles: HostProfile[] = [
      "desktop",
      "mobile-companion",
      "cloud-companion",
      "web-standalone",
      "headless",
    ]
    for (const profile of profiles) {
      const { block } = docsProviderReach(desktopOnly, profile)
      if (block) expect(DOCS_PROVIDER_BLOCKS).toContain(block)
    }
  })
})

describe("anyDocsProviderAvailable", () => {
  it("is false when every provider is blocked here", () => {
    expect(anyDocsProviderAvailable([desktopOnly, desktopOnly], "mobile-companion")).toBe(false)
  })

  it("is true as soon as one provider fits the host", () => {
    expect(anyDocsProviderAvailable([desktopOnly, anywhere], "mobile-companion")).toBe(true)
  })

  it("is false for an empty registry", () => {
    expect(anyDocsProviderAvailable([], "desktop")).toBe(false)
  })
})
