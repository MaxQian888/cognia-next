/**
 * Can this host read remote documents, and if not, why?
 *
 * `DocsProvider.hosts` answers a yes/no question, and every surface that
 * consumed it collapsed three different situations into one sentence
 * ("Desktop app only") or, worse, into nothing at all: the mobile composer
 * filtered the provider list by host and then hid its whole "Cloud docs" row
 * when the result was empty, so a phone user saw no trace that the feature
 * exists.
 *
 * The three situations are genuinely different and lead to different actions:
 *
 * - A **standalone browser** has no reader here and no paired host that could
 *   read on its behalf. Opening the desktop app is the only way forward.
 * - A **companion** (phone, or a browser paired to a cloud brain) has a host
 *   that holds the Feishu and Google credentials already. The document is
 *   reachable, this client just has no route to the process holding it. That
 *   is a narrower and much less discouraging statement than "desktop only".
 * - A **headless host** runs plenty, but not the desktop shell these two
 *   providers need: Feishu's open APIs send no CORS headers so only the Rust
 *   `connectors_http_request` bridge reaches them, and Google's installed-app
 *   OAuth redirect must land on the Rust loopback listener.
 *
 * Deliberately NOT `lib/connectors/control-reach.ts`. That resolver's three
 * reasons are about reaching a bot runtime, and its `runs-on-host` copy talks
 * about replying to messages and approving drafts. Sharing the vocabulary
 * would put connector sentences in front of someone attaching a spreadsheet.
 * What the two DO share is the presentation, `UnavailableNotice`, which is
 * where reuse belongs.
 */

import type { Platform } from "@/lib/platform/detect"
import type { HostProfile } from "@/lib/platform/capabilities"
import type { DocsProvider } from "./types"

/** Why remote documents cannot be read from here. */
export type DocsProviderBlock =
  /** No reader on this host, and no paired host that could read for it. */
  | "no-runtime"
  /** The paired host can read them. This client has no route to that reader. */
  | "runs-on-host"
  /** This runtime is not the desktop shell both built-in providers require. */
  | "needs-desktop-shell"

export const DOCS_PROVIDER_BLOCKS: readonly DocsProviderBlock[] = Object.freeze([
  "no-runtime",
  "runs-on-host",
  "needs-desktop-shell",
] as const)

export interface DocsProviderReach {
  available: boolean
  block?: DocsProviderBlock
}

const AVAILABLE: DocsProviderReach = Object.freeze({ available: true })

function blocked(block: DocsProviderBlock): DocsProviderReach {
  return { available: false, block }
}

/**
 * The shell each profile actually runs in.
 *
 * Both companion profiles resolve to `browser` because that is the webview
 * their provider code would execute in. Their host runs something else
 * entirely, which is exactly what `runs-on-host` is there to say.
 */
const PLATFORM_BY_PROFILE: Readonly<Record<HostProfile, Platform>> = Object.freeze({
  desktop: "tauri",
  "mobile-companion": "mobile",
  "cloud-companion": "browser",
  "web-standalone": "browser",
  headless: "headless",
})

/**
 * Resolve one provider against one host profile. Pure, so the composer can
 * call it per keystroke and tests can drive every profile without a shell.
 */
export function docsProviderReach(
  provider: Pick<DocsProvider, "hosts">,
  profile: HostProfile
): DocsProviderReach {
  if (provider.hosts.includes(PLATFORM_BY_PROFILE[profile])) return AVAILABLE
  if (profile === "web-standalone") return blocked("no-runtime")
  if (profile === "headless") return blocked("needs-desktop-shell")
  return blocked("runs-on-host")
}

/**
 * True when at least one provider can run here. Surfaces use this to decide
 * whether to lead with the picker or with the explanation. They must NOT use
 * it to decide whether to render at all: a blocked provider still gets a row,
 * because a row that says why is the whole point.
 */
export function anyDocsProviderAvailable(
  providers: readonly Pick<DocsProvider, "hosts">[],
  profile: HostProfile
): boolean {
  return providers.some((provider) => docsProviderReach(provider, profile).available)
}
