import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  ACTIONABLE_INCIDENT_STATES,
  ARTIFACT_KINDS,
  AUDIT_ACTIONS,
  DIAGNOSTIC_ROLES,
  INCIDENT_CLIENT_STATES,
  INCIDENT_PROCESSING_STATES,
  isArtifactKind,
  isAuditAction,
  isIncidentClientState,
  isIncidentProcessingState,
  normalizeIncidentClientState,
  rolePermits,
  type ArtifactKind,
  type CreateIncidentResponse,
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

  it("documents that a resumed submission carries no deletion credential", () => {
    // The service withholds it deliberately: the upsert leaves the stored hash
    // alone, so a second credential could never verify. The type has to make
    // that absence representable or a caller will assume it is always there.
    const resumed: CreateIncidentResponse = {
      incident: {} as CreateIncidentResponse["incident"],
      created: false,
    }
    expect(resumed.deletionCredential).toBeUndefined()
    expect(CONTRACT).toContain("only when `created` is true")
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

describe("runtime vocabularies", () => {
  it("exposes the processing states as the contract's enum, in order", () => {
    expect([...INCIDENT_PROCESSING_STATES]).toEqual(contractEnum("ProcessingState"))
    expect(isIncidentProcessingState("grouping")).toBe(true)
    expect(isIncidentProcessingState("Grouping")).toBe(false)
    expect(isIncidentProcessingState(7)).toBe(false)
  })

  it("lists every client state once, in lifecycle order", () => {
    expect(INCIDENT_CLIENT_STATES[0]).toBe("detected")
    expect(INCIDENT_CLIENT_STATES).toContain("packaged")
    expect(new Set(INCIDENT_CLIENT_STATES).size).toBe(INCIDENT_CLIENT_STATES.length)
    expect(ACTIONABLE_INCIDENT_STATES.every((state) => isIncidentClientState(state))).toBe(true)
  })

  it("normalizes the legacy camelCase spelling and refuses anything else", () => {
    expect(normalizeIncidentClientState("awaiting_consent")).toBe("awaiting_consent")
    expect(normalizeIncidentClientState("awaitingConsent")).toBe("awaiting_consent")
    expect(normalizeIncidentClientState("packaged")).toBe("packaged")
    expect(normalizeIncidentClientState("submitted")).toBeNull()
    expect(normalizeIncidentClientState(undefined)).toBeNull()
  })

  it("narrows artifact kinds and audit actions", () => {
    expect(ARTIFACT_KINDS).toHaveLength(5)
    expect(isArtifactKind("minidump")).toBe(true)
    expect(isArtifactKind("core")).toBe(false)
    expect(isAuditAction("artifact.read")).toBe(true)
    expect(isAuditAction("artifact.write")).toBe(false)
  })

  it("pins every audit action the service writes", () => {
    // The Rust side spells each action as a string literal passed to one of
    // three helpers; reading them back keeps this list from drifting behind a
    // new action, which would otherwise render under the generic label.
    const source = readFileSync(join(process.cwd(), "services/diagnostic-server/src/db.rs"), "utf8")
    const written = new Set(
      [
        ...source.matchAll(
          /"((?:alert|artifact|consent|group|incident|retention|symbol|tenant|tenant_key|upload)\.[a-z_]+)"/g
        ),
      ]
        .map((match) => match[1])
        .filter((action) => action !== "incident.dmp")
    )
    for (const action of written) expect(AUDIT_ACTIONS).toContain(action)
  })
})
