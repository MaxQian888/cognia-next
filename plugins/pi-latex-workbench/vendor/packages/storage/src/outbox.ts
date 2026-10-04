/**
 * Transactional project-event outbox helper.
 *
 * `emitProjectEvent` allocates the next per-project seq (via
 * `UPDATE projects SET event_seq=event_seq+1 ... RETURNING`) and inserts the
 * project_events row inside ONE immediate transaction. A state change and its
 * outbox event therefore commit or roll back together: seqs are strictly
 * monotonic per project, with no gaps from failed transactions and no
 * duplicates from racing writers (the immediate write lock serializes them).
 */
import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db.ts";
import { WorkbenchStore, type Scope } from "./repos.ts";

export interface ProjectEventInput {
  jobId: string | null;
  /**
   * Serialized event JSON, or a factory receiving the allocated seq so the
   * payload can embed its own sequence number (schema Event requires seq).
   */
  eventJson: string | ((seq: number) => string);
  createdAt: string;
}

/** Standalone emit: opens its own immediate transaction. */
export function emitProjectEvent(
  db: DatabaseSync,
  scope: Scope,
  event: ProjectEventInput,
): number {
  const store = new WorkbenchStore(db);
  return inTransaction(db, () => store.emitProjectEventInTx(scope, event));
}

/**
 * Composed emit: call inside an existing inTransaction() together with the
 * state change the event describes.
 */
export function emitProjectEventInTx(
  store: WorkbenchStore,
  scope: Scope,
  event: ProjectEventInput,
): number {
  return store.emitProjectEventInTx(scope, event);
}
