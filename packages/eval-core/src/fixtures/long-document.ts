import type { EvalCase } from "../domain/eval"

export interface LongDocumentFixture {
  id: string
  filename: string
  originalText: string
  cases: Array<{ evalCase: EvalCase; sectionTitle: string; answer: string | null }>
}

/** Synthetic, checked-in facts; this fixture never needs credentials or a model. */
export function createLongDocumentFixture(
  options: {
    revision?: 1 | 2
    backgroundSections?: number
  } = {}
): LongDocumentFixture {
  const revision = options.revision ?? 1
  const backgroundSections = options.backgroundSections ?? 48
  if (
    !Number.isSafeInteger(backgroundSections) ||
    backgroundSections < 1 ||
    backgroundSections > 500
  ) {
    throw new RangeError("backgroundSections must be an integer between 1 and 500")
  }
  if (revision !== 1 && revision !== 2) throw new RangeError("revision must be 1 or 2")
  const delay = revision === 1 ? 47 : 61
  const owner = revision === 1 ? "Cedar operations" : "Birch operations"
  const background = Array.from(
    { length: backgroundSections },
    (_, index) =>
      `## Routine ${index + 1}\n\n` +
      Array.from(
        { length: 8 },
        (_, paragraph) =>
          `Routine ${index + 1} checkpoint ${paragraph + 1} records equipment inventory, review attendance, and ordinary maintenance. ` +
          "These records describe routine operations and contain no emergency recovery configuration."
      ).join("\n\n")
  ).join("\n\n")
  const codeFact = `recovery_delay_seconds = ${delay}`
  const proseFact = `The recovery approval owner is ${owner}.`
  const originalText =
    [
      "---\ntitle: Long operations handbook\nrevision: " + revision + "\n---",
      "# Operations handbook",
      background,
      "## Emergency recovery",
      "This section contains the authoritative recovery procedure.",
      "### Recovery configuration",
      "Read the configuration itself before choosing a recovery delay.",
      "```ini\n" + codeFact + "\n```",
      "### Recovery approval",
      proseFact,
      "## Appendix",
      "No lunar deployment policy is defined by this handbook.",
    ].join("\n\n") + "\n"
  const definition = (id: string, input: string, expectedContext: string[]): EvalCase => ({
    id,
    datasetId: "structured-reading-long-document-v1",
    input,
    capability: "chat.rag",
    source: "handwritten",
    reference: { expectedContext },
    createdAt: 0,
    updatedAt: 0,
    metadata: { fixtureRevision: revision, synthetic: true },
  })
  return {
    id: "operations-handbook",
    filename: "operations-handbook.md",
    originalText,
    cases: [
      {
        evalCase: definition("code-configuration", "What is the recovery delay in seconds?", [
          codeFact,
        ]),
        sectionTitle: "Recovery configuration",
        answer: codeFact,
      },
      {
        evalCase: definition("prose-approval", "Who is the recovery approval owner?", [proseFact]),
        sectionTitle: "Recovery approval",
        answer: proseFact,
      },
      {
        evalCase: definition("unsupported-policy", "Who approves lunar deployment?", []),
        sectionTitle: "Appendix",
        answer: null,
      },
    ],
  }
}
