/**
 * Bibliography service (M3): real BibTeX parsing, citation audit against
 * snapshot sources, approved-provider resolution for missing keys, and
 * import-patch generation through the normal proposePatch lifecycle.
 *
 * Semantics of the audit axes:
 * - syntax:       the citekey parses and its defining entry parsed cleanly.
 * - metadata:     "verified" only when persisted lookup evidence binds a
 *                 verified provider record to this key; a locally defined
 *                 entry is "unverified" (the .bib is not an authority).
 * - sourceAccess: whether the underlying work's bytes were observed —
 *                 a .bib entry alone is "metadata-only".
 * - claimSupport: always "not-reviewed" in M3 — nothing here can establish
 *                 that a cited work supports the sentence around \\cite{}.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  WorkbenchError,
  type CitationAudit,
  type CitationLookupResult,
  type FileOperation,
  type HostPolicy,
  type PatchProposal,
} from "@latexwb/contracts";
import type { BlobStore, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { parseBibTeX, scanCitations, type BibEntry, type CitationUse } from "./bib.ts";
import { readSnapshotFile } from "./snapshot.ts";
import { runServiceJob } from "./service-job.ts";
import type { EvidenceInput, EvidenceView } from "./evidence.ts";
import { listEvidence } from "./evidence.ts";
import { runLookups, type LocalBibSource, type StoredCandidate } from "./metadata/index.ts";
import { proposePatch } from "./patch.ts";
import { JobService } from "./jobs.ts";

export interface BibDeps {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  jobs?: JobService;
}

interface ParsedBib {
  path: string;
  bytes: Uint8Array;
  entries: BibEntry[];
  errors: { message: string; offsetByte: number; line: number; column: number }[];
  evidenceId?: string;
}

const KEY_UNSAFE = /[\s,{}()#"%=\\]/;

type VersionState = "preprint" | "published" | "unknown";

/**
 * Record-version classification for a .bib entry (BIB-03). Signals, in
 * strength order: a venue locator (journal/journaltitle plus
 * volume/number/pages — or booktitle + pages for proceedings entries) marks
 * the PUBLISHED record; an `eprint` field or `archiveprefix=arXiv` marks a
 * PREPRINT record; neither ⇒ unknown. An entry carrying both signal sets
 * (eprint retained on a fully-venued record) is "published" — the venue
 * fields name the version of record, the eprint is provenance.
 */
function classifyVersionState(entry: BibEntry): { state: VersionState; signals: string[] } {
  const get = (name: string): string => entry.fields.get(name)?.trim() ?? "";
  const signals: string[] = [];
  const preprint = get("eprint") !== "" || get("archiveprefix").toLowerCase() === "arxiv";
  if (preprint) signals.push(get("eprint") !== "" ? "eprint" : "archiveprefix=arXiv");
  const venue =
    get("journal") !== "" ||
    get("journaltitle") !== "" ||
    (get("booktitle") !== "" && ["inproceedings", "incollection", "conference"].includes(entry.type));
  const locator = ["volume", "number", "pages"].some((k) => get(k) !== "");
  if (venue && locator) {
    signals.push("venue+volume/number/pages");
    return { state: "published", signals };
  }
  if (preprint) return { state: "preprint", signals };
  if (venue) signals.push("venue-name-only");
  return { state: "unknown", signals };
}

/** A stored provider item names a venue → "DOI resolved to a venue" proof. */
function providerItemHasVenue(rawItemJson: string | undefined): boolean {
  if (rawItemJson === undefined) return false;
  try {
    const item = JSON.parse(rawItemJson) as { "container-title"?: string[]; type?: string };
    if (Array.isArray(item["container-title"]) && item["container-title"].some((t) => (t ?? "").trim().length > 0)) {
      return true;
    }
    return ["journal-article", "proceedings-article", "book-chapter", "book"].includes(item.type ?? "");
  } catch {
    return false;
  }
}

/** Normalized same-work identity: lowercase DOI, else normalized title+year. */
function workIdentity(entry: BibEntry): string | null {
  const doi = entry.fields.get("doi")?.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
  if (doi !== undefined && doi !== "") return `doi:${doi}`;
  const title = entry.fields.get("title")?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
  const year = entry.fields.get("year")?.trim() ?? "";
  if (title.length < 8) return null;
  return `title:${title}|${year}`;
}

function texSourceFiles(store: WorkbenchStore, scope: Scope, snapshotId: string): string[] {
  return store
    .listSnapshotFiles(scope, snapshotId)
    .map((r) => r["path"] as string)
    .filter((p) => /\.(tex|ltx)$/i.test(p))
    .sort();
}

function auditCompute(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  scope: Scope;
  snapshotId: string;
  bibPaths: string[];
}): {
  audit: CitationAudit;
  detail: Record<string, unknown>;
  evidence: EvidenceInput[];
} {
  const { store, blobs, scope, snapshotId, bibPaths } = options;
  const parsed: ParsedBib[] = [];
  const evidence: EvidenceInput[] = [];
  for (const path of bibPaths) {
    const bytes = readSnapshotFile({ store, blobs, scope, snapshotId, path });
    if (bytes === null) {
      throw new WorkbenchError(
        ERROR_CODES.NOT_FOUND,
        `bibliography file ${JSON.stringify(path)} is not in snapshot ${snapshotId}`,
      );
    }
    const file = parseBibTeX(bytes);
    evidence.push({
      snapshotId,
      kind: "bibtex-source",
      sourceLocator: `project:${path}`,
      content: bytes,
      accessStatus: "fulltext",
      record: {
        path,
        sha256: sha256Hex(bytes),
        entryCount: file.entries.length,
        errorCount: file.errors.length,
        keys: file.entries.map((e) => e.key),
      },
    });
    parsed.push({ path, bytes, entries: file.entries, errors: file.errors });
  }

  // key → defining entry + file (first wins; repeats are conflicts). All
  // defs are retained so a duplicate key's version states are reported per
  // definition — never silently merged.
  const defined = new Map<string, { entry: BibEntry; path: string }>();
  const allDefs = new Map<string, { entry: BibEntry; path: string }[]>();
  const duplicates = new Set<string>();
  for (const file of parsed) {
    for (const entry of file.entries) {
      const list = allDefs.get(entry.key) ?? [];
      list.push({ entry, path: file.path });
      allDefs.set(entry.key, list);
      if (defined.has(entry.key)) duplicates.add(entry.key);
      else defined.set(entry.key, { entry, path: file.path });
    }
  }

  // Cited keys across every .tex source, first-appearance order.
  const citations: { path: string; use: CitationUse }[] = [];
  const citedKeys: string[] = [];
  const seenCited = new Set<string>();
  for (const path of texSourceFiles(store, scope, snapshotId)) {
    const bytes = readSnapshotFile({ store, blobs, scope, snapshotId, path });
    if (bytes === null) continue;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    for (const use of scanCitations(text)) {
      citations.push({ path, use });
      if (!seenCited.has(use.key)) {
        seenCited.add(use.key);
        citedKeys.push(use.key);
      }
    }
  }

  // Verified-metadata evidence from earlier lookups on this snapshot, plus
  // keys whose provider record resolves the identifier to a venue (the
  // "DOI resolving to a venue" rule of the version classifier).
  const verifiedKeys = new Set<string>();
  const venueKeys = new Set<string>();
  const lookupEvidenceByKey = new Map<string, string[]>();
  for (const ev of listEvidence(store, scope, { snapshotId, kind: "metadata-lookup" })) {
    const rec = ev.record as {
      forCitekey?: string;
      status?: string;
      candidates?: Array<{
        forCitekey?: string;
        rawItemJson?: string;
        candidate?: { metadataStatus?: string; identifier?: string | null };
      }>;
    };
    const keys = new Set<string>();
    if (rec.forCitekey !== undefined) keys.add(rec.forCitekey);
    for (const c of rec.candidates ?? []) {
      if (c.forCitekey !== undefined) keys.add(c.forCitekey);
      if (
        c.candidate?.metadataStatus === "verified" &&
        rec.forCitekey !== undefined
      ) {
        verifiedKeys.add(rec.forCitekey);
      }
      if (providerItemHasVenue(c.rawItemJson)) {
        const bound = c.forCitekey ?? rec.forCitekey;
        if (bound !== undefined) venueKeys.add(bound);
      }
    }
    for (const k of keys) {
      const list = lookupEvidenceByKey.get(k) ?? [];
      list.push(ev.evidenceId);
      lookupEvidenceByKey.set(k, list);
    }
  }

  // Bib-file evidence ids are filled by the caller (publish step) — the
  // audit entries reference them via the report, so we record the mapping
  // in detail and let propose/report resolve them.
  const allKeys = [...citedKeys];
  for (const key of defined.keys()) {
    if (!seenCited.has(key)) allKeys.push(key);
  }
  const entries: CitationAudit["entries"] = allKeys.map((citekey) => {
    const def = defined.get(citekey);
    const dup = duplicates.has(citekey);
    const syntaxValid = !KEY_UNSAFE.test(citekey);
    let syntax: "valid" | "invalid" = syntaxValid ? "valid" : "invalid";
    // Defined only inside a file region that failed to parse.
    if (def === undefined) {
      for (const file of parsed) {
        const rawText = new TextDecoder("utf-8", { fatal: false }).decode(file.bytes);
        if (file.errors.length > 0 && rawText.includes(citekey)) {
          syntax = "invalid";
        }
      }
    }
    const metadata =
      def === undefined
        ? "not-found"
        : dup
          ? "conflict"
          : verifiedKeys.has(citekey)
            ? "verified"
            : "unverified";
    const sourceAccess =
      def === undefined ? "none" : ("metadata-only" as const);
    // BIB-03 record-version classification. Local fields first; a
    // non-preprint local record upgrades to "published" only when provider
    // evidence resolves the identifier to a venue. Missing entry ⇒ unknown.
    const versionInfo = def !== undefined ? classifyVersionState(def.entry) : null;
    const versionState: VersionState =
      versionInfo === null
        ? venueKeys.has(citekey)
          ? "published"
          : "unknown"
        : versionInfo.state === "published" || venueKeys.has(citekey)
          ? "published"
          : versionInfo.state;
    return {
      citekey,
      syntax,
      metadata,
      sourceAccess,
      claimSupport: "not-reviewed" as const,
      versionState,
      // Evidence rows are persisted in the same transaction; the report
      // artifact carries the concrete ids (see detail.evidenceByKey).
      evidenceArtifactIds: [
        ...(def !== undefined ? [`bibsrc:${def.path}`] : []),
        ...(lookupEvidenceByKey.get(citekey) ?? []),
      ],
    };
  });

  const audit: CitationAudit = {
    kind: "citation-audit",
    snapshotId,
    entries,
    proposedPatchId: null,
  };

  // Same-work conflicts: normalized DOI (else title+year) shared by keys
  // whose classified versions disagree — e.g. arXiv eprint vs journal
  // version-of-record for the same paper.
  const versionConflicts = (() => {
    const byWork = new Map<string, { citekey: string; state: VersionState }[]>();
    for (const [key, def] of defined) {
      const id = workIdentity(def.entry);
      if (id === null) continue;
      const state = entries.find((e) => e.citekey === key)?.versionState ?? "unknown";
      const list = byWork.get(id) ?? [];
      list.push({ citekey: key, state });
      byWork.set(id, list);
    }
    const conflicts: { identity: string; keys: { citekey: string; state: VersionState }[] }[] = [];
    for (const [identity, keys] of byWork) {
      if (keys.length > 1 && new Set(keys.map((k) => k.state)).size > 1) {
        conflicts.push({ identity, keys });
      }
    }
    return conflicts;
  })();

  const detail: Record<string, unknown> = {
    kind: "bibliography-audit-report",
    snapshotId,
    bibFiles: parsed.map((f) => ({
      path: f.path,
      sha256: sha256Hex(f.bytes),
      entryCount: f.entries.length,
      errors: f.errors,
    })),
    citationSites: citations.map((c) => ({
      path: c.path,
      key: c.use.key,
      line: c.use.line,
      column: c.use.column,
    })),
    entries: allKeys.map((k) => {
      const def = defined.get(k);
      const defs = allDefs.get(k) ?? [];
      return {
        citekey: k,
        cited: seenCited.has(k),
        definedIn: def?.path ?? null,
        entryType: def?.entry.type ?? null,
        fields: def !== undefined ? Object.fromEntries(def.entry.fields) : null,
        // Per-definition version classification — a duplicate key's defs
        // may disagree about preprint vs published.
        definitions: defs.map((d) => ({
          path: d.path,
          entryType: d.entry.type,
          ...classifyVersionState(d.entry),
        })),
        versionState: entries.find((e) => e.citekey === k)?.versionState ?? "unknown",
        versionSignals: [
          ...(def !== undefined ? classifyVersionState(def.entry).signals : []),
          ...(venueKeys.has(k) ? ["provider-venue-resolution"] : []),
        ],
      };
    }),
    versionConflicts,
    summary: {
      cited: citedKeys.length,
      defined: defined.size,
      missing: entries.filter((e) => e.metadata === "not-found").length,
      conflicts: entries.filter((e) => e.metadata === "conflict").length,
      versionConflicts: versionConflicts.length,
      syntaxInvalid: entries.filter((e) => e.syntax === "invalid").length,
    },
  };
  return { audit, detail, evidence };
}

/** `bibsrc:<path>` placeholders become real evidence ids after publish. */
function bindEvidencePlaceholders(
  audit: CitationAudit,
  pathToEvidenceId: Map<string, string>,
): CitationAudit {
  return {
    ...audit,
    entries: audit.entries.map((e) => ({
      ...e,
      evidenceArtifactIds: e.evidenceArtifactIds.map((id) =>
        id.startsWith("bibsrc:") ? (pathToEvidenceId.get(id.slice(7)) ?? id) : id,
      ),
    })),
  };
}

export async function auditBibliography(
  deps: BibDeps,
  input: { snapshotId: string; bibPaths: string[] },
): Promise<{ audit: CitationAudit; reportArtifactId: string; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "project.read");
  if (store.getSnapshot(scope, input.snapshotId) === null) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `snapshot ${input.snapshotId} not found in scope`,
    );
  }
  const out = await runServiceJob<{
    audit: CitationAudit;
    reportArtifactId: string;
  }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "bibliography.audit",
    snapshotId: input.snapshotId,
    input,
    compute: () => {
      const { audit, detail, evidence } = auditCompute({
        store,
        blobs,
        scope,
        snapshotId: input.snapshotId,
        bibPaths: input.bibPaths,
      });
      // Pre-assign evidence ids so the audit rows and the report artifact
      // reference the ids the publish step will actually write — all inside
      // the job finalize transaction.
      const pathToEvidenceId = new Map<string, string>();
      const plannedEvidence: EvidenceInput[] = evidence.map((ev) => {
        const id = `ev-${randomUUID()}`;
        if (ev.kind === "bibtex-source") {
          pathToEvidenceId.set(ev.sourceLocator.slice("project:".length), id);
        }
        return { ...ev, id };
      });
      const bound = bindEvidencePlaceholders(audit, pathToEvidenceId);
      const reportBytes = utf8Bytes(
        canonicalJson({
          ...detail,
          evidenceByKey: Object.fromEntries(
            bound.entries.map((e) => [e.citekey, e.evidenceArtifactIds]),
          ),
        }),
      );
      const reportBlob = blobs.put(reportBytes);
      const reportArtifactId = `report-${reportBlob.hash.slice(0, 16)}`;
      return {
        result: { audit: bound, reportArtifactId },
        artifacts: [
          {
            artifactId: reportArtifactId,
            relPath: "bibliography-audit.json",
            kind: "report",
            blobHash: reportBlob.hash,
            sizeBytes: reportBytes.length,
            mediaType: "application/json",
          },
        ],
        evidence: plannedEvidence,
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}

export interface ApprovedBibEntry {
  id: string;
  path: string;
  sha256: string;
}

/** Host-owned reference corpus: resources/bibliography/registry.json. */
export function loadApprovedBibliographies(repoRoot: string): LocalBibSource[] {
  const registryPath = join(repoRoot, "resources", "bibliography", "registry.json");
  let raw: { resources?: ApprovedBibEntry[] };
  try {
    raw = JSON.parse(readFileSync(registryPath, "utf8")) as typeof raw;
  } catch {
    return [];
  }
  const sources: LocalBibSource[] = [];
  for (const entry of raw.resources ?? []) {
    const filePath = join(repoRoot, "resources", "bibliography", entry.path);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(filePath));
    } catch {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `approved bibliography ${entry.id} file ${entry.path} is missing`,
      );
    }
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new WorkbenchError(
        ERROR_CODES.DIGEST_MISMATCH,
        `approved bibliography ${entry.id} digest mismatch: file hashes to ${actual}, registry says ${entry.sha256}`,
      );
    }
    sources.push({ locator: `resource:${entry.id}`, bytes });
  }
  return sources;
}

export interface LookupDeps extends BibDeps {
  hostPolicy: HostPolicy | null;
  /** Needed when localCorpus === "approved". */
  repoRoot?: string;
  /** Test seam for the crossref transport. */
  fetchImpl?: import("./metadata/crossref.ts").Fetcher;
  /** Test seam: crossref retry backoff sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export async function lookupCitations(
  deps: LookupDeps,
  input: {
    snapshotId: string;
    query?: string;
    identifier?: string;
    forCitekey?: string;
    /** "project" → the snapshot's own .bib files; "approved" → host registry. */
    localCorpus: "project" | "approved" | "none";
  },
): Promise<{ result: CitationLookupResult; candidateIds: string[]; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "metadata.lookup");
  if (store.getSnapshot(scope, input.snapshotId) === null) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `snapshot ${input.snapshotId} not found in scope`,
    );
  }
  const query =
    input.identifier !== undefined
      ? ({ kind: "identifier", identifier: input.identifier } as const)
      : input.forCitekey !== undefined
        ? ({ kind: "key", key: input.forCitekey } as const)
        : ({ kind: "query", query: input.query ?? "" } as const);

  const bibSources: LocalBibSource[] =
    input.localCorpus === "project"
      ? store
          .listSnapshotFiles(scope, input.snapshotId)
          .map((r) => r["path"] as string)
          .filter((p) => p.toLowerCase().endsWith(".bib"))
          .map((p) => ({
            locator: `project:${p}`,
            bytes: readSnapshotFile({ store, blobs, scope, snapshotId: input.snapshotId, path: p }) ?? new Uint8Array(),
          }))
      : input.localCorpus === "approved"
        ? (() => {
            if (deps.repoRoot === undefined) {
              throw new WorkbenchError(
                ERROR_CODES.INVALID_REQUEST,
                "approved local corpus requires repoRoot",
              );
            }
            return loadApprovedBibliographies(deps.repoRoot);
          })()
        : [];

  const out = await runServiceJob<{
    result: CitationLookupResult;
    candidateIds: string[];
  }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "bibliography.lookup",
    snapshotId: input.snapshotId,
    input: { ...input },
    compute: async () => {
      const outcome = await runLookups({
        snapshotId: input.snapshotId,
        query,
        bibSources,
        forCitekey: input.forCitekey,
        hostPolicy: deps.hostPolicy,
        fetchImpl: deps.fetchImpl,
        sleepImpl: deps.sleepImpl,
      });
      return {
        result: {
          result: outcome.result,
          candidateIds: outcome.stored.map((s) => s.id),
        },
        evidence: outcome.evidence,
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}

interface BibDepsWithRepo extends BibDeps {
  repoRoot?: string;
  fetchImpl?: import("./metadata/crossref.ts").Fetcher;
  /** Test seam: crossref retry backoff sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  hostPolicy?: HostPolicy | null;
}

/**
 * Resolve missing citekeys through approved providers only. Returns the
 * persisted candidate ids (empty when nothing could be found — the caller
 * decides whether that is a failure or just 'nothing to import').
 */
export async function resolveCitations(
  deps: BibDepsWithRepo,
  input: { snapshotId: string; bibPaths: string[] },
): Promise<{ candidateIds: string[]; missingKeys: string[]; warnings: string[]; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "metadata.lookup");
  const out = await runServiceJob<{
    candidateIds: string[];
    missingKeys: string[];
    warnings: string[];
  }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "bibliography.resolve",
    snapshotId: input.snapshotId,
    input,
    compute: async () => {
      const { audit } = auditCompute({
        store,
        blobs,
        scope,
        snapshotId: input.snapshotId,
        bibPaths: input.bibPaths,
      });
      const missing = audit.entries
        .filter((e) => e.metadata === "not-found")
        .map((e) => e.citekey);
      const warnings: string[] = [];
      const candidateIds: string[] = [];
      const allEvidence: EvidenceInput[] = [];
      const approvedSources =
        deps.repoRoot !== undefined ? loadApprovedBibliographies(deps.repoRoot) : [];
      for (const key of missing) {
        const outcome = await runLookups({
          snapshotId: input.snapshotId,
          query: { kind: "key", key },
          bibSources: approvedSources,
          forCitekey: key,
          hostPolicy: deps.hostPolicy ?? null,
          fetchImpl: deps.fetchImpl,
          sleepImpl: deps.sleepImpl,
        });
        candidateIds.push(...outcome.stored.map((s) => s.id));
        warnings.push(...outcome.result.warnings);
        allEvidence.push(...outcome.evidence);
      }
      return {
        result: { candidateIds, missingKeys: missing, warnings },
        evidence: allEvidence,
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}

function retagBibKey(entryRaw: string, newKey: string): string {
  const openIdx = entryRaw.search(/[{(]/);
  if (openIdx === -1) return entryRaw;
  let i = openIdx + 1;
  while (i < entryRaw.length && /\s/.test(entryRaw[i] as string)) i += 1;
  const keyStart = i;
  while (i < entryRaw.length && !/[\s,)}]/.test(entryRaw[i] as string)) i += 1;
  return `${entryRaw.slice(0, keyStart)}${newKey}${entryRaw.slice(i)}`;
}

function deriveImportKey(candidate: { authors: string[]; year: number | null; title: string }): string {
  const surname = (candidate.authors[0] ?? "anon")
    .split(/[,\s]+/)
    .filter((s) => s.length > 0)
    .pop() ?? "anon";
  const word = (candidate.title.split(/\s+/)[0] ?? "work").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${surname.toLowerCase().replace(/[^a-z0-9]/g, "")}${candidate.year ?? "nd"}${word}`;
}

/** Locate a persisted candidate record across metadata-lookup evidence. */
function findCandidate(
  store: WorkbenchStore,
  scope: Scope,
  candidateId: string,
): { evidence: EvidenceView; stored: StoredCandidate } | null {
  for (const ev of listEvidence(store, scope, { kind: "metadata-lookup" })) {
    const rec = ev.record as { candidates?: StoredCandidate[] };
    for (const c of rec.candidates ?? []) {
      if (c.id === candidateId) return { evidence: ev, stored: c };
    }
  }
  return null;
}

export async function proposeBibliographyImport(
  deps: BibDeps,
  input: { baseSnapshotId: string; bibPath: string; candidateIds: string[] },
): Promise<{ proposal: PatchProposal | null; skipped: string[]; warnings: string[] }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "project.write");
  if (store.getSnapshot(scope, input.baseSnapshotId) === null) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `base snapshot ${input.baseSnapshotId} not found in scope`,
    );
  }
  const existingBytes = readSnapshotFile({
    store,
    blobs,
    scope,
    snapshotId: input.baseSnapshotId,
    path: input.bibPath,
  });
  const existingEntries = new Map<string, BibEntry>();
  if (existingBytes !== null) {
    for (const e of parseBibTeX(existingBytes).entries) {
      existingEntries.set(e.key, e);
    }
  }

  const skipped: string[] = [];
  const warnings: string[] = [];
  const toImport: { key: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const candidateId of input.candidateIds) {
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    const found = findCandidate(store, scope, candidateId);
    if (found === null) {
      warnings.push(`candidate ${candidateId} has no persisted lookup evidence — skipped`);
      continue;
    }
    const stored = found.stored;
    // Digest re-verification before trusting the stored entry text.
    const bound =
      stored.rawItemJson !== undefined
        ? sha256Hex(utf8Bytes(stored.rawItemJson)) === stored.itemHash
        : false;
    if (!bound) {
      throw new WorkbenchError(
        ERROR_CODES.DIGEST_MISMATCH,
        `candidate ${candidateId} evidence record failed metadataHash verification (provider ${stored.provider})`,
      );
    }
    const key = stored.forCitekey ?? deriveImportKey(stored.candidate);
    if (existingEntries.has(key)) {
      skipped.push(`key ${key} already defined in ${input.bibPath}`);
      continue;
    }
    let text = stored.bibEntry;
    if (text === undefined) {
      warnings.push(`candidate ${candidateId} carries no BibTeX rendering — skipped`);
      continue;
    }
    text = retagBibKey(text, key);
    toImport.push({ key, text });
  }

  if (toImport.length === 0) {
    return { proposal: null, skipped, warnings };
  }

  const operations: FileOperation[] = [];
  if (existingBytes === null) {
    operations.push({
      op: "create",
      path: input.bibPath,
      content: `${toImport.map((t) => t.text).join("\n\n")}\n`,
    });
  } else {
    const appended = toImport.map((t) => t.text).join("\n\n");
    const replacement = `${existingBytes[existingBytes.length - 1] === 0x0a ? "" : "\n"}\n${appended}\n`;
    operations.push({
      op: "edit",
      path: input.bibPath,
      expectedSha256: sha256Hex(existingBytes),
      edits: [
        {
          startByte: existingBytes.length,
          endByte: existingBytes.length,
          replacement,
        },
      ],
    });
  }
  const proposal = proposePatch({
    store,
    blobs,
    ctx,
    scope,
    baseSnapshotId: input.baseSnapshotId,
    operations,
    reason: `bibliography import: ${toImport.length} verified entr${toImport.length === 1 ? "y" : "ies"} from persisted provider evidence`,
  });
  return { proposal, skipped, warnings };
}

/**
 * Report on the audit already persisted for this snapshot (the audit job's
 * report artifact), falling back to a fresh recompute when none exists.
 * Either way the answer is real recomputation or a real stored artifact —
 * never a canned status.
 */
export function bibliographyReport(
  deps: BibDeps,
  input: { snapshotId: string; bibPaths: string[] },
): {
  reportArtifactId: string | null;
  summary: Record<string, unknown>;
  entries: Array<Record<string, unknown>>;
  versionConflicts: Array<Record<string, unknown>>;
} {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "project.read");
  const reports = store
    .listArtifactsBySnapshot(scope, input.snapshotId)
    .filter((a) => (a["kind"] as string) === "report")
    .filter((a) => {
      try {
        const m = JSON.parse(a["manifest_json"] as string) as { path?: string };
        return m.path === "bibliography-audit.json";
      } catch {
        return false;
      }
    });
  const latest = reports.at(-1) ?? null;
  if (latest !== null) {
    const bytes = blobs.getVerified(latest["blob_hash"] as string);
    const detail = JSON.parse(new TextDecoder().decode(bytes)) as {
      summary?: Record<string, unknown>;
      entries?: Array<Record<string, unknown>>;
      versionConflicts?: Array<Record<string, unknown>>;
    };
    return {
      reportArtifactId: latest["artifact_id"] as string,
      summary: detail.summary ?? {},
      entries: detail.entries ?? [],
      versionConflicts: detail.versionConflicts ?? [],
    };
  }
  const { audit, detail } = auditCompute({
    store,
    blobs,
    scope,
    snapshotId: input.snapshotId,
    bibPaths: input.bibPaths,
  });
  void audit;
  return {
    reportArtifactId: null,
    summary: (detail["summary"] as Record<string, unknown>) ?? {},
    entries: (detail["entries"] as Array<Record<string, unknown>>) ?? [],
    versionConflicts:
      (detail["versionConflicts"] as Array<Record<string, unknown>>) ?? [],
  };
}
