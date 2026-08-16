/** E2E harness contract: account seeding waits for the registry schema. */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { ensureCogniaAccount } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

const ACCOUNT_ID = "acct_e2e_seed_account"

test("@smoke @critical account bootstrap persists the active unlocked account", async ({
  page,
}) => {
  await injectCapacitor(page, { platform: "android" })
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
  await expect(ensureCogniaAccount(page)).resolves.toBe(ACCOUNT_ID)
})
