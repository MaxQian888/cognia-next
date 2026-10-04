/**
 * Project-relative path rules, shared by import/snapshot/artifacts. The set
 * of accepted names matches the schema path pattern: no `..`, no leading
 * slash, no drive letters, no backslashes, no control characters.
 */
import { normalize } from "node:path";

const SCHEMA_PATH = /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\x00-\x1f\x7f]).+$/;

export function isValidProjectPath(path: string): boolean {
  return path.length <= 1024 && SCHEMA_PATH.test(path);
}

/**
 * Convert a filesystem-relative path to the canonical project path form:
 * forward slashes, NFC, no leading ./ or trailing slash.
 */
export function toProjectPath(relPath: string): string {
  const normalized = normalize(relPath).split("\\").join("/").normalize("NFC");
  return normalized.replace(/^\.\//, "").replace(/\/+$/, "");
}
