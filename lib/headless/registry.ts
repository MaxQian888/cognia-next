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
 * Register a runtime. Throws on a duplicate name — two registrations with
 * one name is always a wiring bug (double import or a copy-paste slip), and
 * silently keeping either one hides it.
 */
export function registerHeadlessRuntime(runtime: HeadlessRuntime): void {
  if (!runtime.name.trim()) {
    throw new Error("headless runtime must have a non-empty name")
  }
  if (runtimes.has(runtime.name)) {
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
