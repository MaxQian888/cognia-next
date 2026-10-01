import {
  ACCEPT_INVITE_PARAM,
  INVITE_ORG_PARAM,
  TARGETED_INVITE_ROUTE,
  readTargetedInviteLink,
  targetedInviteHref,
  withoutTargetedInviteParams,
} from "./targeted-invite-link"

describe("readTargetedInviteLink", () => {
  it("reads both halves", () => {
    const params = new URLSearchParams("acceptInvite=inv_1&org=org_1")
    expect(readTargetedInviteLink(params)).toEqual({ inviteId: "inv_1", orgId: "org_1" })
  })

  it("trims whitespace a pasted link can pick up", () => {
    const params = new URLSearchParams({ acceptInvite: " inv_1 ", org: " org_1 " })
    expect(readTargetedInviteLink(params)).toEqual({ inviteId: "inv_1", orgId: "org_1" })
  })

  it.each([
    ["no params", ""],
    ["an invite without its org", "acceptInvite=inv_1"],
    ["an org without an invite", "org=org_1"],
    ["blank halves", "acceptInvite=%20&org=org_1"],
  ])("is not a link with %s", (_label, query) => {
    expect(readTargetedInviteLink(new URLSearchParams(query))).toBeNull()
  })

  it("tolerates absent params during prerender", () => {
    expect(readTargetedInviteLink(null)).toBeNull()
    expect(readTargetedInviteLink(undefined)).toBeNull()
  })
})

describe("targetedInviteHref", () => {
  it("points at the route that renders conversations", () => {
    expect(TARGETED_INVITE_ROUTE).toBe("/")
    expect(targetedInviteHref({ inviteId: "inv_1", orgId: "org_1" })).toBe(
      `/?${ACCEPT_INVITE_PARAM}=inv_1&${INVITE_ORG_PARAM}=org_1`
    )
  })

  it("escapes ids and round-trips through the reader", () => {
    const link = { inviteId: "inv / 1&x", orgId: "org=1" }
    const href = targetedInviteHref(link)
    expect(readTargetedInviteLink(new URL(href, "https://app.test").searchParams)).toEqual(link)
  })
})

describe("withoutTargetedInviteParams", () => {
  it("drops to the bare path when the link was the only query", () => {
    expect(withoutTargetedInviteParams("/", new URLSearchParams("acceptInvite=a&org=b"))).toBe("/")
  })

  it("keeps every other param", () => {
    expect(
      withoutTargetedInviteParams(
        "/",
        new URLSearchParams("session=s1&acceptInvite=a&org=b&message=m1")
      )
    ).toBe("/?session=s1&message=m1")
  })

  it("handles absent params", () => {
    expect(withoutTargetedInviteParams("/", null)).toBe("/")
  })
})
