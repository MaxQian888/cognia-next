import type { AddCaseInput } from "@/lib/db/eval-datasets"
import { bulkAddCases, createDataset, getDataset, listCases } from "@/lib/db/eval-datasets"

export const EVAL_STARTER_DATASET_ID = "eval-lab-starter-v1"

export interface EvalStarterTemplateLabels {
  name: string
  description: string
}

function starterCases(): AddCaseInput[] {
  return Array.from({ length: 30 }, (_, index) => {
    const number = index + 1
    const marker = `COGNIA-EVAL-${String(number).padStart(2, "0")}`
    return {
      id: `starter-${number}`,
      input: `Return exactly this verification marker and no other text: ${marker}`,
      source: "synthetic" as const,
      split: "test",
      tags: ["starter", "deterministic", number % 2 === 0 ? "even" : "odd"],
      reference: { expectedOutput: marker, grading: { mode: "exact" as const } },
      metadata: { templateVersion: 1, sequence: number },
    }
  })
}

export async function ensureEvalStarterDataset(
  labels: EvalStarterTemplateLabels
): Promise<NonNullable<Awaited<ReturnType<typeof getDataset>>>> {
  let dataset = await getDataset(EVAL_STARTER_DATASET_ID)
  if (!dataset) {
    dataset = await createDataset({
      id: EVAL_STARTER_DATASET_ID,
      name: labels.name,
      description: labels.description,
      capability: "chat.qa.deterministic",
    })
  }
  const existing = await listCases(dataset.id)
  if (existing.length < 30) {
    await bulkAddCases(dataset.id, starterCases(), { upsertBySourceId: true })
    dataset = (await getDataset(dataset.id)) ?? dataset
  }
  return dataset
}
