// Fixture builders for Twin (Employee Digital Twin) stories. Spread `over` to
// vary a single field; every required column gets a realistic default so the
// row is valid both as a component prop and for `bulkPut` into the Dexie twin
// tables.
import type {
  Playbook,
  ProfileEntity,
  StyleSample,
  Twin,
  TwinDraft,
  TwinJob,
  TwinSource,
} from "@/types/twin"
import type { UnredactPlaceholder } from "@/lib/twin/distill/unredact-draft"

const BASE = 1_720_000_000_000

let twinSeq = 0
export function makeTwin(over: Partial<Twin> = {}): Twin {
  twinSeq += 1
  return {
    id: `twin-${twinSeq}`,
    name: `Twin ${twinSeq}`,
    color: "#6366f1",
    description: "Digital twin of a senior support engineer.",
    createdAt: BASE - 1_000_000,
    updatedAt: BASE,
    ...over,
  }
}

let entitySeq = 0
export function makeEntity(over: Partial<ProfileEntity> = {}): ProfileEntity {
  entitySeq += 1
  return {
    name: `Entity ${entitySeq}`,
    aliases: ["alias-a", "alias-b"],
    role: "person",
    relation: "Works on the platform team.",
    firstSeenChunkId: "chunk-1",
    pinned: false,
    ...over,
  }
}

let playbookSeq = 0
export function makePlaybook(over: Partial<Playbook> = {}): Playbook {
  playbookSeq += 1
  return {
    id: `playbook-${playbookSeq}`,
    title: `Playbook ${playbookSeq}`,
    trigger: "When a customer reports a P1 outage.",
    steps: [
      { order: 1, action: "Acknowledge within 5 minutes.", rationale: "Sets expectations." },
      { order: 2, action: "Open an incident channel." },
    ],
    examples: [{ sourceChunkIds: ["chunk-1"], outcome: "Resolved within SLA." }],
    confidence: 0.82,
    pinned: false,
    ...over,
  }
}

let sampleSeq = 0
export function makeStyleSample(over: Partial<StyleSample> = {}): StyleSample {
  sampleSeq += 1
  return {
    id: `sample-${sampleSeq}`,
    contextLabel: `Customer email ${sampleSeq}`,
    original: "Thanks for flagging this — I've escalated it and will update you within the hour.",
    summary: "Acknowledges issue, escalates, commits to a follow-up window.",
    sourceChunkId: "chunk-1",
    tone: ["professional", "concise"],
    addedAt: BASE - sampleSeq * 1000,
    addedBy: "distill",
    pinned: false,
    ...over,
  }
}

let sourceSeq = 0
export function makeTwinSource(over: Partial<TwinSource> = {}): TwinSource {
  sourceSeq += 1
  return {
    id: `source-${sourceSeq}`,
    twinId: "twin-1",
    kind: "document",
    format: "markdown",
    source: `/docs/document-${sourceSeq}.md`,
    title: `document-${sourceSeq}.md`,
    bytes: 4096,
    fingerprint: `sha256-${sourceSeq}`,
    chunkCount: 12,
    status: "parsed",
    importedAt: BASE - sourceSeq * 1000,
    parsedAt: BASE - sourceSeq * 500,
    redacted: true,
    ...over,
  }
}

let jobSeq = 0
export function makeTwinJob(over: Partial<TwinJob> = {}): TwinJob {
  jobSeq += 1
  return {
    id: `job-${jobSeq}`,
    twinId: "twin-1",
    kind: "ingest",
    sourceIds: ["source-1"],
    status: "completed",
    phase: "embedding",
    progress: 100,
    queuedAt: BASE - 10_000,
    startedAt: BASE - 9_000,
    completedAt: BASE - 1_000,
    retryCount: 0,
    ...over,
  }
}

let draftSeq = 0
export function makeTwinDraft(over: Partial<TwinDraft> = {}): TwinDraft {
  draftSeq += 1
  return {
    id: `draft-${draftSeq}`,
    twinId: "twin-1",
    jobId: "job-1",
    kind: "character",
    payload: {
      kind: "character",
      data: {
        name: `Drafted Persona ${draftSeq}`,
        description: "A distilled support-engineer persona.",
        systemPrompt: "You are a calm, precise support engineer.",
        voiceSummary: "Professional, concise, reassuring.",
      },
    },
    provenance: { chunkIds: ["chunk-1", "chunk-2"], rationale: "Recurring tone across emails." },
    status: "pending",
    createdAt: BASE - draftSeq * 1000,
    ...(over as Partial<TwinDraft>),
  } as TwinDraft
}

export function makePlaceholder(over: Partial<UnredactPlaceholder> = {}): UnredactPlaceholder {
  return {
    placeholder: "<EMAIL_001>",
    original: "alex@example.com",
    kind: "EMAIL",
    keep: true,
    ...over,
  }
}
