import { assertSiteAuthoringCapability, canAuthorSite } from "./authoring-policy"

const policy = {
  ownerAccountId: "owner",
  editorAccountIds: ["editor"],
  deployerAccountIds: ["deployer"],
}

it("keeps authoring, deployment, and owner management roles separate", () => {
  expect(canAuthorSite(policy, "owner", "manage")).toBe(true)
  expect(canAuthorSite(policy, "editor", "edit")).toBe(true)
  expect(canAuthorSite(policy, "editor", "deploy")).toBe(false)
  expect(canAuthorSite(policy, "deployer", "deploy")).toBe(true)
  expect(canAuthorSite(policy, "deployer", "edit")).toBe(false)
})

it("fails closed for unknown accounts", () => {
  expect(() => assertSiteAuthoringCapability(policy, "unknown", "edit")).toThrow("denies")
})
