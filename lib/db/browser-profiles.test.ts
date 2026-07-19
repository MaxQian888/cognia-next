/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import {
  createBrowserProfile,
  deleteBrowserProfile,
  grantBrowserDomain,
  listBrowserDomainGrants,
  listBrowserProfiles,
  normalizeBrowserGrantDomain,
  revokeBrowserDomain,
  selectBrowserProfile,
  touchBrowserProfile,
} from "./browser-profiles"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import { SYNC_HANDLER_TABLES } from "@/lib/sync/companion-sync"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().browserProfiles.clear()
  await getDb().browserDomainGrants.clear()
})

describe("browser profile metadata", () => {
  it("keeps profile and grant metadata out of companion sync", () => {
    expect(SYNC_HANDLER_TABLES).not.toContain("browserProfiles")
    expect(SYNC_HANDLER_TABLES).not.toContain("browserDomainGrants")
  })

  it("stores named profiles locally by workspace and updates last use", async () => {
    const profile = await createBrowserProfile("workspace-1", " QA Login ", 100)
    await touchBrowserProfile(profile.id, 200)
    expect(await listBrowserProfiles("workspace-1")).toEqual([
      expect.objectContaining({
        id: profile.id,
        name: "QA Login",
        lastUsedAt: 200,
        updatedAt: 200,
      }),
    ])
    expect(await listBrowserProfiles("workspace-2")).toEqual([])
    await deleteBrowserProfile(profile.id)
    expect(await listBrowserProfiles("workspace-1")).toEqual([])
  })

  it("selects at most one named profile per workspace and supports ephemeral mode", async () => {
    const first = await createBrowserProfile("workspace-1", "First", 100)
    const second = await createBrowserProfile("workspace-1", "Second", 110)
    await selectBrowserProfile("workspace-1", second.id, 200)
    expect(await listBrowserProfiles("workspace-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, selected: false }),
        expect.objectContaining({ id: second.id, selected: true, updatedAt: 200 }),
      ])
    )
    await selectBrowserProfile("workspace-1", null)
    expect((await listBrowserProfiles("workspace-1")).every((profile) => !profile.selected)).toBe(
      true
    )
  })
})

describe("browser domain grants", () => {
  it("normalizes, upserts, lists, and revokes public DNS grants", async () => {
    await grantBrowserDomain("workspace-1", "https://App.Example.com/login", 100)
    await grantBrowserDomain("workspace-1", "app.example.com", 200)
    expect(await listBrowserDomainGrants("workspace-1")).toEqual([
      {
        id: "workspace-1\u0000app.example.com",
        workspaceId: "workspace-1",
        domain: "app.example.com",
        createdAt: 100,
        updatedAt: 200,
      },
    ])
    await revokeBrowserDomain("workspace-1", "app.example.com")
    expect(await listBrowserDomainGrants("workspace-1")).toEqual([])
  })

  it.each(["localhost", "127.0.0.1", "[::1]"])("rejects non-public grant %s", (domain) => {
    expect(() => normalizeBrowserGrantDomain(domain)).toThrow(/public DNS/)
  })
})
/** @jest-environment jsdom */
import "fake-indexeddb/auto"
