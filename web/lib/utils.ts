import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge class names, letting later Tailwind utilities win over earlier ones in
 * the same group.
 *
 * A deliberate four-line duplicate of the product's `lib/utils/index.ts`.
 * ADR-0092 §1 gives this workspace zero cross-package imports so a brochure
 * never drags the Zustand / Dexie / Tauri graph behind it, and `cn` is the
 * smallest possible thing to copy rather than the first exception to that rule.
 *
 * Note that the site's own radius scale (`rounded-control` / `-panel` /
 * `-stage`, added via `@theme inline`) is NOT a scale `tailwind-merge` knows
 * about — see `utils.test.ts`, which pins the real behaviour so nobody writes
 * `cn("rounded-panel", "rounded-stage")` expecting the second to win.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
