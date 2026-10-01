import { planCogsetActivation, type InstalledPluginView } from "./plan"

function plugin(
  id: string,
  overrides: Partial<InstalledPluginView> & { deps?: Record<string, string> } = {}
): InstalledPluginView {
  const { deps, ...rest } = overrides
  return {
    id,
    version: "1.0.0",
    enabled: false,
    manifest: { id, ...(deps ? { dependencies: deps } : {}) },
    ...rest,
  }
}

const notBlocked = () => false

describe("planCogsetActivation", () => {
  it("enables members and always-on, disables everything else, keeps what already runs", () => {
    const plan = planCogsetActivation({
      members: [{ pluginId: "pdf" }, { pluginId: "office" }],
      alwaysOn: ["web-tools"],
      installed: [
        plugin("pdf", { enabled: true }),
        plugin("office"),
        plugin("web-tools", { enabled: true }),
        plugin("games", { enabled: true }),
        plugin("idle"),
      ],
      isBlocked: notBlocked,
    })
    expect(new Set(plan.target)).toEqual(new Set(["pdf", "office", "web-tools"]))
    expect(plan.enable).toEqual(["office"])
    expect(plan.disable).toEqual(["games"])
    expect(plan.problems).toEqual([])
  })

  it("pulls in required dependencies, enables them first and disables dependents first", () => {
    const plan = planCogsetActivation({
      members: [{ pluginId: "writer" }],
      alwaysOn: [],
      installed: [
        plugin("writer", { deps: { documents: "^1.0.0" } }),
        plugin("documents", { deps: { core: "^1.0.0" } }),
        plugin("core"),
        plugin("app", { enabled: true, deps: { lib: "^1.0.0" } }),
        plugin("lib", { enabled: true }),
      ],
      isBlocked: notBlocked,
    })
    expect(plan.enable).toEqual(["core", "documents", "writer"])
    expect(plan.addedDependencies.sort()).toEqual(["core", "documents"])
    expect(plan.disable).toEqual(["app", "lib"])
  })

  it("reports members that are not installed, respecting optional and always-on", () => {
    const plan = planCogsetActivation({
      members: [{ pluginId: "gone" }, { pluginId: "maybe", optional: true }],
      alwaysOn: ["also-gone"],
      installed: [],
      isBlocked: notBlocked,
    })
    expect(plan.problems).toEqual([
      { pluginId: "gone", action: "enable", ok: false, reason: "not-installed", optional: false },
      { pluginId: "maybe", action: "enable", ok: false, reason: "not-installed", optional: true },
      {
        pluginId: "also-gone",
        action: "enable",
        ok: false,
        reason: "not-installed",
        optional: true,
      },
    ])
  })

  it("blocks a member this host cannot run and its dependents with it", () => {
    const plan = planCogsetActivation({
      members: [{ pluginId: "desktop-only" }, { pluginId: "needs-it" }],
      alwaysOn: [],
      installed: [plugin("desktop-only"), plugin("needs-it", { deps: { "desktop-only": "*" } })],
      isBlocked: (p) => p.id === "desktop-only",
    })
    expect(plan.target).toEqual([])
    expect(plan.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: "desktop-only", reason: "blocked", optional: false }),
        expect.objectContaining({
          pluginId: "needs-it",
          reason: "dependency-missing",
          dependencyId: "desktop-only",
        }),
      ])
    )
  })

  it("reports a missing dependency and a version it cannot satisfy", () => {
    const plan = planCogsetActivation({
      members: [{ pluginId: "a" }, { pluginId: "b" }],
      alwaysOn: [],
      installed: [
        plugin("a", { deps: { nowhere: "^1.0.0" } }),
        plugin("b", { deps: { old: "^2.0.0" } }),
        plugin("old", { version: "1.4.0" }),
      ],
      isBlocked: notBlocked,
    })
    const byId = Object.fromEntries(plan.problems.map((p) => [p.pluginId, p]))
    expect(byId.a).toMatchObject({
      reason: "dependency-missing",
      dependencyId: "nowhere",
      dependencyConstraint: "^1.0.0",
    })
    expect(byId.b).toMatchObject({
      reason: "dependency-version",
      dependencyId: "old",
      dependencyConstraint: "^2.0.0",
      dependencyFound: "1.4.0",
    })
    // Structured fields only: the UI translates them.
    expect(plan.problems.every((problem) => problem.message === undefined)).toBe(true)
    expect(plan.target).toEqual(["old"])
  })

  it("reports a version mismatch but still runs the installed version", () => {
    const plan = planCogsetActivation({
      members: [{ pluginId: "pdf", expectedVersion: "2.0.0" }],
      alwaysOn: [],
      installed: [plugin("pdf", { version: "1.5.0" })],
      isBlocked: notBlocked,
    })
    expect(plan.enable).toEqual(["pdf"])
    expect(plan.problems).toEqual([
      {
        pluginId: "pdf",
        action: "enable",
        ok: false,
        reason: "version-mismatch",
        expectedVersion: "2.0.0",
        installedVersion: "1.5.0",
        optional: false,
      },
    ])
  })

  it("applies member config while keeping the plugin's own secrets, and skips unchanged config", () => {
    const manifest = {
      id: "gh",
      configSchema: { type: "object", properties: { token: { type: "string", secret: true } } },
    }
    const plan = planCogsetActivation({
      members: [
        { pluginId: "gh", config: { org: "acme", token: "from-cogset" } },
        { pluginId: "same", config: { a: 1 } },
      ],
      alwaysOn: [],
      installed: [
        { ...plugin("gh"), manifest, config: { org: "old", token: "mine" } },
        plugin("same", { config: { a: 1 } }),
      ],
      isBlocked: notBlocked,
    })
    expect(plan.configChanges).toEqual([{ pluginId: "gh", config: { org: "acme", token: "mine" } }])
  })

  it("reports dependency cycles", () => {
    const plan = planCogsetActivation({
      members: [{ pluginId: "x" }, { pluginId: "y" }],
      alwaysOn: [],
      installed: [plugin("x", { deps: { y: "*" } }), plugin("y", { deps: { x: "*" } })],
      isBlocked: notBlocked,
    })
    expect(plan.target).toEqual([])
    expect(plan.problems).toEqual([
      expect.objectContaining({ pluginId: "x", reason: "dependency-cycle", cycle: ["x", "y"] }),
      expect.objectContaining({ pluginId: "y", reason: "dependency-cycle", cycle: ["x", "y"] }),
    ])
    expect(plan.problems.every((problem) => problem.dependencyId === undefined)).toBe(true)
  })

  it("reports every unmet dependency of one plugin", () => {
    const plan = planCogsetActivation({
      members: [{ pluginId: "a" }],
      alwaysOn: [],
      installed: [plugin("a", { deps: { one: "^1.0.0", two: "*" } })],
      isBlocked: notBlocked,
    })
    expect(plan.problems.map((p) => [p.reason, p.dependencyId])).toEqual([
      ["dependency-missing", "one"],
      ["dependency-missing", "two"],
    ])
  })
})
