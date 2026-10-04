/**
 * Evidence records (M3): immutable, digest-bound observations bound to a
 * snapshot. `content` is the exact byte string that was observed — it goes
 * to CAS and `content_hash` binds it — while `record` is the structured
 * finding (query, candidate, finding detail) stored as canonical JSON.
 * Nothing about a record is ever updated; corrections are new records.
 */
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  ERROR_CODES,
  utf8Bytes,
  utcNowIso,
  WorkbenchError,
} from "@latexwb/contracts";
import type { BlobStore, Row, Scope, WorkbenchStore } from "@latexwb/storage";

export type EvidenceAccess = "fulltext" | "abstract-only" | "metadata-only" | "none";

export interface EvidenceInput {
  /** Pre-assigned id — needed when the record id must be referenced before
   * the publish transaction runs (e.g. embedded in an audit result). */
  id?: string;
  snapshotId: string;
  /** Free-form record family: "bibtex-source", "metadata-lookup", ... */
  kind: string;
  /** Where the content came from: project path, provider URL, resource id. */
  sourceLocator: string;
  /** The bytes actually observed. */
  content: Uint8Array;
  accessStatus: EvidenceAccess;
  /** Structured finding — persisted as canonical JSON in record_json. */
  record: unknown;
}

export interface EvidenceView {
  evidenceId: string;
  snapshotId: string;
  kind: string;
  sourceLocator: string;
  contentHash: string;
  accessStatus: string;
  record: unknown;
  createdAt: string;
}

export function recordEvidence(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  scope: Scope;
  input: EvidenceInput;
}): string {
  const { store, blobs, scope, input } = options;
  if (store.getSnapshot(scope, input.snapshotId) === null) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `evidence target snapshot ${input.snapshotId} does not exist in scope`,
    );
  }
  const blob = blobs.put(input.content);
  const evidenceId = input.id ?? `ev-${randomUUID()}`;
  store.insertEvidence(scope, {
    evidenceId,
    snapshotId: input.snapshotId,
    kind: input.kind,
    sourceLocator: input.sourceLocator,
    contentHash: blob.hash,
    accessStatus: input.accessStatus,
    recordJson: canonicalJson(input.record),
    createdAt: utcNowIso(),
  });
  return evidenceId;
}

export function evidenceView(row: Row): EvidenceView {
  return {
    evidenceId: row["evidence_id"] as string,
    snapshotId: row["snapshot_id"] as string,
    kind: row["kind"] as string,
    sourceLocator: row["source_locator"] as string,
    contentHash: row["content_hash"] as string,
    accessStatus: row["access_status"] as string,
    record: JSON.parse(row["record_json"] as string) as unknown,
    createdAt: row["created_at"] as string,
  };
}

export function getEvidence(
  store: WorkbenchStore,
  scope: Scope,
  evidenceId: string,
): EvidenceView | null {
  const row = store.getEvidence(scope, evidenceId);
  return row === null ? null : evidenceView(row);
}

export function listEvidence(
  store: WorkbenchStore,
  scope: Scope,
  filter: { snapshotId?: string; kind?: string } = {},
): EvidenceView[] {
  return store.listEvidence(scope, filter).map(evidenceView);
}

/** Read back the observed bytes, digest-verified through CAS. */
export function evidenceBytes(
  store: WorkbenchStore,
  blobs: BlobStore,
  scope: Scope,
  evidenceId: string,
): Uint8Array | null {
  const row = store.getEvidence(scope, evidenceId);
  if (row === null) return null;
  return blobs.getVerified(row["content_hash"] as string);
}

/** Failed lookups still record what was observed — the error report itself. */
export function failureContent(detail: unknown): Uint8Array {
  return utf8Bytes(canonicalJson(detail));
}
