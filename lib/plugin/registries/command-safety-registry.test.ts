import {
  registerPluginCommandRules,
  unregisterPluginCommandRules,
  getPluginCommandRulesets,
  __resetCommandSafetyRegistry,
} from "./command-safety-registry"

afterEach(() => __resetCommandSafetyRegistry())

describe("command-safety-registry", () => {
  it("returns no rulesets when empty", () => {
    expect(getPluginCommandRulesets()).toEqual([])
  })

  it("exposes a plugin's rules as a Bash ruleset", () => {
    registerPluginCommandRules("p1", { "deploy*": "deny" })
    expect(getPluginCommandRulesets()).toEqual([{ Bash: { "deploy*": "deny" } }])
  })

  it("merges repeated registrations from the same plugin", () => {
    registerPluginCommandRules("p1", { "a*": "allow" })
    registerPluginCommandRules("p1", { "b*": "deny" })
    expect(getPluginCommandRulesets()).toEqual([{ Bash: { "a*": "allow", "b*": "deny" } }])
  })

  it("keeps each plugin's rules separate", () => {
    registerPluginCommandRules("p1", { "a*": "allow" })
    registerPluginCommandRules("p2", { "b*": "deny" })
    expect(getPluginCommandRulesets()).toHaveLength(2)
  })

  it("disposer drops the plugin's contribution", () => {
    const dispose = registerPluginCommandRules("p1", { "a*": "allow" })
    dispose()
    expect(getPluginCommandRulesets()).toEqual([])
  })

  it("unregisterPluginCommandRules removes by plugin id", () => {
    registerPluginCommandRules("p1", { "a*": "allow" })
    expect(unregisterPluginCommandRules("p1")).toBe(1)
    expect(getPluginCommandRulesets()).toEqual([])
  })
})
