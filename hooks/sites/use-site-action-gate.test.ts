import { renderHook } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))

import { usePlatform } from "@/hooks/use-platform"
import type { SiteProjectRow } from "@/types/sites"
import { resolveSiteGate, useSiteActionGate } from "./use-site-action-gate"

const usePlatformMock = usePlatform as jest.Mock

function site(overrides: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "account", workerName: "docs" },
    authoringPolicy: {
      ownerAccountId: "owner",
      editorAccountIds: ["editor"],
      deployerAccountIds: ["deployer"],
    },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  usePlatformMock.mockReturnValue("tauri")
})

describe("resolveSiteGate — host", () => {
  it.each(["provider", "build", "preview", "filesystem"] as const)(
    "blocks %s outside the desktop shell",
    (capability) => {
      for (const platform of ["web", "mobile"] as const) {
        expect(
          resolveSiteGate({ platform, site: site(), actorAccountId: "owner", capability })
        ).toEqual({ allowed: false, reason: "requires-desktop" })
      }
    }
  )

  it("allows Dexie-only metadata work in every shell", () => {
    for (const platform of ["web", "mobile", "tauri"] as const) {
      expect(
        resolveSiteGate({ platform, site: site(), actorAccountId: "owner", capability: "metadata" })
      ).toEqual({ allowed: true, reason: "ok" })
    }
  })

  it("applies only the host check when no Site is selected", () => {
    expect(
      resolveSiteGate({
        platform: "tauri",
        site: null,
        actorAccountId: "x",
        capability: "provider",
      })
    ).toEqual({ allowed: true, reason: "ok" })
    expect(
      resolveSiteGate({ platform: "web", site: null, actorAccountId: "x", capability: "provider" })
    ).toEqual({ allowed: false, reason: "requires-desktop" })
  })
})

describe("resolveSiteGate — authoring policy", () => {
  it("names the role each denied capability needs", () => {
    const cases = [
      ["manage", "stranger", "requires-owner"],
      ["edit", "deployer", "requires-editor"],
      ["deploy", "editor", "requires-deployer"],
      ["view", "stranger", "requires-access"],
    ] as const
    for (const [authoring, actorAccountId, reason] of cases) {
      expect(
        resolveSiteGate({
          platform: "tauri",
          site: site(),
          actorAccountId,
          capability: "provider",
          authoring,
        })
      ).toEqual({ allowed: false, reason })
    }
  })

  it("lets the owner through every capability", () => {
    for (const authoring of ["view", "edit", "deploy", "manage"] as const) {
      expect(
        resolveSiteGate({
          platform: "tauri",
          site: site(),
          actorAccountId: "owner",
          capability: "provider",
          authoring,
        }).allowed
      ).toBe(true)
    }
  })

  it("skips the policy check when the caller names no capability", () => {
    expect(
      resolveSiteGate({
        platform: "tauri",
        site: site(),
        actorAccountId: "stranger",
        capability: "provider",
      })
    ).toEqual({ allowed: true, reason: "ok" })
  })
})

describe("resolveSiteGate — lifecycle", () => {
  it("locks everything while a Site is being deleted", () => {
    expect(
      resolveSiteGate({
        platform: "tauri",
        site: site({ lifecycle: "deleting" }),
        actorAccountId: "owner",
        capability: "metadata",
      })
    ).toEqual({ allowed: false, reason: "lifecycle-locked" })
  })

  it("leaves metadata cleanup available on a deleted Site but nothing else", () => {
    const deleted = site({ lifecycle: "deleted" })
    expect(
      resolveSiteGate({
        platform: "tauri",
        site: deleted,
        actorAccountId: "owner",
        capability: "metadata",
      }).allowed
    ).toBe(true)
    expect(
      resolveSiteGate({
        platform: "tauri",
        site: deleted,
        actorAccountId: "owner",
        capability: "provider",
      })
    ).toEqual({ allowed: false, reason: "lifecycle-locked" })
  })

  it("reports the host before the lifecycle so the fixable answer comes first", () => {
    expect(
      resolveSiteGate({
        platform: "web",
        site: site({ lifecycle: "deleting" }),
        actorAccountId: "owner",
        capability: "provider",
      }).reason
    ).toBe("requires-desktop")
  })
})

describe("useSiteActionGate", () => {
  it("localizes the reason and leaves the title empty when allowed", () => {
    const { result } = renderHook(() => useSiteActionGate(site(), "owner"))
    expect(result.current("provider", "manage")).toEqual({
      allowed: true,
      reason: "ok",
      title: undefined,
    })
  })

  it("translates the denial reason for the control's tooltip", () => {
    usePlatformMock.mockReturnValue("web")
    const { result } = renderHook(() => useSiteActionGate(site(), "owner"))
    expect(result.current("build")).toEqual({
      allowed: false,
      reason: "requires-desktop",
      title: "t:host.reason.requires-desktop",
    })
  })
})
