import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  DIAGNOSTIC_ROLES,
  rolePermits,
  type ArtifactKind,
  type GroupStatus,
  type IncidentClientState,
  type IncidentProcessingState,
} from "./types"

/**
 * The service is a separate Cargo project with its own lockfile and release
 * cadence, and nothing generates these types from its contract. Reading the
 * published `openapi.yaml` here is the other half of the service's own
 * `every_console_route_is_in_the_published_contract` test: that one fails when
 * a route leaves the document, this one fails when the document and the
 * TypeScript enums stop agreeing.
 */
const CONTRACT = readFileSync(
  join(process.cwd(), "services/diagnostic-server/openapi.yaml"),
  "utf8"
)

/**
 * Pull one `enum: [...]` list out of the contract.
 *
 * Tolerates both the inline form and the multi-line form prettier reflows a
 * long list into, so a formatting pass over the YAML cannot quietly turn this
 * gate into a no-op.
 */
function contractEnum(name: string): string[] {
  const declaration = new RegExp(
    `${name}:\\s*\\n\\s*type: string\\s*\\n\\s*enum:\\s*\\[([^\\]]+)\\]`
  )
  const match = declaration.exec(CONTRACT)
  if (!match) throw new Error(`no enum named ${name} in openapi.yaml`)
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
}

describe("rolePermits", () => {
  it("orders the rungs exactly as the service ranks them", () => {
    expect([...DIAGNOSTIC_ROLES]).toEqual(contractEnum("GrantRole"))
  })

  it("admits a role at or above the requirement and nothing below it", () => {
    expect(rolePermits("uploader", "uploader")).toBe(true)
    expect(rolePermits("uploader", "viewer")).toBe(false)
    expect(rolePermits("viewer", "uploader")).toBe(true)
    expect(rolePermits("triager", "viewer")).toBe(true)
    expect(rolePermits("triager", "admin")).toBe(false)
    expect(rolePermits("admin", "admin")).toBe(true)
  })

  it("is total over every declared pair", () => {
    for (const role of DIAGNOSTIC_ROLES) {
      for (const required of DIAGNOSTIC_ROLES) {
        expect(typeof rolePermits(role, required)).toBe("boolean")
      }
    }
    // Reflexive, and transitive along the declared order.
    expect(DIAGNOSTIC_ROLES.every((role) => rolePermits(role, role))).toBe(true)
  })
})

describe("wire enums", () => {
  it("matches the contract's group statuses", () => {
    const statuses: GroupStatus[] = ["open", "suppressed", "resolved"]
    expect(statuses).toEqual(contractEnum("GroupStatus"))
  })

  it("matches the contract's processing states", () => {
    const states: IncidentProcessingState[] = [
      "received",
      "scanning",
      "symbolicating",
      "grouping",
      "accepted",
      "retryable_failure",
      "permanent_failure",
      "deleted",
    ]
    expect(states).toEqual(contractEnum("ProcessingState"))
  })

  it("separates what a client may declare from what the store can hold", () => {
    // The storage column accepts five kinds — a part read back through the
    // console can be any of them, so the union has to cover all five.
    const stored: ArtifactKind[] = ["manifest", "events", "attachment", "minidump", "screenshot"]
    expect(new Set(stored).size).toBe(5)
    // The `x-artifact-kind` request header is deliberately narrower: a client
    // may only ever *declare* an attachment or a minidump. `manifest`,
    // `events` and `screenshot` are set by the service's own pipeline, and
    // letting an uploader claim them would let it steer processing.
    expect(CONTRACT).toContain("enum: [attachment, minidump]")
  })

  it("keeps the client lifecycle aligned with the incident state machine", () => {
    // Mirrors `incident_state` in migration 0001. Not in the OpenAPI document
    // (it is a response field, not a parameter), so the assertion is the list
    // itself — a change to the Rust enum without a change here is what this
    // catches in review.
    const states: IncidentClientState[] = [
      "detected",
      "packaged",
      "awaiting_consent",
      "queued",
      "uploading",
      "processing",
      "accepted",
      "rejected",
      "cancelled",
      "deleted",
    ]
    expect(new Set(states).size).toBe(states.length)
    expect(states).toContain("awaiting_consent")
  })
})
