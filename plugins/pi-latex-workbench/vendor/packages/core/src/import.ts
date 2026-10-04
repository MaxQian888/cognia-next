/**
 * Host-side project import. Only the CLI/host may call this — tool surfaces
 * receive a projectId, never a host path. Every encountered filesystem entry
 * is either accepted (bytes hashed into CAS) or recorded with a concrete
 * rejection/exclusion reason; nothing is silently dropped.
 *
 * Rejections vs exclusions: exclusions are configured skip-lists (.git,
 * .env*, session/cache dirs); rejections are security or integrity failures
 * (symlink/hardlink escape, special files, path violations, size/count
 * limits, name conflicts).
 */
import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  WorkbenchError,
  type HostPolicy,
} from "@latexwb/contracts";
import { toProjectPath, isValidProjectPath } from "./paths.ts";

export interface ImportRejection {
  path: string;
  reason: string;
  detail: string;
}

export interface ImportAcceptance {
  path: string;
  hostPath: string;
  sizeBytes: number;
}

export interface ImportScanResult {
  rootPath: string;
  accepted: ImportAcceptance[];
  rejected: ImportRejection[];
  excluded: ImportRejection[];
  totalBytes: number;
}

export interface ImportLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export function limitsFromHostPolicy(policy: HostPolicy | null): ImportLimits {
  const mib = 1024 * 1024;
  return {
    maxFileBytes: (policy?.limits.unpackedInputMiB ?? 256) * mib,
    maxTotalBytes: (policy?.limits.unpackedInputMiB ?? 256) * mib,
    maxFiles: policy?.limits.inputFiles ?? 10_000,
  };
}

const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pi",
  ".cache",
  ".latexwb",
  "__pycache__",
]);

const EXCLUDED_FILE_PATTERNS = [/^\.env(?:\..*)?$/, /^\.DS_Store$/];

/** Generated TeX intermediates that are not sources of truth. */
const GENERATED_OUTPUT_EXTS = new Set([".aux", ".log", ".out", ".toc", ".fls", ".fdb_latexmk", ".synctex.gz", ".blg"]);

function isExcludedFileName(name: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some((re) => re.test(name));
}

export function classifyRole(projectPath: string): string {
  const lower = projectPath.toLowerCase();
  if (lower.endsWith(".bib")) return "bibliography";
  if (lower.endsWith(".bbl")) return "provided-bbl";
  if (/\.(tex|ltx|sty|cls|def|clo|dtx|ins|cfg|fd|ldf|biblatex\.conf)$/.test(lower)) return "source";
  if (/(^|\/)(latexmkrc|\.latexmkrc|arara\.yaml|arara\.yml|makefile|\.chktexrc|latexmkrcextra)/.test(lower)) {
    return "project-config";
  }
  return "raw-asset";
}

/**
 * Walk `hostPath` (must be a directory) and classify every entry. Uses
 * lstat throughout so links are seen as links; nothing is followed outside
 * the root without being recorded.
 */
export function scanImportDirectory(hostPath: string, limits: ImportLimits): ImportScanResult {
  const rootStat = lstatSync(hostPath);
  if (!rootStat.isDirectory()) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `import source ${hostPath} is not a directory`,
    );
  }
  const root = realpathSync(hostPath);
  const accepted: ImportAcceptance[] = [];
  const rejected: ImportRejection[] = [];
  const excluded: ImportRejection[] = [];
  let totalBytes = 0;
  const seenNormalized = new Map<string, string>();

  const reject = (path: string, reason: string, detail: string): void => {
    rejected.push({ path, reason, detail });
  };
  const exclude = (path: string, reason: string, detail: string): void => {
    excluded.push({ path, reason, detail });
  };

  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const hostEntry = join(dir, entry.name);
      const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) {
          exclude(rel, "excluded-dir", `directory ${entry.name} is on the exclusion list`);
          continue;
        }
        walk(hostEntry, rel);
        continue;
      }

      if (entry.isSymbolicLink()) {
        // Links are never materialized; record whether they escaped the root.
        try {
          const target = realpathSync(hostEntry);
          if (target === root || target.startsWith(root + sep)) {
            reject(rel, "symlink", "symbolic links are not imported (in-tree target)");
          } else {
            reject(rel, "symlink-escape", `symlink target ${target} escapes the import root`);
          }
        } catch {
          reject(rel, "symlink-escape", "dangling symlink cannot be resolved safely");
        }
        continue;
      }

      if (!entry.isFile()) {
        reject(rel, "special-file", `${entry.isFIFO() ? "FIFO" : entry.isSocket() ? "socket" : "device/other"} is not a regular file`);
        continue;
      }

      if (isExcludedFileName(entry.name)) {
        exclude(rel, "excluded-file", `file ${entry.name} is on the exclusion list`);
        continue;
      }

      const projectPath = toProjectPath(rel);
      if (!isValidProjectPath(projectPath)) {
        reject(rel, "path-violation", `path ${JSON.stringify(rel)} is not a valid project path`);
        continue;
      }

      const stat = statSync(hostEntry);
      if (stat.nlink > 1) {
        reject(rel, "hardlink", `hardlinked file (nlink=${stat.nlink}) may share storage outside the root`);
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        reject(rel, "size-limit", `${stat.size} bytes exceeds per-file limit ${limits.maxFileBytes}`);
        continue;
      }
      if (totalBytes + stat.size > limits.maxTotalBytes) {
        reject(rel, "size-limit", `cumulative size exceeds limit ${limits.maxTotalBytes}`);
        continue;
      }
      if (accepted.length >= limits.maxFiles) {
        reject(rel, "count-limit", `file count exceeds limit ${limits.maxFiles}`);
        continue;
      }
      if (GENERATED_OUTPUT_EXTS.has(extName(entry.name))) {
        exclude(rel, "generated-file", "TeX intermediate/output file, not a source of truth");
        continue;
      }

      const normalizedKey = projectPath.normalize("NFC").toLowerCase();
      const prior = seenNormalized.get(normalizedKey);
      if (prior !== undefined) {
        reject(rel, "name-conflict", `collides with ${prior} under NFC/case-insensitive comparison`);
        continue;
      }
      seenNormalized.set(normalizedKey, projectPath);

      totalBytes += stat.size;
      accepted.push({ path: projectPath, hostPath: hostEntry, sizeBytes: stat.size });
    }
  };

  walk(root, "");
  return { rootPath: root, accepted, rejected, excluded, totalBytes };
}

function extName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".synctex.gz")) return ".synctex.gz";
  const idx = lower.lastIndexOf(".");
  return idx === -1 ? "" : lower.slice(idx);
}

export function defaultProjectId(hostPath: string): string {
  const name = basename(resolve(hostPath)).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  const sanitized = /^[A-Za-z0-9]/.test(name) ? name : `p-${name}`;
  return sanitized.slice(0, 120) || `p-${sha256Hex(utf8Bytes(hostPath)).slice(0, 12)}`;
}
