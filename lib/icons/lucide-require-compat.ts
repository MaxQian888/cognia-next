/**
 * A stand-in for the `lucide-react` module object, backed by the catalog.
 *
 * # Why this exists
 *
 * Plugin code — and the shared-module table that serves it (`lib/plugin/core/
 * shared-modules.ts`) — expects to `require("lucide-react")` and get the real
 * module: named icon exports, plus the `icons` record keyed by icon name.
 * Handing it the real module re-imports all ~1.6k components and undoes what
 * [`./lucide-catalog`] exists to avoid.
 *
 * # Why a Proxy rather than a built object
 *
 * Materializing an object with 1.6k lazily-created components would defeat the
 * point twice over — the components would all exist, and the catalog's own
 * cache would fill on module load rather than on use. A `Proxy` resolves each
 * name on first access instead, so a plugin that names three icons costs three
 * components.
 *
 * All four traps are implemented, not just `get`: `has` answers `in`,
 * `ownKeys` + `getOwnPropertyDescriptor` answer `Object.keys` and spread. A
 * `get`-only proxy looks correct until a consumer enumerates it and sees an
 * empty module. `getOwnPropertyDescriptor` reports `configurable: true`
 * because the target is genuinely empty — a non-configurable descriptor for a
 * property the target does not have is a `TypeError` in the invariant check.
 *
 * Export names and catalog names differ (`Home` and `HomeIcon` are one icon),
 * which is why the module face resolves through `getLucideExport` while the
 * nested `icons` record resolves through `getLucideIcon`.
 */
import { getLucideExport, getLucideExportNames, lucideIcons } from "./lucide-catalog"

// The nested `icons` record is the catalog's own name-keyed proxy — the same
// object render sites index — so the module face and the app resolve one name
// through one cache.
const icons = lucideIcons

export const lucideRequireCompat = new Proxy<Record<string, unknown>>(
  { icons },
  {
    get: (target, property) => {
      if (property === "icons") return icons
      if (typeof property !== "string") return undefined
      return getLucideExport(property) ?? Reflect.get(target, property)
    },
    has: (target, property) =>
      property === "icons" ||
      (typeof property === "string" && getLucideExport(property) !== null) ||
      Reflect.has(target, property),
    ownKeys: () => ["icons", ...getLucideExportNames()],
    getOwnPropertyDescriptor: (_target, property) =>
      property === "icons" || (typeof property === "string" && getLucideExport(property) !== null)
        ? { configurable: true, enumerable: true }
        : undefined,
  }
)
