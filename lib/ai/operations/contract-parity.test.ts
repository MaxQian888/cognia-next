/**
 * The dynamic half of the provider operation manifest gate (ADR-0163).
 *
 * The mjs gate (`pnpm provider-ops:check`) can only read source text. This
 * suite loads the real matrix and the real registry and enforces the two
 * directions that need them:
 *   - every registered handler binds an operation the manifest describes,
 *   - every built-in provider cell that CLAIMS support (native, translated,
 *     derived) has a handler that can serve it, resolved the way the
 *     executor resolves (provider, then protocol, then any).
 *
 * `PENDING_OPERATIONS` is the ratchet: operations the matrix already
 * answers for but no batch has bound yet. It may only shrink. An operation
 * listed here that gains a handler fails the suite until it is removed, so
 * the list cannot go stale in either direction.
 */
import { PROVIDER_OPERATION_IDS, type ProviderOperationId } from "@cognia/provider-types"
import {
  BUILT_IN_PROVIDER_IDS,
  getBuiltInProviderCatalogEntry,
} from "@cognia/provider-types/built-in-provider-catalog"
import { buildProviderOperationProfile } from "@cognia/provider-core/operations/capability-matrix"

import { registerBuiltInProviderOperationHandlers } from "./handlers"
import { getProviderOperationDescriptor } from "./manifest"
import { ProviderOperationHandlerRegistry } from "./registry"

/** Operations the matrix claims for at least one built-in but no handler serves yet. */
export const PENDING_OPERATIONS: ReadonlySet<ProviderOperationId> = new Set<ProviderOperationId>(
  PROVIDER_OPERATION_IDS.filter(
    (id) => id === "images.edit" || id === "translation.create" || id === "realtime.connect"
  )
)

const SERVED = new Set(["native", "translated", "derived"])

function protocolOf(providerId: string): string {
  const entry = getBuiltInProviderCatalogEntry(providerId)
  const protocol = entry?.protocol ?? "openai"
  return protocol === "gemini" ? "google" : protocol
}

describe("provider operation contract parity", () => {
  const registry = new ProviderOperationHandlerRegistry()
  registerBuiltInProviderOperationHandlers(registry)

  it("every registered handler binds a described operation", () => {
    const registrations = registry.list()
    expect(registrations.length).toBeGreaterThan(0)
    for (const registration of registrations) {
      expect(getProviderOperationDescriptor(registration.operationId)).toBeDefined()
    }
  })

  it("every served cell of every built-in provider has a handler, except the pending ratchet", () => {
    const unbound = new Map<string, string[]>()
    let scanned = 0
    for (const providerId of BUILT_IN_PROVIDER_IDS) {
      const profile = buildProviderOperationProfile({ providerId, computedAt: 1 })
      for (const cell of profile.cells) {
        scanned += 1
        if (!SERVED.has(cell.support)) continue
        if (PENDING_OPERATIONS.has(cell.operationId)) continue
        if (registry.resolve(cell.operationId, providerId, protocolOf(providerId))) continue
        const list = unbound.get(cell.operationId) ?? []
        list.push(providerId)
        unbound.set(cell.operationId, list)
      }
    }
    expect(scanned).toBe(BUILT_IN_PROVIDER_IDS.length * PROVIDER_OPERATION_IDS.length)
    expect([...unbound.entries()]).toEqual([])
  })

  it("the pending ratchet only names operations that really have no handler", () => {
    const stale = [...PENDING_OPERATIONS].filter((id) => registry.listFor(id).length > 0)
    expect(stale).toEqual([])
  })
})
