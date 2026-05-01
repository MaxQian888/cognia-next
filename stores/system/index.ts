/**
 * Stub for `@/stores/system` — the module Cognia uses to expose the user's
 * HTTP proxy configuration. cognia-next does not yet ship a proxy store
 * (network requests go straight through Tauri's HTTP client / fetch).
 *
 * The shape returned here matches what `lib/network/proxy-fetch.ts` expects:
 * a `useProxyStore` hook returning `{ enabled, url, mode }` and a
 * `getActiveProxyUrl()` helper. Both report "no proxy" so the ported code
 * falls through to direct fetch on every call.
 */

/**
 * Proxy state shape — mirrors Cognia's `useProxyStore`. The real store wraps
 * the user's saved proxy configuration in a `config` object (so persistence /
 * migration / form binding all key off the same nested record); the ported
 * `lib/network/proxy-fetch.ts` reaches in via `state.config.enabled` etc.
 */
export interface ProxyManualCredentials {
  username?: string
  password?: string
}

export interface ProxyConfig {
  enabled: boolean
  mode: "system" | "manual" | "off"
  url: string | null
  host?: string | null
  port?: number | null
  protocol?: string | null
  /**
   * Optional manual auth credentials. Only consulted when `mode === "manual"`.
   * `lib/network/proxy-fetch.ts:getProxyAuthHeaders` reads from here.
   */
  manual?: ProxyManualCredentials | null
}

export interface ProxyStoreState {
  config: ProxyConfig
}

const PROXY_DISABLED: ProxyStoreState = {
  config: { enabled: false, mode: "off", url: null },
}

/**
 * Zustand-shaped store stub. The real Cognia implementation is a real
 * Zustand store with both a hook signature (`useProxyStore()`) and a
 * static `.getState()` accessor (`useProxyStore.getState()`). Both forms
 * appear in `lib/network/proxy-fetch.ts`. This stub satisfies both with
 * a frozen disabled state.
 */
type UseProxyStoreFn = (() => ProxyStoreState) & {
  getState: () => ProxyStoreState
  subscribe: (listener: (state: ProxyStoreState) => void) => () => void
}

const useProxyStoreImpl = (() => PROXY_DISABLED) as UseProxyStoreFn
useProxyStoreImpl.getState = () => PROXY_DISABLED
useProxyStoreImpl.subscribe = () => () => undefined

export const useProxyStore: UseProxyStoreFn = useProxyStoreImpl

/**
 * `getActiveProxyUrl(state?)` — Cognia accepts an optional snapshot to avoid
 * a second store lookup when the caller already grabbed `getState()`. The
 * cognia-next stub is constant-disabled so the parameter is ignored.
 */
export function getActiveProxyUrl(_state?: ProxyStoreState): string | null {
  return null
}
