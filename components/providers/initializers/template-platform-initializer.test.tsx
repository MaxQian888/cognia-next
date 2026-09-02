import { render, waitFor } from "@testing-library/react"

// The rest parameter is load-bearing: `jest.fn(async () => …)` infers a 0-arg
// tuple, and the `boot(...args)` spread in the `migrateLegacyTemplates` mock
// below then fails to typecheck (TS2556).
const boot = jest.fn(async (..._args: unknown[]) => undefined)
const mockBackfill = jest.fn(async (_projectId: string) => 0)
const mockResolveScopeProjectId = jest.fn(async () => "ws_default")
let account: { unlockedAccountId: string | null; accountRevision: number } = {
  unlockedAccountId: "account-1",
  accountRevision: 1,
}

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof account) => unknown) => selector(account),
}))
jest.mock("@/lib/templates/feature-flags", () => ({
  isUnifiedTemplatePlatformEnabled: () => true,
}))
jest.mock("@/lib/templates/catalog-only-adapters", () => ({
  refreshCatalogOnlyTemplateAdapters: jest.fn(async () => 0),
}))
jest.mock("@/lib/templates/builtin-overlays", () => ({
  refreshBuiltInTemplateOverlays: jest.fn(async () => 0),
}))
jest.mock("@/lib/templates/migration", () => ({
  migrateLegacyTemplates: (...args: unknown[]) => boot(...args),
}))
jest.mock("@/lib/templates/legacy-sources", () => ({
  createLegacyTemplateSources: () => [],
}))
jest.mock("@/lib/templates/runtime", () => ({
  createProductionTemplatePorts: () => ({}),
  getTemplateRuntime: () => ({
    service: { backfillInstanceWorkspaces: (id: string) => mockBackfill(id) },
    repository: {},
    catalog: {},
  }),
}))
// Real, this would read Dexie for the owner snapshot global search ranks on.
jest.mock("@/lib/global-search/providers/library", () => ({
  refreshTemplateOwners: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/project-scope", () => ({
  resolveScopeProjectId: () => mockResolveScopeProjectId(),
}))
jest.mock("@/lib/db/template-platform", () => ({
  listTemplateMigrationJournal: jest.fn(),
  putTemplateMigrationJournal: jest.fn(),
}))

import { TemplatePlatformInitializer } from "./template-platform-initializer"

describe("TemplatePlatformInitializer", () => {
  beforeEach(() => {
    boot.mockClear()
    mockBackfill.mockClear()
    mockResolveScopeProjectId.mockClear()
  })

  it("runs the migration only after an account is unlocked", async () => {
    const { rerender } = render(<TemplatePlatformInitializer />)
    await waitFor(() => expect(boot).toHaveBeenCalledTimes(1))

    rerender(<TemplatePlatformInitializer />)
    expect(boot).toHaveBeenCalledTimes(1)
  })

  /**
   * `backfillInstanceWorkspaces` existed with no caller, so every instance
   * written before `projectId` stayed invisible to the scoped Instances view —
   * which reads as data loss rather than as a filter. It is idempotent (it
   * skips any row that already has a workspace), so boot is the right place.
   */
  it("backfills pre-isolation instance workspaces once the account is unlocked", async () => {
    render(<TemplatePlatformInitializer />)
    await waitFor(() => expect(mockBackfill).toHaveBeenCalledTimes(1))
    expect(mockBackfill).toHaveBeenCalledWith("ws_default")
  })

  it("does not access account-scoped storage while locked", () => {
    account = { unlockedAccountId: null, accountRevision: 2 }
    render(<TemplatePlatformInitializer />)
    expect(boot).not.toHaveBeenCalled()
    account = { unlockedAccountId: "account-1", accountRevision: 1 }
  })
})
