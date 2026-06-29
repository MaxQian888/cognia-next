/**
 * Twin's distill orchestrator imports `withTimeout` from `./with-timeout`,
 * which is now a thin re-export of `@cognia/primitives` (see
 * PR-B in `plans/noble-hatching-mango.md`). The behaviour suite lives
 * next to the source at `lib/utils/with-timeout.test.ts`; this file
 * just asserts the re-export identity so a future refactor that
 * forgets to forward a symbol fails loudly.
 */

import * as twin from "./with-timeout"
import * as canonical from "@cognia/primitives"

describe("lib/twin/distill/with-timeout re-export", () => {
  it("re-exports withTimeout, TimeoutError, withTimeoutOrFallback, DEFAULT_AGENT_TIMEOUT_MS", () => {
    expect(twin.withTimeout).toBe(canonical.withTimeout)
    expect(twin.TimeoutError).toBe(canonical.TimeoutError)
    expect(twin.withTimeoutOrFallback).toBe(canonical.withTimeoutOrFallback)
    expect(twin.DEFAULT_AGENT_TIMEOUT_MS).toBe(canonical.DEFAULT_AGENT_TIMEOUT_MS)
  })
})
