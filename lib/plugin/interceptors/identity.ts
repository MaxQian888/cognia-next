/**
 * Where an interceptor registration's identity comes from.
 *
 * `pluginId`, `generation` and `realmId` decide whose grants a call spends and
 * whether a handler belongs to a live activation at all, so none of them may be
 * read from anything the plugin supplies. They come off the activation lease —
 * specifically the `PluginDisposableScope` token the manager already mints per
 * activation, which carries exactly these three fields plus a scope id.
 *
 * The manager installs the resolver at init rather than this module importing
 * it, because the manager imports the whole plugin context graph and the
 * registration path sits underneath that. The default resolver is deliberately
 * NOT a plausible-looking guess: generation `0` and realm `global` are what an
 * unregistered host has, and they are what the tests assert, so a missing
 * installation shows up as a wrong-looking record instead of a silently
 * acceptable one.
 */

import type { PluginApiRuntime } from "@/lib/plugin/contracts/interface-catalog"

export interface InterceptorIdentity {
  pluginInstanceId: string
  generation: number
  realmId: string
  runtime: PluginApiRuntime
}

export type InterceptorIdentityResolver = (pluginId: string) => InterceptorIdentity

const defaultResolver: InterceptorIdentityResolver = (pluginId) => ({
  pluginInstanceId: pluginId,
  generation: 0,
  realmId: "global",
  runtime: "frontend",
})

let resolver: InterceptorIdentityResolver = defaultResolver

/**
 * Install the host's resolver. Called once by the plugin manager; returns a
 * disposer so tests and a manager teardown can put the default back rather
 * than leaking a closure over a dead manager.
 */
export function setInterceptorIdentityResolver(next: InterceptorIdentityResolver): () => void {
  resolver = next
  return () => {
    resolver = defaultResolver
  }
}

export function resolveInterceptorIdentity(pluginId: string): InterceptorIdentity {
  return resolver(pluginId)
}

/** Test-only: restore the default resolver. */
export function __resetInterceptorIdentityForTesting(): void {
  resolver = defaultResolver
}
