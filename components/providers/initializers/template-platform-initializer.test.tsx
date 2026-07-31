import { render, waitFor } from "@testing-library/react"

// The rest parameter is load-bearing: `jest.fn(async () => …)` infers a 0-arg
// tuple, and the `boot(...args)` spread in the `migrateLegacyTemplates` mock
// below then fails to typecheck (TS2556).
const boot = jest.fn(async (..._args: unknown[]) => undefined)
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
  getTemplateRuntime: () => ({ service: {}, repository: {}, catalog: {} }),
}))
jest.mock("@/lib/db/template-platform", () => ({
  listTemplateMigrationJournal: jest.fn(),
  putTemplateMigrationJournal: jest.fn(),
}))

import { TemplatePlatformInitializer } from "./template-platform-initializer"

describe("TemplatePlatformInitializer", () => {
  beforeEach(() => boot.mockClear())

  it("runs the migration only after an account is unlocked", async () => {
    const { rerender } = render(<TemplatePlatformInitializer />)
    await waitFor(() => expect(boot).toHaveBeenCalledTimes(1))

    rerender(<TemplatePlatformInitializer />)
    expect(boot).toHaveBeenCalledTimes(1)
  })

  it("does not access account-scoped storage while locked", () => {
    account = { unlockedAccountId: null, accountRevision: 2 }
    render(<TemplatePlatformInitializer />)
    expect(boot).not.toHaveBeenCalled()
    account = { unlockedAccountId: "account-1", accountRevision: 1 }
  })
})
