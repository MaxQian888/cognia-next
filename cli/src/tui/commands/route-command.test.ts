import { routeCommand } from "./route-command"
import type { CommandContext } from "./types"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

const ctx = (over: Partial<ResolvedConfig>, args = ""): CommandContext =>
  ({
    state: {} as CommandContext["state"],
    config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/w", ...over } as ResolvedConfig,
    version: "test",
    args,
  }) as CommandContext

const autoSub = routeCommand.subcommands?.find((s) => s.name === "auto")

describe("/route", () => {
  it("reports OFF state on the bare command", () => {
    const eff = routeCommand.handler!(ctx({}))
    expect(eff.kind).toBe("notice")
    if (eff.kind === "notice") expect(eff.message).toMatch(/OFF/)
  })

  it("reports ON state when autoRoute is set", () => {
    const eff = routeCommand.handler!(ctx({ autoRoute: true }))
    if (eff.kind === "notice") expect(eff.message).toMatch(/ON/)
  })

  it("enables via `auto on`", () => {
    const eff = autoSub!.handler(ctx({}, "on"))
    expect(eff).toEqual({ kind: "flag", key: "autoRoute", value: true })
  })

  it("disables via `auto off`", () => {
    const eff = autoSub!.handler(ctx({ autoRoute: true }, "off"))
    expect(eff).toEqual({ kind: "flag", key: "autoRoute", value: false })
  })

  it("accepts enable/disable/true/false synonyms", () => {
    expect(autoSub!.handler(ctx({}, "enable"))).toEqual({
      kind: "flag",
      key: "autoRoute",
      value: true,
    })
    expect(autoSub!.handler(ctx({}, "false"))).toEqual({
      kind: "flag",
      key: "autoRoute",
      value: false,
    })
  })

  it("toggles relative to current state on a bare `auto`", () => {
    expect(autoSub!.handler(ctx({ autoRoute: true }, ""))).toEqual({
      kind: "flag",
      key: "autoRoute",
      value: false,
    })
    expect(autoSub!.handler(ctx({ autoRoute: false }, ""))).toEqual({
      kind: "flag",
      key: "autoRoute",
      value: true,
    })
  })

  it("rejects an unknown argument with usage", () => {
    const eff = autoSub!.handler(ctx({}, "maybe"))
    expect(eff.kind).toBe("notice")
    if (eff.kind === "notice") expect(eff.message).toMatch(/Usage/)
  })
})
