import {
  ACCOUNT_BIND_PERSON_COMMAND,
  ACCOUNT_PERSON_COMMAND,
  ACCOUNT_UNBIND_PERSON_COMMAND,
  bindHostPerson,
  readHostPerson,
  unbindHostPerson,
} from "./host-person"

const desktop = () => true
const web = () => false

describe("off the desktop there is no host to tell", () => {
  it("no-ops without invoking anything, and says so", async () => {
    const invokeFn = jest.fn()
    expect(
      await bindHostPerson(
        { localAccountId: "acct_a", userId: "usr_ada" },
        { invokeFn, isDesktop: web }
      )
    ).toBe(false)
    expect(await unbindHostPerson("acct_a", { invokeFn, isDesktop: web })).toBe(false)
    expect(await readHostPerson("acct_a", { invokeFn, isDesktop: web })).toBeNull()
    expect(invokeFn).not.toHaveBeenCalled()
  })

  it("takes the same branch through the real platform check under Jest", async () => {
    // jsdom is not Tauri, so the production default must reach the no-op path —
    // otherwise this module only works in tests that stub it.
    const invokeFn = jest.fn()
    expect(
      await bindHostPerson({ localAccountId: "acct_a", userId: "usr_ada" }, { invokeFn })
    ).toBe(false)
    expect(invokeFn).not.toHaveBeenCalled()
  })
})

describe("on the desktop", () => {
  it("sends the account id under the name the Rust command expects", async () => {
    const invokeFn = jest.fn().mockResolvedValue(undefined)
    await bindHostPerson(
      { localAccountId: "acct_a", userId: "usr_ada", orgId: "org_acme" },
      { invokeFn, isDesktop: desktop }
    )
    expect(invokeFn).toHaveBeenCalledWith(ACCOUNT_BIND_PERSON_COMMAND, {
      localAccountId: "acct_a",
      userId: "usr_ada",
      orgId: "org_acme",
    })
  })

  it("sends an explicit null org rather than omitting the field", async () => {
    // `Option<String>` on the Rust side reads a missing key as an error in
    // some serde configurations; an explicit null is unambiguous either way.
    const invokeFn = jest.fn().mockResolvedValue(undefined)
    await bindHostPerson(
      { localAccountId: "acct_a", userId: "usr_ada" },
      { invokeFn, isDesktop: desktop }
    )
    expect(invokeFn).toHaveBeenCalledWith(ACCOUNT_BIND_PERSON_COMMAND, {
      localAccountId: "acct_a",
      userId: "usr_ada",
      orgId: null,
    })
  })

  it("unbinds and reads back", async () => {
    const invokeFn = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ localAccountNamespace: "acct_a", userId: "usr_ada", orgId: null })

    expect(await unbindHostPerson("acct_a", { invokeFn, isDesktop: desktop })).toBe(true)
    expect(invokeFn).toHaveBeenNthCalledWith(1, ACCOUNT_UNBIND_PERSON_COMMAND, {
      localAccountId: "acct_a",
    })

    expect(await readHostPerson("acct_a", { invokeFn, isDesktop: desktop })).toEqual({
      localAccountNamespace: "acct_a",
      userId: "usr_ada",
      orgId: null,
    })
    expect(invokeFn).toHaveBeenNthCalledWith(2, ACCOUNT_PERSON_COMMAND, {
      localAccountId: "acct_a",
    })
  })

  it("treats a host that recorded nothing as an answer, not a failure", async () => {
    const invokeFn = jest.fn().mockResolvedValue(null)
    expect(await readHostPerson("acct_a", { invokeFn, isDesktop: desktop })).toBeNull()
  })

  it("lets a real command failure surface instead of swallowing it", async () => {
    const invokeFn = jest.fn().mockRejectedValue(new Error("store is locked"))
    await expect(
      bindHostPerson(
        { localAccountId: "acct_a", userId: "usr_ada" },
        { invokeFn, isDesktop: desktop }
      )
    ).rejects.toThrow("store is locked")
  })
})
