/** @jest-environment node */
/**
 * Tests for the confirmed self-identity writer.
 *
 * The sibling-bot guard reads two things from here, and gets them badly wrong
 * if either lies: whether an identity exists at all, and whether the platform
 * is one that would have written one at startup. Both are pinned below.
 */

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  updateAdapterInstance: jest.fn(async () => undefined),
}))

import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import {
  buildSelfIdentity,
  confirmSelfIdentityOnStart,
  hasIdentityProbe,
  recordSelfIdentity,
} from "./self-identity"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const mockGet = getAdapterInstance as jest.MockedFunction<typeof getAdapterInstance>
const mockUpdate = updateAdapterInstance as jest.MockedFunction<typeof updateAdapterInstance>

beforeEach(() => {
  jest.clearAllMocks()
  mockGet.mockResolvedValue(undefined)
})

describe("buildSelfIdentity", () => {
  it("stamps the source and confirmation time", () => {
    const identity = buildSelfIdentity(
      { platformAccountId: "U123", platformBotId: "B456", source: "startup_probe" },
      () => 1_700_000
    )
    expect(identity).toEqual({
      platformAccountId: "U123",
      platformBotId: "B456",
      source: "startup_probe",
      confirmedAt: 1_700_000,
    })
  })

  it("returns undefined rather than an identity with an empty account id", () => {
    // An empty id would match nothing while still claiming the identity is
    // confirmed — which is exactly the silent fail-open this replaces.
    expect(buildSelfIdentity({ platformAccountId: "", source: "whoami" })).toBeUndefined()
    expect(buildSelfIdentity({ platformAccountId: "   ", source: "whoami" })).toBeUndefined()
  })

  it("omits an empty bot id instead of storing a blank one", () => {
    const identity = buildSelfIdentity({
      platformAccountId: "U1",
      platformBotId: "  ",
      source: "whoami",
    })
    expect(identity).not.toHaveProperty("platformBotId")
  })
})

describe("recordSelfIdentity", () => {
  it("writes a newly confirmed identity", async () => {
    const written = await recordSelfIdentity(
      "tg-1",
      { platformAccountId: "42", source: "gateway_ready" },
      () => 5
    )
    expect(written).toMatchObject({ platformAccountId: "42", source: "gateway_ready" })
    expect(mockUpdate).toHaveBeenCalledWith("tg-1", {
      selfIdentity: { platformAccountId: "42", source: "gateway_ready", confirmedAt: 5 },
    })
  })

  it("does not rewrite the row when the identity is unchanged", async () => {
    // Reconnects re-confirm constantly; only the timestamp would move, and
    // nothing reads it as a liveness signal.
    mockGet.mockResolvedValue({
      id: "tg-1",
      selfIdentity: { platformAccountId: "42", source: "whoami", confirmedAt: 1 },
    } as AdapterInstanceRow)

    const result = await recordSelfIdentity("tg-1", {
      platformAccountId: "42",
      source: "startup_probe",
    })
    expect(result).toMatchObject({ confirmedAt: 1 })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("writes when the account id actually changed", async () => {
    mockGet.mockResolvedValue({
      id: "tg-1",
      selfIdentity: { platformAccountId: "old", source: "whoami", confirmedAt: 1 },
    } as AdapterInstanceRow)

    await recordSelfIdentity("tg-1", { platformAccountId: "new", source: "whoami" })
    expect(mockUpdate).toHaveBeenCalled()
  })

  it("swallows a write failure rather than failing the caller", async () => {
    // Callers are adapter starts and whoami clicks; neither may be taken down
    // by a diagnostic write. Failing leaves the guard closed, which is safe.
    mockUpdate.mockRejectedValueOnce(new Error("dexie down"))
    await expect(
      recordSelfIdentity("tg-1", { platformAccountId: "42", source: "whoami" })
    ).resolves.toBeUndefined()
  })

  it("writes nothing when there is no usable account id", async () => {
    expect(
      await recordSelfIdentity("tg-1", { platformAccountId: "", source: "whoami" })
    ).toBeUndefined()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe("hasIdentityProbe", () => {
  it("reports the platforms that confirm themselves at startup", () => {
    for (const type of ["telegram", "discord", "slack", "matrix", "qq-official", "lark"]) {
      expect(hasIdentityProbe(type)).toBe(true)
    }
  })

  it("reports the platforms that do not", () => {
    // These are the ones the sibling guard must fail closed on, because a
    // missing identity there does NOT imply the instance never started.
    for (const type of ["wecom", "dingtalk", "onebot", "wechat-oa", "wechat-personal"]) {
      expect(hasIdentityProbe(type)).toBe(false)
    }
  })

  it("agrees with what confirmSelfIdentityOnStart will actually attempt", () => {
    // If these two drifted, the guard would conclude "never started" for a
    // platform that in fact has no probe at all — the exact fail-open it exists
    // to prevent.
    expect(hasIdentityProbe("wecom")).toBe(false)
    return expect(confirmSelfIdentityOnStart("wecom-1", "wecom")).resolves.toBeUndefined()
  })
})

describe("confirmSelfIdentityOnStart", () => {
  it("returns undefined for a platform with no probe, without touching Dexie", async () => {
    expect(await confirmSelfIdentityOnStart("dt-1", "dingtalk")).toBeUndefined()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("never throws when the probe fails", async () => {
    // No keyring / no network in this environment, so the real Telegram probe
    // rejects — the supervisor must still see a resolved promise.
    await expect(confirmSelfIdentityOnStart("tg-1", "telegram")).resolves.toBeUndefined()
  })
})
