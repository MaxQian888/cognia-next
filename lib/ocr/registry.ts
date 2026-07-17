/**
 * Provider registry — every OCR provider lib/ocr/providers/*.ts plugs itself
 * in here. The registry is platform-agnostic; the auto-router consults it
 * (plus runtime settings) to pick a default.
 *
 * Tests construct ad-hoc registries via `createOcrRegistry()` with mock
 * providers so the dispatch surface (`extract()`) can be exercised without
 * hitting the network.
 */

import type { NativePlatform } from "@/lib/capacitor/_shared"
import type { OcrProvider, OcrProviderCategory } from "@/types/ocr"

export interface OcrRegistry {
  register(provider: OcrProvider): void
  unregister(id: string): boolean
  has(id: string): boolean
  get(id: string): OcrProvider | undefined
  list(): OcrProvider[]
  listByCategory(category: OcrProviderCategory): OcrProvider[]
  listForShell(platform: NativePlatform): OcrProvider[]
  clear(): void
}

/** Build a fresh, empty registry. */
export function createOcrRegistry(): OcrRegistry {
  const byId = new Map<string, OcrProvider>()

  const registry: OcrRegistry = {
    register(provider) {
      if (byId.has(provider.id)) {
        throw new Error(`OcrRegistry: duplicate provider id "${provider.id}"`)
      }
      byId.set(provider.id, provider)
    },
    unregister(id) {
      return byId.delete(id)
    },
    has(id) {
      return byId.has(id)
    },
    get(id) {
      return byId.get(id)
    },
    list() {
      return Array.from(byId.values())
    },
    listByCategory(category) {
      return registry.list().filter((p) => p.category === category)
    },
    listForShell(platform) {
      return registry.list().filter((p) => shellAllows(p, platform))
    },
    clear() {
      byId.clear()
    },
  }
  return registry
}

export function shellAllows(provider: OcrProvider, platform: NativePlatform): boolean {
  switch (platform) {
    case "tauri":
      return provider.shells.tauri
    case "mobile":
      return provider.shells.capacitor
    case "web":
      return provider.shells.browser
    case "headless":
      return false
  }
}

/**
 * Shared singleton registry used by `lib/ocr/index.ts` in app code. Provider
 * implementation files call `registerOcrProvider()` at module-load time.
 * Tests reach for `createOcrRegistry()` directly instead.
 */
const sharedRegistry = createOcrRegistry()

export function registerOcrProvider(provider: OcrProvider): void {
  sharedRegistry.register(provider)
}

export function getSharedOcrRegistry(): OcrRegistry {
  return sharedRegistry
}

/** Test helper — wipes the shared registry between tests that touch it. */
export function __resetSharedOcrRegistry(): void {
  sharedRegistry.clear()
}
