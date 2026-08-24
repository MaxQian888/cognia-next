import {
  EMPTY_CAPABILITY_OVERLAY,
  WORKSPACE_CAPABILITY_KINDS,
  applyCapabilityOverlay,
  capabilityStateOf,
  countCapabilityOverrides,
  pruneCapabilityOverlay,
  resolveCapabilityEnabled,
  resolveEnabledCapabilityIds,
  withCapabilityState,
  type WorkspaceCapabilityOverlay,
} from "./capability-overlay"

const rows = [
  { id: "a", enabled: true },
  { id: "b", enabled: true },
  { id: "c", enabled: false },
]

describe("capabilityStateOf", () => {
  it("reads absent as inherit", () => {
    expect(capabilityStateOf({}, "skill", "a")).toBe("inherit")
    expect(capabilityStateOf(undefined, "skill", "a")).toBe("inherit")
    expect(capabilityStateOf(null, "skill", "a")).toBe("inherit")
  })

  it("distinguishes on from off", () => {
    const overlay: WorkspaceCapabilityOverlay = { skill: { a: true, b: false } }
    expect(capabilityStateOf(overlay, "skill", "a")).toBe("on")
    expect(capabilityStateOf(overlay, "skill", "b")).toBe("off")
  })

  it("does not leak one kind's opinion into another", () => {
    const overlay: WorkspaceCapabilityOverlay = { skill: { shared: false } }
    expect(capabilityStateOf(overlay, "mcpServer", "shared")).toBe("inherit")
  })

  it("treats a malformed bucket as no opinion instead of throwing", () => {
    const overlay = { skill: ["a"] } as unknown as WorkspaceCapabilityOverlay
    expect(capabilityStateOf(overlay, "skill", "a")).toBe("inherit")
  })
})

describe("resolveCapabilityEnabled", () => {
  it("falls through to the global flag when inheriting", () => {
    expect(resolveCapabilityEnabled(true, {}, "skill", "a")).toBe(true)
    expect(resolveCapabilityEnabled(false, {}, "skill", "a")).toBe(false)
  })

  it("lets the workspace turn something on that is globally off", () => {
    expect(resolveCapabilityEnabled(false, { skill: { a: true } }, "skill", "a")).toBe(true)
  })

  it("lets the workspace turn something off that is globally on", () => {
    expect(resolveCapabilityEnabled(true, { skill: { a: false } }, "skill", "a")).toBe(false)
  })
})

describe("applyCapabilityOverlay", () => {
  it("returns every row when the workspace has no opinions", () => {
    expect(applyCapabilityOverlay(rows, "skill", {}, { idOf: (r) => r.id })).toEqual(rows)
  })

  it("removes a row the workspace turned off", () => {
    const kept = applyCapabilityOverlay(
      rows,
      "skill",
      { skill: { b: false } },
      {
        idOf: (r) => r.id,
      }
    )
    expect(kept.map((r) => r.id)).toEqual(["a", "c"])
  })

  it("cannot resurrect a row when the caller already filtered", () => {
    // `listEnabledMcpServers` hands us only the globally-enabled rows, so an
    // "on" override there has nothing to act on — the honest result is that
    // the row simply is not in the list, not a phantom entry.
    const enabledOnly = rows.filter((r) => r.enabled)
    const kept = applyCapabilityOverlay(
      enabledOnly,
      "skill",
      { skill: { c: true } },
      {
        idOf: (r) => r.id,
      }
    )
    expect(kept.map((r) => r.id)).toEqual(["a", "b"])
  })

  it("resurrects a globally-disabled row when given the full table", () => {
    const kept = applyCapabilityOverlay(
      rows,
      "skill",
      { skill: { c: true } },
      {
        idOf: (r) => r.id,
        enabledOf: (r) => r.enabled,
        alreadyFiltered: false,
      }
    )
    expect(kept.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("applies the global flag when unfiltered and the workspace is silent", () => {
    const kept = applyCapabilityOverlay(rows, "skill", undefined, {
      idOf: (r) => r.id,
      enabledOf: (r) => r.enabled,
      alreadyFiltered: false,
    })
    expect(kept.map((r) => r.id)).toEqual(["a", "b"])
  })

  it("refuses an unfiltered call that cannot read the global flag", () => {
    expect(() =>
      applyCapabilityOverlay(rows, "skill", undefined, {
        idOf: (r) => r.id,
        alreadyFiltered: false,
      })
    ).toThrow(/enabledOf is required/)
  })

  it("does not mutate the input array", () => {
    const input = [...rows]
    applyCapabilityOverlay(input, "skill", { skill: { a: false } }, { idOf: (r) => r.id })
    expect(input).toHaveLength(3)
  })
})

describe("resolveEnabledCapabilityIds", () => {
  it("projects the enabled set from the global flags plus the overlay", () => {
    expect(
      resolveEnabledCapabilityIds(
        rows,
        "skill",
        { skill: { b: false, c: true } },
        {
          idOf: (r) => r.id,
          enabledOf: (r) => r.enabled,
        }
      )
    ).toEqual(["a", "c"])
  })
})

describe("withCapabilityState", () => {
  it("records on and off", () => {
    expect(withCapabilityState({}, "skill", "a", "on")).toEqual({ skill: { a: true } })
    expect(withCapabilityState({}, "skill", "a", "off")).toEqual({ skill: { a: false } })
  })

  it("deletes the entry on inherit rather than storing a tombstone", () => {
    expect(withCapabilityState({ skill: { a: true, b: false } }, "skill", "a", "inherit")).toEqual({
      skill: { b: false },
    })
  })

  it("drops the bucket once its last override is cleared", () => {
    expect(withCapabilityState({ skill: { a: true } }, "skill", "a", "inherit")).toEqual({})
  })

  it("keeps the other kind untouched", () => {
    expect(withCapabilityState({ mcpServer: { m: false } }, "skill", "a", "on")).toEqual({
      mcpServer: { m: false },
      skill: { a: true },
    })
  })

  it("does not mutate the overlay it was given", () => {
    const overlay: WorkspaceCapabilityOverlay = { skill: { a: true } }
    withCapabilityState(overlay, "skill", "b", "off")
    expect(overlay).toEqual({ skill: { a: true } })
  })

  it("accepts the frozen empty overlay", () => {
    expect(withCapabilityState(EMPTY_CAPABILITY_OVERLAY, "skill", "a", "on")).toEqual({
      skill: { a: true },
    })
  })
})

describe("countCapabilityOverrides", () => {
  it("counts across every kind by default", () => {
    expect(countCapabilityOverrides({ skill: { a: true }, mcpServer: { m: false, n: true } })).toBe(
      3
    )
  })

  it("narrows to one kind", () => {
    expect(
      countCapabilityOverrides({ skill: { a: true }, mcpServer: { m: false } }, "mcpServer")
    ).toBe(1)
  })

  it("is zero for an absent overlay", () => {
    expect(countCapabilityOverrides(undefined)).toBe(0)
  })
})

describe("pruneCapabilityOverlay", () => {
  it("drops overrides whose capability is gone", () => {
    expect(
      pruneCapabilityOverlay({ skill: { alive: true, deleted: false } }, { skill: ["alive"] })
    ).toEqual({ skill: { alive: true } })
  })

  it("leaves a kind alone when the caller could not enumerate it", () => {
    // Pruning against an inventory that failed to load would silently discard
    // the user's choices, which is worse than a stale count.
    expect(pruneCapabilityOverlay({ mcpServer: { m: false } }, { skill: [] })).toEqual({
      mcpServer: { m: false },
    })
  })

  it("returns an empty overlay once nothing survives", () => {
    expect(pruneCapabilityOverlay({ skill: { gone: true } }, { skill: [] })).toEqual({})
  })
})

describe("WORKSPACE_CAPABILITY_KINDS", () => {
  it("deliberately excludes plugins", () => {
    // `plugins.enabled` doubles as the runtime's loaded state (written by
    // `manager.setPluginIntent`), so a per-workspace overlay would rewrite the
    // record of what is actually running on every switch. Pinned here so the
    // exclusion has to be argued with, not just typed over.
    expect(WORKSPACE_CAPABILITY_KINDS).toEqual(["skill", "mcpServer"])
    expect(WORKSPACE_CAPABILITY_KINDS).not.toContain("plugin")
  })
})
