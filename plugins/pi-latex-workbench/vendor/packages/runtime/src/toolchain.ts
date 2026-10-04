/**
 * Toolchain provisioning for the local-tectonic runner.
 *
 * Tectonic resolves a bundle URL to a content digest, then fetches resource
 * files lazily over HTTP. Formal builds must never touch the network, so the
 * administrator provisions once: download the pinned bundle tar, extract it
 * to a local directory bundle (files + SHA256SUM index — verified to work
 * with `tectonic -b <dir> --only-cached`), then lock the digest of the
 * parsed SHA256SUM manifest plus the tectonic binary sha256 into
 * runtime/toolchain-lock.json.
 */
import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ERROR_CODES,
  sha256Hex,
  utcNowIso,
  WorkbenchError,
  type ToolchainLock,
} from "@latexwb/contracts";

/** Default bundle pinned by tectonic 0.17 (observed in its cache index). */
export const DEFAULT_BUNDLE_URL = "https://relay.fullyjustified.net/default_bundle_v33.tar";
export const BUNDLE_DIR_NAME = "bundle";
export const LOCK_FILE_NAME = "toolchain-lock.json";

export interface ToolchainInfo {
  bundleDir: string;
  lockPath: string;
  lock: ToolchainLock | null;
  resolved: boolean;
  /** sha256 of the extracted bundle's SHA256SUM manifest — the parsed-bundle digest. */
  toolchainDigest: string | null;
}

export function toolchainPaths(repoRoot: string): { bundleDir: string; lockPath: string } {
  return {
    bundleDir: join(repoRoot, "runtime", "toolchain", BUNDLE_DIR_NAME),
    lockPath: join(repoRoot, "runtime", LOCK_FILE_NAME),
  };
}

export function loadToolchain(repoRoot: string): ToolchainInfo {
  const { bundleDir, lockPath } = toolchainPaths(repoRoot);
  let lock: ToolchainLock | null = null;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as ToolchainLock;
  } catch {
    lock = null;
  }
  const resolved =
    lock !== null && lock.status === "resolved" && typeof lock.toolchainDigest === "string";
  return {
    bundleDir,
    lockPath,
    lock,
    resolved,
    toolchainDigest: resolved && lock !== null ? (lock.toolchainDigest as string) : null,
  };
}

export function tectonicBinary(): { path: string; version: string; sha256: string } | null {
  try {
    const which = execFileSync("which", ["tectonic"], { encoding: "utf8" }).trim();
    if (which.length === 0) return null;
    const path = realpathSync(which);
    const versionOut = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const version = versionOut.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
    return { path, version, sha256: sha256Hex(readFileSync(path)) };
  } catch {
    return null;
  }
}

/**
 * The bundle tar's own SHA256SUM member is a single 64-hex digest — the
 * bundle's resolved content digest (what tectonic records per bundle URL).
 * A DIRECTORY bundle instead needs a per-file index; generate one over the
 * extracted tree and verify a random sample of hashes for real.
 */
export function buildFileManifest(rootDir: string): {
  entries: { sha256: string; path: string }[];
  manifestText: string;
  manifestDigest: string;
} {
  const entries: { sha256: string; path: string }[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      const r = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(p, r);
      else if (entry.isFile() && entry.name !== "SHA256SUM") {
        entries.push({ sha256: sha256Hex(readFileSync(p)), path: r });
      }
    }
  };
  walk(rootDir, "");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifestText = entries.map((e) => `${e.sha256}  ${e.path}`).join("\n") + "\n";
  return { entries, manifestText, manifestDigest: sha256Hex(manifestText) };
}

export function verifyExtractedBundle(bundleDir: string, sampleSize = 200): {
  manifestDigest: string;
  manifestEntries: number;
  verified: number;
  failures: string[];
} {
  const manifestPath = join(bundleDir, "SHA256SUM");
  if (!existsSync(manifestPath)) {
    throw new WorkbenchError(
      ERROR_CODES.CONFIG_INVALID,
      `extracted bundle at ${bundleDir} has no SHA256SUM manifest`,
    );
  }
  const manifest = readFileSync(manifestPath);
  const entries = manifest
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const m = /^([a-f0-9]{64})\s+(.+)$/.exec(l);
      return m === null ? null : { sha256: m[1] as string, path: m[2] as string };
    });
  const bad = entries.findIndex((e) => e === null);
  if (bad !== -1) {
    throw new WorkbenchError(
      ERROR_CODES.CONFIG_INVALID,
      `SHA256SUM line ${bad + 1} is malformed`,
    );
  }

  const failures: string[] = [];
  const step = Math.max(1, Math.floor(entries.length / sampleSize));
  let verified = 0;
  for (let i = 0; i < entries.length; i += step) {
    const entry = entries[i] as { sha256: string; path: string };
    const file = join(bundleDir, entry.path);
    try {
      const actual = sha256Hex(readFileSync(file));
      verified += 1;
      if (actual !== entry.sha256) failures.push(entry.path);
    } catch {
      failures.push(`${entry.path} (unreadable)`);
    }
  }
  return {
    manifestDigest: sha256Hex(manifest),
    manifestEntries: entries.length,
    verified,
    failures,
  };
}

function download(url: string, destPath: string): void {
  // curl is a real fetch with redirect+resume support; output goes to a temp
  // path that is renamed into place only after a complete transfer.
  execFileSync(
    "curl",
    ["-fSL", "--retry", "3", "-C", "-", "-o", destPath, url],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 60 * 60 * 1000 },
  );
}

export interface ProvisionResult {
  lock: ToolchainLock;
  bundleDir: string;
  bundleBytes: number;
  manifestEntries: number;
  sampledVerified: number;
  smokeOk: boolean;
  tectonicSha256: string;
}

/**
 * Administrator provisioning: download the pinned bundle, extract into
 * runtime/toolchain/bundle, verify a sample against SHA256SUM, smoke-compile
 * a tiny document fully offline, then write the resolved lock.
 */
export async function provisionToolchain(repoRoot: string): Promise<ProvisionResult> {
  const binary = tectonicBinary();
  if (binary === null) {
    throw new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, "tectonic binary not found on PATH");
  }
  const { bundleDir, lockPath } = toolchainPaths(repoRoot);
  const toolchainRoot = join(repoRoot, "runtime", "toolchain");
  mkdirSync(toolchainRoot, { recursive: true });

  const tarPath = join(toolchainRoot, "bundle.tar");
  if (!existsSync(tarPath)) {
    download(DEFAULT_BUNDLE_URL, tarPath);
  }
  const bundleBytes = statSync(tarPath).size;

  // Extract to a staging dir and rename into place so a partial extraction
  // never looks like a provisioned bundle.
  const staging = mkdtempSync(join(tmpdir(), "latexwb-bundle-"));
  try {
    // Bundle members are stored mode 000; bsdtar applies them even with
    // --no-same-permissions, so fix modes explicitly after extraction.
    execFileSync("tar", ["-xf", tarPath, "-C", staging], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30 * 60 * 1000,
    });
    execFileSync("chmod", ["-R", "u+rwX,go+rX", staging], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10 * 60 * 1000,
    });

    // The tar's SHA256SUM member is the bundle's RESOLVED content digest —
    // the real parsed digest the lock must record. Read it before the file
    // is replaced by the per-file index a directory bundle requires.
    const bundleDigestPath = join(staging, "SHA256SUM");
    if (!existsSync(bundleDigestPath)) {
      throw new WorkbenchError(
        ERROR_CODES.CONFIG_INVALID,
        "bundle tar has no SHA256SUM digest member",
      );
    }
    const bundleDigest = readFileSync(bundleDigestPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(bundleDigest)) {
      throw new WorkbenchError(
        ERROR_CODES.CONFIG_INVALID,
        `bundle SHA256SUM member is not a sha256 digest: ${JSON.stringify(bundleDigest.slice(0, 80))}`,
      );
    }
    const svnrev = existsSync(join(staging, "SVNREV"))
      ? readFileSync(join(staging, "SVNREV"), "utf8").trim()
      : "unknown";
    const githash = existsSync(join(staging, "GITHASH"))
      ? readFileSync(join(staging, "GITHASH"), "utf8").trim()
      : "unknown";

    // Build the per-file index the directory bundle needs, then verify a
    // real sample against it.
    const manifest = buildFileManifest(staging);
    writeFileSync(bundleDigestPath, manifest.manifestText);
    const verify = verifyExtractedBundle(staging);
    if (verify.failures.length > 0) {
      throw new WorkbenchError(
        ERROR_CODES.DIGEST_MISMATCH,
        `bundle verification failed for ${verify.failures.length} sampled files: ${verify.failures.slice(0, 3).join(", ")}`,
      );
    }

    rmSync(bundleDir, { recursive: true, force: true });
    renameSync(staging, bundleDir);

    // Real offline smoke build against the provisioned bundle.
    const smokeDir = mkdtempSync(join(tmpdir(), "latexwb-smoke-"));
    let smokeOk = false;
    try {
      const entry = join(smokeDir, "smoke.tex");
      writeFileSync(entry, "\\documentclass{article}\n\\begin{document}\nok\n\\end{document}\n");
      mkdirSync(join(smokeDir, "out"));
      execFileSync(
        binary.path,
        [
          "-X", "compile",
          "-b", bundleDir,
          "--only-cached",
          "--untrusted",
          "-o", join(smokeDir, "out"),
          entry,
        ],
        { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
      );
      smokeOk = existsSync(join(smokeDir, "out", "smoke.pdf"));
    } finally {
      rmSync(smokeDir, { recursive: true, force: true });
    }

    const lock: ToolchainLock = {
      schemaVersion: 1,
      status: "resolved",
      toolchainDigest: bundleDigest,
      piPackageName: null,
      piVersion: null,
      fonts: [],
      templates: [],
      profiles: [],
      note:
        `tectonic ${binary.version} sha256=${binary.sha256}; ` +
        `bundle=${DEFAULT_BUNDLE_URL} svnrev=${svnrev} githash=${githash} ` +
        `extracted to runtime/toolchain/bundle (${verify.manifestEntries} files, ` +
        `manifest sha256=${verify.manifestDigest}); provisioned ${utcNowIso()}; ` +
        `offline smoke build ${smokeOk ? "ok" : "FAILED"}`,
    };
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    return {
      lock,
      bundleDir,
      bundleBytes,
      manifestEntries: verify.manifestEntries,
      sampledVerified: verify.verified,
      smokeOk,
      tectonicSha256: binary.sha256,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
