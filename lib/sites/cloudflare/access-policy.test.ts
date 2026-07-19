import { compileCloudflareAccessPolicy, cloudflareAccessPolicyMatches } from "./access-policy"

describe("compileCloudflareAccessPolicy", () => {
  it("fails closed for private Sites", () => {
    expect(compileCloudflareAccessPolicy({ mode: "private" })).toEqual({
      decision: "deny-all",
      applicationRequired: true,
      policies: [],
    })
  })

  it("compiles explicit identities and domains to allow rules", () => {
    expect(
      compileCloudflareAccessPolicy({
        mode: "identities",
        emails: ["B@example.com", "a@example.com", "a@example.com"],
      })
    ).toMatchObject({
      decision: "restricted",
      policies: [
        {
          name: "Cognia Sites restricted access",
          decision: "allow",
          include: [{ email: { email: "a@example.com" } }, { email: { email: "b@example.com" } }],
        },
      ],
    })
    expect(
      compileCloudflareAccessPolicy({ mode: "domains", domains: ["Example.COM", "team.dev"] })
        .policies[0].include
    ).toEqual([
      { email_domain: { domain: "example.com" } },
      { email_domain: { domain: "team.dev" } },
    ])
  })

  it("keeps public access outside Cloudflare Access instead of creating a bypass", () => {
    expect(compileCloudflareAccessPolicy({ mode: "public" })).toEqual({
      decision: "public",
      applicationRequired: false,
      policies: [],
    })
  })

  it("maps an explicitly supplied organization to a Cloudflare Access group", () => {
    expect(
      compileCloudflareAccessPolicy({ mode: "organization", organizationId: "group_1" }).policies[0]
        .include
    ).toEqual([{ group: { id: "group_1" } }])
    expect(() =>
      compileCloudflareAccessPolicy({ mode: "organization", organizationId: " " })
    ).toThrow("group id")
  })
})

describe("cloudflareAccessPolicyMatches", () => {
  it("detects provider drift independent of rule ordering and casing", () => {
    const desired = compileCloudflareAccessPolicy({
      mode: "identities",
      emails: ["a@example.com", "b@example.com"],
    })
    expect(
      cloudflareAccessPolicyMatches(desired, [
        {
          name: "Cognia Sites restricted access",
          decision: "allow",
          include: [{ email: { email: "B@EXAMPLE.COM" } }, { email: { email: "a@example.com" } }],
        },
      ])
    ).toBe(true)
    expect(
      cloudflareAccessPolicyMatches(desired, [
        {
          name: "Cognia Sites restricted access",
          decision: "allow",
          include: [{ everyone: {} }],
        },
      ])
    ).toBe(false)
  })
})
