/**
 * Cross-language parity gate for the remote-control command surface.
 *
 * Three artifacts must never drift:
 *   1. `REMOTE_COMMAND_TARGETS` (the TS union source of truth, this file's dir)
 *   2. `dispatchableTargets()` (the runtime handler map in `lib/remote-control/dispatch.ts`)
 *   3. the `RemoteCommandTarget` enum in `docs/api/remote-control.openapi.yaml`
 *
 * The Rust `KNOWN_TARGETS` is pinned to the same OpenAPI enum by
 * `src-tauri/src/remote_control/spec_parity.rs`, so (1)+(3) here plus that test
 * transitively keep Rust ↔ TS in sync.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { REMOTE_COMMAND_TARGETS } from "./index"
import { dispatchableTargets } from "@/lib/remote-control/dispatch"

/** Mirror of the Rust extractor: collect the `RemoteCommandTarget` enum items. */
function extractTargetEnum(spec: string): string[] {
  const out: string[] = []
  let inSchema = false
  let inEnum = false
  for (const raw of spec.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!inSchema) {
      if (trimmed === "RemoteCommandTarget:") inSchema = true
      continue
    }
    if (!inEnum) {
      if (trimmed === "enum:") inEnum = true
      continue
    }
    if (trimmed.startsWith("- ")) {
      out.push(trimmed.slice(2).trim())
    } else if (trimmed.length > 0) {
      break
    }
  }
  return out
}

function readSpecEnum(): string[] {
  const specPath = join(__dirname, "..", "..", "docs", "api", "remote-control.openapi.yaml")
  return extractTargetEnum(readFileSync(specPath, "utf8"))
}

const sorted = (xs: readonly string[]) => [...xs].sort()

describe("remote command target parity", () => {
  it("extracts a non-trivial enum from the OpenAPI spec", () => {
    expect(readSpecEnum().length).toBeGreaterThanOrEqual(5)
  })

  it("REMOTE_COMMAND_TARGETS matches the dispatch handler map", () => {
    expect(sorted(dispatchableTargets())).toEqual(sorted(REMOTE_COMMAND_TARGETS))
  })

  it("REMOTE_COMMAND_TARGETS matches the OpenAPI RemoteCommandTarget enum", () => {
    expect(sorted(readSpecEnum())).toEqual(sorted(REMOTE_COMMAND_TARGETS))
  })
})
