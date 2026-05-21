/**
 * Shared helpers for the five-platform smoke suite.
 *
 * Smoke tests live in `*.smoke.test.ts` next to this helper. They use
 * `fake-indexeddb/auto` so Dexie is available, then exercise the full
 * inbound-bus-runtime path for each adapter with synthetic payloads.
 *
 * Heavy mocking is intentional: the goal is to verify the wiring — that
 * an inbound platform payload reaches the bus dispatch path and that
 * the A2UI projection lands on the persisted message metadata — not to
 * replay live HTTP traffic.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

/** Minimal AdapterInstanceRow factory used by every smoke spec. */
export function makeAdapterRow(
  overrides: Partial<AdapterInstanceRow> & { id: string; type: string }
): AdapterInstanceRow {
  const defaults = {
    displayName: `${overrides.type}-test`,
    enabled: true,
    transportMode: "gateway" as const,
    settings: {} as Record<string, unknown>,
    credentialsRef: { keyringService: "x", accounts: [] as string[] },
    trigger: {} as never,
    defaultMode: "auto" as const,
    createdAt: 0,
    updatedAt: 0,
  }
  return { ...defaults, ...overrides } as AdapterInstanceRow
}

export async function resetSmokeState(): Promise<void> {
  try {
    await getDb().delete()
  } catch {
    // First call may race with the in-memory db init — ignore.
  }
  __resetDbForTesting()
}
