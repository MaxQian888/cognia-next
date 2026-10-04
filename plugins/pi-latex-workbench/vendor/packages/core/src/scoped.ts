/**
 * Scoped-resource helper: a repository row fetched under (workspace, project)
 * is either the object or "not found". Callers must never get a different
 * scope's object back — scoped queries return null and this converts that to
 * the uniform NOT_FOUND error.
 */
import { WorkbenchError, ERROR_CODES } from "@latexwb/contracts";
import type { Row } from "@latexwb/storage";

export function getOrNotFound(row: Row | null, description: string): Row {
  if (row === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `${description} does not exist`);
  }
  return row;
}
