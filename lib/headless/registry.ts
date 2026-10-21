/**
 * Headless runtime registry (ADR-0059 W2 / T-A1).
 *
 * Module-level registry the extracted runtimes register into (see
 * `lib/headless/runtimes/index.ts`, the single anchor the wiring auditor
 * checks). `bootstrapHeadlessRuntimes()` consumes it.
 */
import type { HeadlessRuntime } from "./types"

const runtimes = new Map<string, HeadlessRuntime>()

/**
 * Register a runtime. Development HMR can reevaluate a runtime module while
 * retaining this registry, so replace its definition without changing order.
 * Registration never starts a runtime. Outside development, duplicate names
 * still throw so wiring mistakes cannot silently replace a runtime.
 */
export function registerHeadlessRuntime(runtime: HeadlessRuntime): void {
  if (!runtime.name.trim()) {
    throw new Error("headless runtime must have a non-empty name")
  }
  if (runtimes.has(runtime.name) && process.env.NODE_ENV !== "development") {
    throw new Error(`headless runtime "${runtime.name}" is already registered`)
  }
  runtimes.set(runtime.name, runtime)
}

/** Registered runtimes in registration order. */
export function listHeadlessRuntimes(): HeadlessRuntime[] {
  return Array.from(runtimes.values())
}

/** Test-only: clear the registry. */
export function __resetHeadlessRuntimesForTesting(): void {
  runtimes.clear()
}
