/**
 * Re-export `isTauri` under the `@/lib/native/utils` path so ported Cognia
 * code that imports it from there typechecks. cognia-next's authoritative
 * Tauri detection lives in `lib/tauri.ts` — this is a thin alias to keep
 * import paths stable across the port.
 */

export { isTauri } from "@/lib/tauri"
