// Constants-parity gate against the committed canonical fixture
// ../../share-constants.json (ADR-0059 P0.3). The Rust twin lives at
// tests/constants_parity.rs — drift on either side fails that side's CI.

import { describe, expect, it } from "vitest"
import fixture from "../../share-constants.json"
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_TTL_SECONDS,
  KV_MIN_TTL_SECONDS,
} from "./index"

describe("share constants parity (share-constants.json)", () => {
  it("code length matches the fixture", () => {
    expect(CODE_LENGTH).toBe(fixture.codeLength)
  })

  it("code alphabet matches the fixture", () => {
    expect(CODE_ALPHABET).toBe(fixture.codeAlphabet)
  })

  it("default max body bytes matches the fixture", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(fixture.defaultMaxBodyBytes)
  })

  it("default max TTL seconds matches the fixture", () => {
    expect(DEFAULT_MAX_TTL_SECONDS).toBe(fixture.defaultMaxTtlSeconds)
  })

  it("KV minimum TTL matches the fixture (Worker-only constraint)", () => {
    expect(KV_MIN_TTL_SECONDS).toBe(fixture.kvMinTtlSeconds)
  })
})
