import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  DEVICE_GRANT_IDS,
  GRANT_CAPABILITIES,
  LOCKED_USE_AVAILABLE,
  buildGrantRows,
  isGrantEnabled,
  ownerPermits,
  type GrantEvidence,
} from "./grant-capabilities"

const CONTROL = GRANT_CAPABILITIES.control

function evidence(overrides: Partial<GrantEvidence> = {}): GrantEvidence {
  return {
    mirror: { control: false, agentControl: false, terminal: false, lockedComputerUse: false },
    revoked: false,
    ...overrides,
  }
}

function rowFor(rows: ReturnType<typeof buildGrantRows>, id: (typeof DEVICE_GRANT_IDS)[number]) {
  const row = rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`missing grant row ${id}`)
  return row
}

describe("GRANT_CAPABILITIES mirror", () => {
  /**
   * The Rust table in `device_grants.rs` is canonical and says so. This is the
   * gate that keeps the mirror from drifting: a capability renamed there and
   * not here would silently downgrade every device to `partial`, which reads
   * as a security regression rather than a typo.
   */
  it("only names capabilities the generated host command catalog knows", () => {
    const catalog = JSON.parse(
      readFileSync(
        join(process.cwd(), "crates", "cognia-cli", "assets", "host-command-catalog.json"),
        "utf8"
      )
    ) as { commands: { capability?: string }[] }
    const known = new Set(
      catalog.commands
        .map((command) => command.capability)
        .filter((value): value is string => Boolean(value))
    )
    expect(known.size).toBeGreaterThan(0)

    for (const id of DEVICE_GRANT_IDS) {
      for (const capability of GRANT_CAPABILITIES[id]) {
        expect(known.has(capability)).toBe(true)
      }
    }
  })

  it("keeps the three real grants disjoint, as the Rust test does", () => {
    const pairs = [
      ["control", "agentControl"],
      ["control", "terminal"],
      ["agentControl", "terminal"],
    ] as const
    for (const [a, b] of pairs) {
      const overlap = GRANT_CAPABILITIES[a].filter((c) => GRANT_CAPABILITIES[b].includes(c))
      expect(overlap).toEqual([])
    }
  })
})

describe("buildGrantRows — raw host capabilities available", () => {
  it("reports a fully held grant as granted", () => {
    const rows = buildGrantRows(evidence({ hostCapabilities: [...CONTROL] }))
    expect(rowFor(rows, "control")).toMatchObject({
      state: "granted",
      heldCapabilities: [...CONTROL],
    })
  })

  /**
   * The defect this whole module exists for: `companion_list_device_grants`
   * answers with an all-of test, so this device came back `false` and rendered
   * identically to one that had never been granted anything.
   */
  it("distinguishes a half-held grant from a denied one", () => {
    const rows = buildGrantRows(evidence({ hostCapabilities: ["agent.run", "workspace.read"] }))
    const control = rowFor(rows, "control")
    expect(control.state).toBe("partial")
    expect(control.heldCapabilities).toEqual(["agent.run", "workspace.read"])
    expect(control.capabilities).toEqual([...CONTROL])
    expect(isGrantEnabled(control)).toBe(true)
  })

  it("reports a grant with none of its capabilities as denied", () => {
    const rows = buildGrantRows(evidence({ hostCapabilities: ["terminal.open"] }))
    expect(rowFor(rows, "control").state).toBe("denied")
    expect(rowFor(rows, "terminal").state).toBe("granted")
    expect(isGrantEnabled(rowFor(rows, "control"))).toBe(false)
  })

  it("outranks the host's collapsed boolean when both are present", () => {
    const rows = buildGrantRows(
      evidence({
        hostCapabilities: ["agent.run"],
        hostVerdict: { control: false, agentControl: false, terminal: false },
      })
    )
    expect(rowFor(rows, "control").state).toBe("partial")
  })
})

describe("buildGrantRows — degraded evidence", () => {
  it("falls back to the host verdict when the raw set is unavailable", () => {
    const rows = buildGrantRows(
      evidence({ hostVerdict: { control: true, agentControl: false, terminal: false } })
    )
    expect(rowFor(rows, "control").state).toBe("granted")
    expect(rowFor(rows, "control").reasonKey).toBeUndefined()
    expect(rowFor(rows, "agentControl").state).toBe("denied")
  })

  it("falls back to the local mirror last, and says so", () => {
    const rows = buildGrantRows(
      evidence({
        mirror: { control: true, agentControl: false, terminal: true, lockedComputerUse: false },
      })
    )
    expect(rowFor(rows, "control")).toMatchObject({ state: "granted", reasonKey: "mirrorOnly" })
    expect(rowFor(rows, "terminal")).toMatchObject({ state: "granted", reasonKey: "mirrorOnly" })
  })

  it("holds nothing for a revoked device, whatever any table still says", () => {
    const rows = buildGrantRows(
      evidence({
        revoked: true,
        hostCapabilities: [...CONTROL, "process.spawn", "terminal.open"],
        mirror: { control: true, agentControl: true, terminal: true, lockedComputerUse: true },
      })
    )
    for (const row of rows) {
      expect(row.state).toBe("denied")
      expect(row.heldCapabilities).toEqual([])
    }
    expect(rowFor(rows, "control").reasonKey).toBe("deviceRevoked")
  })
})

describe("Locked Use dormancy", () => {
  /**
   * Test axis of the three-axis dormancy contract (CLAUDE.md working rule 7).
   * Flipping `LOCKED_USE_AVAILABLE` must fail here, so the UI label and the
   * native allow list are revisited in the same change.
   */
  it("is inert on this build", () => {
    expect(LOCKED_USE_AVAILABLE).toBe(false)
  })

  it("stays denied and unavailable even when the mirror bit is set", () => {
    const rows = buildGrantRows(
      evidence({
        mirror: { control: true, agentControl: false, terminal: false, lockedComputerUse: true },
      })
    )
    expect(rowFor(rows, "lockedComputerUse")).toMatchObject({
      state: "denied",
      available: false,
      reasonKey: "lockedUseUnavailable",
      capabilities: [],
    })
  })

  it("has no SecurityStore capability behind it — it is a separate allow list", () => {
    expect(GRANT_CAPABILITIES.lockedComputerUse).toEqual([])
  })
})

describe("row coverage", () => {
  it("returns exactly one row per grant id, in catalog order", () => {
    const rows = buildGrantRows(evidence())
    expect(rows.map((row) => row.id)).toEqual([...DEVICE_GRANT_IDS])
  })
})

describe("ownerPermits", () => {
  const HOST = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"
  const OTHER = "usr_bbbbbbbbbbbbbbbbbbbbbbbb"

  it("permits the bound person's own device and refuses somebody else's", () => {
    expect(ownerPermits(HOST, HOST)).toBe(true)
    expect(ownerPermits(HOST, OTHER)).toBe(false)
  })

  it("permits when either side is unattributed", () => {
    // Nobody signed in — the common state, and not a denial.
    expect(ownerPermits(undefined, OTHER)).toBe(true)
    // Every device that existed before ADR-0149 gave `devices` its column.
    expect(ownerPermits(HOST, undefined)).toBe(true)
    expect(ownerPermits(undefined, undefined)).toBe(true)
  })

  /**
   * The host decides this in SQL, per request. This mirror exists only to
   * explain a switch the console draws as off, so it must not answer
   * differently — a mirror that drifts would keep drawing a grant as live that
   * the host has been refusing.
   */
  it("matches the SQL predicate the host actually evaluates", () => {
    const rust = readFileSync(
      join(process.cwd(), "src-tauri", "src", "companion_api", "security_store.rs"),
      "utf8"
    )
    const match = rust.match(/pub const OWNER_PREDICATE_SQL: &str =\s*"([^"]+)";/)
    expect(match).not.toBeNull()
    const predicate = match![1]!

    // Read as: host unattributed, OR device unattributed, OR they are the same
    // person — which is exactly the three-branch shape above.
    expect(predicate).toContain("h.user_id IS NULL")
    expect(predicate).toContain("d.user_id IS NULL")
    expect(predicate).toContain("d.user_id = h.user_id")
    expect(predicate.split(" OR ")).toHaveLength(3)

    // And the Rust twin, whose own test drives it against the SQL.
    expect(rust).toContain(
      "pub fn owner_permits(host_person: Option<&str>, device_person: Option<&str>) -> bool"
    )
  })
})

describe("buildGrantRows under a suspended owner", () => {
  it("marks every grant suspended without claiming the capabilities are gone", () => {
    const rows = buildGrantRows(evidence({ hostCapabilities: [...CONTROL], ownerSuspended: true }))

    for (const row of rows) {
      expect(row.state).toBe("suspended")
      expect(row.heldCapabilities).toEqual([])
      expect(row.reasonKey).toBe("ownerMismatch")
      // The switch reads off: the host is refusing the grant right now.
      expect(isGrantEnabled(row)).toBe(false)
    }
  })

  it("lets revocation win, because a revoked device is revoked for everybody", () => {
    const rows = buildGrantRows(
      evidence({ hostCapabilities: [...CONTROL], ownerSuspended: true, revoked: true })
    )
    expect(rowFor(rows, "control").state).toBe("denied")
    expect(rowFor(rows, "control").reasonKey).toBe("deviceRevoked")
  })

  it("leaves an unsuspended device exactly as it was", () => {
    const before = buildGrantRows(evidence({ hostCapabilities: [...CONTROL] }))
    const after = buildGrantRows(
      evidence({ hostCapabilities: [...CONTROL], ownerSuspended: false })
    )
    expect(after).toEqual(before)
  })
})
