/**
 * Browser E2E: durable Eval dataset authoring contract.
 *
 * Model-backed evaluation execution belongs to the configured runtime suite.
 * This browser-owned journey covers the portable product boundary instead:
 * dataset and case authoring, reference metadata, version advancement, quality
 * gate persistence, and full-document restoration from the real Dexie tables.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { ensureCogniaAccount, readDexieRows } from "../helpers/db-reset"

const DATASET_NAME = "E2E Tool Reliability"
const CAPABILITY = "chat.tool-use"
const CASE_INPUT = "Inspect the release and report its blocking checks."

interface PersistedEvalDataset {
  id: string
  name: string
  capability: string
  version: number
  gate?: {
    minPassAt1?: number
    maxTotalCostUsd?: number
  }
}

interface PersistedEvalCase {
  id: string
  datasetId: string
  input: string
  capability: string
  split?: string
  tags?: string[]
  notes?: string
  reference?: {
    expectedOutput?: string
    expectedTools?: string[]
    expectedContains?: string[]
  }
}

test.describe("eval — durable dataset authoring", () => {
  test("creates a versioned dataset, case, and gate and restores them", async ({ page }) => {
    // A fresh Playwright context already provides storage isolation. Bootstrap
    // only AccountGate so this Eval contract does not depend on the broad E2E
    // bridge or unrelated dynamic plugin-table readiness.
    await page.goto("/eval")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/eval", { waitUntil: "domcontentloaded" })

    await expect(page.getByRole("heading", { name: "Agent Evaluation" })).toBeVisible()
    await page.getByRole("button", { name: "New dataset" }).click()

    const newDataset = page.getByTestId("new-dataset-form")
    await newDataset.getByRole("textbox", { name: "Dataset name" }).fill(DATASET_NAME)
    await newDataset
      .getByRole("textbox", { name: "Capability (e.g. chat.tool-use)" })
      .fill(CAPABILITY)
    await newDataset.getByRole("button", { name: "Create" }).click()

    const detail = page.getByTestId("dataset-detail")
    await expect(detail.getByRole("heading", { name: DATASET_NAME })).toBeVisible()
    await expect(detail).toContainText("v1")

    const caseList = page.getByTestId("case-list")
    await caseList.getByRole("button", { name: "Add case" }).click()
    const editor = page.getByTestId("case-editor")
    await editor.getByRole("textbox", { name: "Input prompt" }).fill(CASE_INPUT)
    await editor.getByRole("textbox", { name: "Split" }).fill("regression")
    await editor.getByRole("textbox", { name: "Tags (comma-separated)" }).fill("release, tools")
    await editor.getByText("Reference (expected)", { exact: true }).click()
    await editor
      .getByRole("textbox", { name: "Expected output" })
      .fill("All blocking checks are reported.")
    await editor
      .getByRole("textbox", { name: "Expected tools (comma-separated)" })
      .fill("release_evidence_lookup, check_status")
    await editor
      .getByRole("textbox", { name: "Must contain (one per line)" })
      .fill("blocking\nchecks")
    await editor.getByRole("textbox", { name: "Notes" }).fill("Release gate regression case")
    await editor.getByRole("button", { name: "Save case" }).click()

    await expect(editor).toHaveCount(0)
    await expect(caseList.getByRole("paragraph").filter({ hasText: CASE_INPUT })).toBeVisible()
    await expect(detail).toContainText("v2")

    await detail.getByRole("button", { name: "Gate", exact: true }).click()
    const gateDialog = page.getByRole("dialog")
    await gateDialog.getByRole("spinbutton", { name: "Min pass@1" }).fill("0.8")
    await gateDialog.getByRole("spinbutton", { name: "Max total cost (USD)" }).fill("2.5")
    await gateDialog.getByRole("button", { name: "Save gate" }).click()
    await expect(gateDialog.getByRole("status")).toHaveText("Gate saved")
    await page.keyboard.press("Escape")
    await expect(detail.getByText("Gated", { exact: true })).toBeVisible()

    await expect
      .poll(async () => {
        const datasets = await readDexieRows<PersistedEvalDataset>(page, {
          table: "evalDatasets",
        })
        const cases = await readDexieRows<PersistedEvalCase>(page, { table: "evalCases" })
        return { datasets, cases }
      })
      .toMatchObject({
        datasets: [
          {
            name: DATASET_NAME,
            capability: CAPABILITY,
            version: 2,
            gate: { minPassAt1: 0.8, maxTotalCostUsd: 2.5 },
          },
        ],
        cases: [
          {
            input: CASE_INPUT,
            capability: CAPABILITY,
            split: "regression",
            tags: ["release", "tools"],
            notes: "Release gate regression case",
            reference: {
              expectedOutput: "All blocking checks are reported.",
              expectedTools: ["release_evidence_lookup", "check_status"],
              expectedContains: ["blocking", "checks"],
            },
          },
        ],
      })

    await page.reload({ waitUntil: "domcontentloaded" })
    const restoredDetail = page.getByTestId("dataset-detail")
    await expect(restoredDetail.getByRole("heading", { name: DATASET_NAME })).toBeVisible()
    await expect(restoredDetail).toContainText("v2")
    await expect(restoredDetail.getByText("Gated", { exact: true })).toBeVisible()
    await expect(
      page.getByTestId("case-list").getByRole("paragraph").filter({ hasText: CASE_INPUT })
    ).toBeVisible()
  })
})
