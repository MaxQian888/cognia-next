import {
  ASSET_KIND_GROUP,
  EXECUTOR_PRIMARY_ACTION,
  IN_APP_EXECUTORS,
  UPDATE_ASSET_KINDS,
  UPDATE_EXECUTORS,
  UPDATE_STATES,
  UPDATE_STATE_TRANSITIONS,
  canTransitionUpdateState,
  isInAppExecutor,
  updateSnapshotKey,
  type UpdateState,
} from "./updates"

describe("update vocabulary", () => {
  it("groups every asset kind", () => {
    for (const kind of UPDATE_ASSET_KINDS) expect(ASSET_KIND_GROUP[kind]).toBeDefined()
  })

  it("gives every executor exactly one primary action", () => {
    for (const executor of UPDATE_EXECUTORS) {
      expect(EXECUTOR_PRIMARY_ACTION[executor]).toBeDefined()
    }
  })

  it("keeps the store and browser executors out of the in-app set", () => {
    expect(isInAppExecutor("app-store")).toBe(false)
    expect(isInAppExecutor("google-play")).toBe(false)
    expect(isInAppExecutor("browser-store")).toBe(false)
    expect(isInAppExecutor("package-manager")).toBe(false)
    expect(IN_APP_EXECUTORS).toContain("tauri")
  })

  it("never offers an in-app install for an executor Cognia does not drive", () => {
    for (const executor of UPDATE_EXECUTORS) {
      if (isInAppExecutor(executor)) continue
      expect(EXECUTOR_PRIMARY_ACTION[executor]).not.toBe("install-in-app")
    }
  })

  it("keys snapshots by kind and asset", () => {
    expect(updateSnapshotKey("plugin", "acme.tool")).toBe("plugin:acme.tool")
  })
})

describe("state machine", () => {
  it("declares transitions for every state", () => {
    for (const state of UPDATE_STATES) expect(UPDATE_STATE_TRANSITIONS[state]).toBeDefined()
  })

  it("only names known states as targets", () => {
    for (const [, targets] of Object.entries(UPDATE_STATE_TRANSITIONS)) {
      for (const target of targets) expect(UPDATE_STATES).toContain(target)
    }
  })

  it("treats a self-transition as legal", () => {
    expect(canTransitionUpdateState("available", "available")).toBe(true)
  })

  it("refuses to jump from current straight to installing", () => {
    expect(canTransitionUpdateState("current", "installing")).toBe(false)
  })

  it("lets a failed attempt be retried but not silently succeed", () => {
    expect(canTransitionUpdateState("failed", "installing")).toBe(true)
    expect(canTransitionUpdateState("failed", "verified")).toBe(false)
  })

  it("makes every state reachable from checking or available", () => {
    const reachable = new Set<UpdateState>(["checking"])
    let grew = true
    while (grew) {
      grew = false
      for (const state of [...reachable]) {
        for (const next of UPDATE_STATE_TRANSITIONS[state]) {
          if (!reachable.has(next)) {
            reachable.add(next)
            grew = true
          }
        }
      }
    }
    for (const state of UPDATE_STATES) expect([...reachable]).toContain(state)
  })
})
