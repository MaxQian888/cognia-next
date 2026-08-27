/**
 * One answer to "can the model reach the web this turn, and through what?"
 *
 * Three separate mechanisms grew up here without ever meeting:
 *
 *  1. The **runtime's own** web search — the Anthropic Agent SDK's `WebSearch`
 *     / `WebFetch`, which a subscription carries for free (server-side
 *     extraction, citations, Anthropic's token budget).
 *  2. **Cognia's** host-routed `web_search` / `web_fetch`
 *     (`lib/claude/web-builtin-tools.ts`), backed by the user's configured
 *     search provider (Tavily / Brave / Exa / …). The only path for a
 *     non-Anthropic provider.
 *  3. The composer's **pre-search**: run the draft through a provider BEFORE
 *     sending and paste the results in front of the prompt.
 *
 * Each had its own switch, and together they answered one question three
 * different ways. On a stock subscription install with no search key: the
 * composer's globe read "not configured" and sat disabled; the model was handed
 * a `web_search` tool anyway, which threw "no providers enabled" the moment it
 * was called; and the natives that would have just worked were behind an
 * opt-in that defaults off. This module is the single resolution both the
 * turn builder (`lib/claude/build-options.ts`) and the composer UI read, so
 * they can no longer disagree.
 *
 * Pure: every input is plain data the caller already holds. No settings store,
 * no capability manifest, no IO.
 */

import { isProviderConfigured } from "@cognia/web-search/types"
import { isCapabilityUsable } from "@cognia/agent-config-types/external-agent-capability"
import type { AppSettings } from "@cognia/agent-config-types"
import type { ExternalAgentCapabilityProfileV1 } from "@cognia/agent-config-types/external-agent-capability"

/** What the user asked of THIS turn, from the composer's web control. */
export type WebTurnIntent = "auto" | "force" | "off"

/** Which implementation serves one web tool this turn. */
export type WebToolRoute = "native" | "cognia" | "none"

/**
 * The headline the UI renders. Distinct from the per-tool routes below because
 * search and fetch fail apart: fetching a URL needs no API key, so an install
 * with no search provider still has a working `web_fetch`. Collapsing the two
 * would either hide a tool that works or advertise one that cannot.
 */
export type WebAccessMode =
  | "off"
  | "native"
  | "cognia"
  /** Fetch works; search has nothing to run on. */
  | "search-unavailable"

export type WebAccessReason =
  /** `webTools.enabled === false` — the user turned the capability off. */
  | "disabled"
  /** This turn only: the composer's control is set to "off". */
  | "turn-off"
  /** No runtime native and no configured search provider. */
  | "no-native-no-provider"

export interface WebAccessInput {
  /** `AppSettings.webTools`. Undefined ≡ enabled (the documented default). */
  webTools?: AppSettings["webTools"]
  /**
   * Does the runtime serving this turn bring its own web search?
   *
   * Today that means the Anthropic Agent SDK path (see
   * {@link anthropicNativeWebSearch}). External agents answer from the
   * capability matrix — including a user's own declaration — which is why this
   * is an input rather than something derived here from a provider id.
   */
  nativeAvailable: boolean
  /** `AppSettings.searchProviders`. */
  searchProviders?: AppSettings["searchProviders"]
  /** `AppSettings.defaultSearchProvider`. */
  defaultSearchProvider?: string
  /**
   * `AppSettings.searchEnabled` — the master switch for the composer's
   * pre-search. It gates {@link WebAccessResolution.preSearch} ONLY: it was
   * never consulted for the agent's own tools, and making it do so now would
   * silently remove `web_search` from every install that left it off.
   */
  searchEnabled?: boolean
  /** The composer's per-turn choice. Defaults to `auto`. */
  turnIntent?: WebTurnIntent
}

export interface WebAccessResolution {
  mode: WebAccessMode
  /** Which implementation should serve `web_search` this turn. */
  search: WebToolRoute
  /** Which implementation should serve `web_fetch` this turn. */
  fetch: WebToolRoute
  /** Why the mode is `off` / `search-unavailable`. Absent when web works. */
  reason?: WebAccessReason
  /** The provider a Cognia-routed search would run against, when there is one. */
  searchProviderId?: string
  /** The user asked this turn to search rather than leaving it to the model. */
  forced: boolean
  /**
   * May the composer offer "search before sending"? Needs both the master
   * switch and a configured provider — it runs the search itself, so a runtime
   * native does not help it.
   */
  preSearch: boolean
}

/**
 * Does the Anthropic Agent SDK path serve this turn?
 *
 * `allowedTools` — how the natives are pre-approved — is forwarded to `query()`
 * by the sidecar's `anthropic.mjs`. A standalone (BYOK) turn runs in the
 * renderer against the provider API through the AI SDK, which reads no such
 * field: opting into the natives there does not swap the web tools, it removes
 * them. So standalone never has natives, whatever the provider.
 */
export function anthropicNativeWebSearch(providerId: string, standalone: boolean): boolean {
  return providerId === "anthropic" && !standalone
}

/**
 * Does an EXTERNAL agent bring its own web search?
 *
 * Answered from the capability profile's `web.search` row, whose value comes
 * from whichever layer could honestly supply one: the user's declaration about
 * their own build, or a live observation. Every protocol row ships `unknown`,
 * and `unknown` is not usable — so an undeclared agent gets Cognia's tools,
 * which is the safe direction to be wrong in. Guessing `native` from a protocol
 * id would leave a turn with no web at all and no way for the user to tell why.
 */
export function externalAgentNativeWebSearch(
  profile: Pick<ExternalAgentCapabilityProfileV1, "effective"> | null | undefined
): boolean {
  const cell = profile?.effective["web.search"]
  return cell ? isCapabilityUsable(cell.level) : false
}

/** The configured search providers, in the order a caller should prefer them. */
export function configuredSearchProviders(
  searchProviders: AppSettings["searchProviders"] | undefined,
  defaultSearchProvider?: string
): string[] {
  const entries = Object.values(searchProviders ?? {}).filter(
    (p) => p?.enabled && isProviderConfigured(p.providerId, p)
  )
  const ids = entries.map((p) => p.providerId as string)
  // The user's default first, when it is one of the usable ones — the resolver
  // reports which provider WOULD run, and naming a different one than the
  // search itself picks is the same class of lie this module exists to remove.
  if (defaultSearchProvider && ids.includes(defaultSearchProvider)) {
    return [defaultSearchProvider, ...ids.filter((id) => id !== defaultSearchProvider)]
  }
  return ids
}

/**
 * Resolve the turn's web access.
 *
 * Order, and why:
 *
 *  0. The capability switch, then the per-turn choice. Both are the user
 *     saying no, and no is not overridden by availability.
 *  1. A runtime native wins. It costs the user nothing extra, returns
 *     citations, and needs no key — preferring Cognia's provider-backed tools
 *     over it (which is what shipped) means a subscriber with no Tavily key got
 *     a tool that could only fail.
 *  2. Otherwise a configured provider serves both tools.
 *  3. `web_fetch` survives on its own: it needs no key, so an install with
 *     neither native nor provider still gets it. Only search goes dark, and the
 *     UI says so rather than hiding the row.
 */
export function resolveWebAccess(input: WebAccessInput): WebAccessResolution {
  const enabled = input.webTools?.enabled ?? true
  const intent = input.turnIntent ?? "auto"
  const providers = configuredSearchProviders(input.searchProviders, input.defaultSearchProvider)
  const byoProviderId = providers[0]
  const preSearch = (input.searchEnabled ?? false) && byoProviderId !== undefined

  if (!enabled) {
    return {
      mode: "off",
      search: "none",
      fetch: "none",
      reason: "disabled",
      forced: false,
      preSearch: false,
    }
  }
  if (intent === "off") {
    return {
      mode: "off",
      search: "none",
      fetch: "none",
      reason: "turn-off",
      forced: false,
      preSearch,
    }
  }

  const forced = intent === "force"
  // The escape hatch for someone who wants Cognia's multi-provider search even
  // where a native exists (a provider with better recency/domain filters, or a
  // native they simply do not want billed). Honoured only when it can actually
  // be served — preferring an unconfigured path would be a third way to end up
  // with no web at all.
  const preferCognia = input.webTools?.preferCognia === true && byoProviderId !== undefined

  if (input.nativeAvailable && !preferCognia) {
    return {
      mode: "native",
      search: "native",
      fetch: "native",
      forced,
      preSearch,
      ...(byoProviderId ? { searchProviderId: byoProviderId } : {}),
    }
  }
  if (byoProviderId) {
    return {
      mode: "cognia",
      search: "cognia",
      fetch: "cognia",
      searchProviderId: byoProviderId,
      forced,
      preSearch,
    }
  }
  return {
    mode: "search-unavailable",
    search: "none",
    fetch: "cognia",
    reason: "no-native-no-provider",
    forced,
    preSearch,
  }
}
