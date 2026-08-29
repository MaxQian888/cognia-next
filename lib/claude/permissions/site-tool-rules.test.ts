import { buildSiteToolRuleset } from "./site-tool-rules"

const NAMESPACED = "mcp__cognia-plugin-tools__"

it("always asks before publishing to the public internet", () => {
  // `takeDown` removes the Site; it does not restore the previous version.
  const rules = buildSiteToolRuleset()
  expect(rules.deploy_site).toBe("ask")
  expect(rules[`${NAMESPACED}deploy_site`]).toBe("ask")
})

it("allows building, which produces an immutable local version and publishes nothing", () => {
  // The console's own gate for a build is `edit`, not `deploy`. Prompting for it
  // would train the user to approve everything, which is how the deploy prompt
  // loses its meaning.
  const rules = buildSiteToolRuleset()
  expect(rules.build_site).toBe("allow")
  expect(rules.list_sites).toBe("allow")
})

it("keys every tool twice, because the two provider paths disagree", () => {
  // The Anthropic path sees the bare name and the AI-SDK path the namespaced
  // one, and `resolveToolVerdict` matches exactly with no prefix stripping —
  // keying one form applies the tier on one provider only.
  const rules = buildSiteToolRuleset()
  for (const tool of ["list_sites", "build_site", "deploy_site"]) {
    expect(rules[tool]).toBeDefined()
    expect(rules[`${NAMESPACED}${tool}`]).toBe(rules[tool])
  }
})

it("covers every Sites tool and nothing else", () => {
  const bare = Object.keys(buildSiteToolRuleset()).filter((key) => !key.startsWith(NAMESPACED))
  expect(bare.sort()).toEqual(["build_site", "deploy_site", "list_sites"])
})
