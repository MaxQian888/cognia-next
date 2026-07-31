import { defineSkill } from "@cognia/plugin-sdk"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { workSkillId } from "./ids"

function inlineSkill(
  localId: string,
  name: string,
  description: string,
  body: string,
  allowedTools?: string[]
): PluginSkillDef {
  return defineSkill({
    id: workSkillId(localId),
    name,
    description,
    scope: "global",
    ...(allowedTools ? { allowedTools } : {}),
    source: {
      kind: "inline",
      markdown: `---\nname: ${localId}\ndescription: ${description}\n---\n\n# ${name}\n\n${body.trim()}\n`,
    },
  })
}

const SOURCE_GROUNDED_RESEARCH = inlineSkill(
  "source-grounded-research",
  "Source-grounded research",
  "Investigate a question against primary sources and preserve evidence quality.",
  `1. Turn the requested outcome into explicit research questions and a source plan.
2. Prefer the authority that owns the claim: official documentation, filings, standards, source code, datasets, or first-party announcements.
3. Record publication date, event date, access date, and any version or jurisdiction that changes the claim.
4. Cross-check consequential claims. Mark inference separately from reported fact.
5. Cite the exact page that supports each claim; never cite a search-results page.
6. End with evidence gaps, conflicting sources, and what would change the conclusion.`,
  ["WebSearch", "WebFetch", "Read", "Grep", "Glob"]
)

const DOCUMENT_DELIVERABLE = inlineSkill(
  "document-deliverable",
  "Document deliverable",
  "Create decision-ready briefs, reports, memos, and structured documents.",
  `Start from audience, decision, required sections, source rules, tone, length, and review criteria.

- Lead with the conclusion or requested outcome.
- Give every section one job; remove repeated setup and unsupported filler.
- Use tables only when they make exact comparison easier.
- Keep factual claims source-linked and recommendations traceable to evidence.
- Separate appendices and detailed methodology from the main decision path.
- Before delivery, check completeness, internal consistency, citations, names/dates/numbers, and whether the requested decision can be made from the document alone.`
)

const SPREADSHEET_DELIVERABLE = inlineSkill(
  "spreadsheet-deliverable",
  "Spreadsheet deliverable",
  "Create auditable tables, calculations, and spreadsheet-ready outputs.",
  `Define the grain of each row and the meaning, type, unit, and source of every column before calculating.

- Keep raw inputs, transformations, calculations, and summary outputs conceptually separate.
- Never hide assumptions inside formulas; label units, currencies, dates, and scenarios.
- Check totals, denominator choices, missing values, duplicates, outliers, and sign conventions.
- Use formulas that are explainable and stable when rows are added.
- For a Cognia artifact, emit clean CSV-compatible content unless the user requested an interactive HTML table.
- Include a compact data dictionary and validation notes with the delivery.`
)

const PRESENTATION_DELIVERABLE = inlineSkill(
  "presentation-deliverable",
  "Presentation deliverable",
  "Create concise presentations and shareable HTML sites with a clear narrative.",
  `Build the narrative before styling: audience → tension → evidence → decision → next action.

- One main idea per slide or section; titles should state the takeaway, not the topic.
- Prefer visual evidence and short labels over paragraphs.
- Keep typography, spacing, color, and source treatment consistent.
- Make the artifact responsive and accessible when delivering HTML.
- Include speaker notes or an appendix for detail that would overload the main view.
- Review the complete sequence at presentation size, checking overflow, contrast, data labels, source links, and the final call to action.`
)

const DELIVERABLE_QA = inlineSkill(
  "deliverable-qa",
  "Deliverable QA",
  "Review a work product against explicit criteria before handoff.",
  `Review independently from the authoring pass.

1. Restate the requested outcome, audience, constraints, and review criteria.
2. Check correctness: sources, calculations, dates, names, units, and unsupported assertions.
3. Check completeness: every requested section/output and every acceptance criterion.
4. Check usability: structure, scanability, accessibility, file format, and whether the next action is obvious.
5. Classify findings as blocking, important, or optional. Give a concrete fix for each.
6. End with PASS, PASS WITH CAVEATS, or REVISE. Never approve solely because the artifact rendered successfully.`
)

export const WORK_SKILLS: PluginSkillDef[] = [
  SOURCE_GROUNDED_RESEARCH,
  DOCUMENT_DELIVERABLE,
  SPREADSHEET_DELIVERABLE,
  PRESENTATION_DELIVERABLE,
  DELIVERABLE_QA,
]
