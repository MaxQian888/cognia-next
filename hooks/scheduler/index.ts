/**
 * Scheduler hooks barrel.
 * `useSystemScheduler` is added in Phase 4 alongside the Rust-side system
 * scheduler. The /scheduler page imports it from this barrel, so the export
 * must exist; until the real hook lands we ship a typed no-op stub that
 * advertises an unavailable backend.
 */

export { useScheduler } from "./use-scheduler"
export { useSystemScheduler, type UseSystemSchedulerReturn } from "./use-system-scheduler"
