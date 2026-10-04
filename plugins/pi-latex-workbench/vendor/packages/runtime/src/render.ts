/**
 * PDFKit render-helper driver (M4): provisions and invokes the Swift
 * `render-helper` binary under runtime/render/. The helper is host-compiled
 * by `latexwb provision-renderer` — never downloaded, never loaded from a
 * project tree — and its sha256 is pinned into runtime/render/manifest.json
 * at provision time. Every invocation re-verifies that sha256 before exec:
 * a swapped or corrupted binary fails closed as RUNTIME_UNAVAILABLE rather
 * than silently running un-pinned code.
 *
 * The child environment is a fixed allowlist map (same contract as the
 * tectonic runner): PATH/HOME/TMPDIR/locale only, nothing inherited.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ERROR_CODES,
  sha256Hex,
  WorkbenchError,
} from "@latexwb/contracts";
import { spawnCapture } from "./spawn.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** Helper source ships inside the runtime package — host code, not content. */
export const RENDER_HELPER_SOURCE = join(here, "render-helper", "render-helper.swift");

export const RENDER_MODES = ["json", "pages"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

export interface RendererManifest {
  schemaVersion: 1;
  /** Path of the helper binary relative to the render dir. */
  helper: string;
  /** sha256 of the compiled helper binary — integrity pin. */
  helperSha256: string;
  /** Output of `render-helper selfcheck` recorded at provision time. */
  version: string;
  swiftcVersion: string;
  provisionedAt: string;
  platform: string;
}

export interface LoadedRenderer {
  manifestPath: string;
  manifest: RendererManifest;
  /** sha256 of the manifest file bytes — the recorded renderer identity. */
  manifestSha256: string;
  helperPath: string;
}

export interface RenderRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderedPage {
  page: number;
  size: { w: number; h: number };
  text: string;
  lineBoxes: Array<{ rect: RenderRect; text: string }>;
  links: Array<{ rect: RenderRect; url: string }>;
  /** BaseFont inventory with real embedding detection (FontFile* in the
   * font descriptor — Type0 descendants handled). */
  fonts: Array<{ name: string; embedded: boolean }>;
}

export interface RenderedPdf {
  helper: string;
  mode: RenderMode;
  dpi: number;
  pageCount: number;
  pages: RenderedPage[];
  /** Basenames of written PNGs (mode "pages" only). */
  files?: string[];
}

export function renderDir(repoRoot: string): string {
  return join(repoRoot, "runtime", "render");
}

export function renderManifestPath(repoRoot: string): string {
  return join(renderDir(repoRoot), "manifest.json");
}

function renderEnv(workDir: string): Record<string, string> {
  const home = join(workDir, "home");
  const tmp = join(workDir, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return {
    // swiftc + system dyld need /usr/bin + /bin; nothing else. No inherited
    // proxy/credential variables — the helper does no network work anyway.
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: tmp,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "UTC",
  };
}

function selfcheckVersion(helperPath: string): string {
  const probeDir = mkdtempSync(join(tmpdir(), "latexwb-render-selfcheck-"));
  try {
    const out = execFileSync(helperPath, ["selfcheck"], {
      encoding: "utf8",
      timeout: 15_000,
      env: renderEnv(probeDir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = out.split("\n").find((l) => l.trim().length > 0);
    if (line === undefined) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        "render-helper selfcheck produced no version line",
      );
    }
    return line.trim();
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * Compile the helper and pin runtime/render/manifest.json. Host-only: invoked
 * by `latexwb provision-renderer`, never on a model/tool path. Fails closed:
 * a compile error or a selfcheck failure leaves no half-written manifest.
 */
export function provisionRenderer(repoRoot: string): LoadedRenderer {
  if (!existsSync(RENDER_HELPER_SOURCE)) {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `render-helper source missing at ${RENDER_HELPER_SOURCE}`,
    );
  }
  const dir = renderDir(repoRoot);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const helperPath = join(binDir, "render-helper");
  const staging = `${helperPath}.staging-${process.pid}`;

  const scratch = mkdtempSync(join(tmpdir(), "latexwb-render-provision-"));
  try {
    // Resolve the compiler explicitly — no PATH ambiguity: the Command Line
    // Tools compiler at /usr/bin/swiftc, else xcrun's toolchain lookup.
    let compiler: { argv0: string; prefixArgs: string[] } | null = null;
    if (existsSync("/usr/bin/swiftc")) {
      compiler = { argv0: "/usr/bin/swiftc", prefixArgs: [] };
    } else if (existsSync("/usr/bin/xcrun")) {
      compiler = { argv0: "/usr/bin/xcrun", prefixArgs: ["swiftc"] };
    }
    if (compiler === null) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        "no swiftc found (/usr/bin/swiftc, xcrun) — install Xcode Command Line Tools",
      );
    }
    try {
      execFileSync(compiler.argv0, [...compiler.prefixArgs, "-O", "-o", staging, RENDER_HELPER_SOURCE], {
        encoding: "utf8",
        timeout: 300_000,
        env: { ...renderEnv(scratch), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      const err = error as NodeJS.ErrnoException & { stderr?: string };
      const detail = typeof err.stderr === "string" && err.stderr.trim().length > 0
        ? err.stderr.trim().split("\n").slice(-3).join(" | ")
        : err.message;
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `swiftc failed to build render-helper: ${detail}`,
      );
    }
    let version: string;
    try {
      version = selfcheckVersion(staging);
    } catch (error) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `fresh render-helper failed selfcheck: ${(error as Error).message}`,
      );
    }
    let swiftcVersion = "unknown";
    try {
      const out = execFileSync(compiler.argv0, [...compiler.prefixArgs, "--version"], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      swiftcVersion = out.split("\n")[0]?.trim() ?? "unknown";
    } catch {
      // informational only — provisioning succeeds without it.
    }

    const helperBytes = readFileSync(staging);
    const manifest: RendererManifest = {
      schemaVersion: 1,
      helper: "bin/render-helper",
      helperSha256: sha256Hex(helperBytes),
      version,
      swiftcVersion,
      provisionedAt: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
    };
    // Atomic-ish: move the verified binary into place, then write the
    // manifest. A crash between them leaves a helper without a manifest —
    // loadRenderer() treats that as unavailable (fail closed).
    writeFileSync(helperPath, helperBytes, { mode: 0o755 });
    rmSync(staging, { force: true });
    const manifestPath = renderManifestPath(repoRoot);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(manifestPath, manifestBytes);
    return {
      manifestPath,
      manifest,
      manifestSha256: sha256Hex(manifestBytes),
      helperPath,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(staging, { force: true });
  }
}

/**
 * Load + integrity-verify the provisioned renderer. Returns null when nothing
 * is provisioned; throws RUNTIME_UNAVAILABLE when the manifest/helper disagree
 * (tamper or partial provision) — callers never get a soft "maybe".
 */
export function loadRenderer(repoRoot: string): LoadedRenderer | null {
  const manifestPath = renderManifestPath(repoRoot);
  if (!existsSync(manifestPath)) return null;
  let manifest: RendererManifest;
  let manifestBytes: Buffer;
  try {
    manifestBytes = readFileSync(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8")) as RendererManifest;
  } catch {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `renderer manifest unreadable at ${manifestPath}`,
    );
  }
  if (manifest.schemaVersion !== 1 || typeof manifest.helper !== "string") {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `renderer manifest at ${manifestPath} has an unsupported shape`,
    );
  }
  const helperPath = join(renderDir(repoRoot), manifest.helper);
  if (!existsSync(helperPath)) {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `render-helper missing at ${helperPath} — run 'latexwb provision-renderer'`,
    );
  }
  const actual = sha256Hex(readFileSync(helperPath));
  if (actual !== manifest.helperSha256) {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `render-helper sha256 mismatch: manifest pins ${manifest.helperSha256}, binary is ${actual} — re-run 'latexwb provision-renderer'`,
    );
  }
  return {
    manifestPath,
    manifest,
    manifestSha256: sha256Hex(manifestBytes),
    helperPath,
  };
}

export interface RenderOptions {
  /** Wall-clock ceiling; defaults to 60s. */
  timeoutMs?: number;
  /** Output capture ceiling; defaults to 64 MiB. */
  maxOutputBytes?: number;
  signal?: AbortSignal | undefined;
}

/**
 * Run the helper against `pdfPath`. Output lands under `outDir`
 * (render.json + page-N.png). Any nonzero exit becomes a WorkbenchError with
 * the helper's stderr tail — malformed PDFs are INVALID_ARTIFACT, timeouts
 * are BUILD_TIMEOUT, and nothing partial is returned.
 */
export async function renderPdf(
  repoRoot: string,
  pdfPath: string,
  outDir: string,
  mode: RenderMode,
  dpi: number,
  options: RenderOptions = {},
): Promise<RenderedPdf> {
  const renderer = loadRenderer(repoRoot);
  if (renderer === null) {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      "render-helper not provisioned — run 'latexwb provision-renderer'",
    );
  }
  if (!existsSync(pdfPath)) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `PDF not found: ${pdfPath}`);
  }
  mkdirSync(outDir, { recursive: true });
  const outcome = await spawnCapture({
    argv: [renderer.helperPath, resolve(pdfPath), mode, resolve(outDir), String(dpi)],
    cwd: outDir,
    env: renderEnv(outDir),
    stdoutPath: join(outDir, "helper-stdout.log"),
    stderrPath: join(outDir, "helper-stderr.log"),
    limits: {
      wallClockMs: options.timeoutMs ?? 60_000,
      maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
    },
    signal: options.signal,
  });
  if (outcome.timedOut || outcome.killedBy === "timeout") {
    throw new WorkbenchError(
      ERROR_CODES.BUILD_TIMEOUT,
      `render-helper timed out after ${outcome.durationMs}ms on ${pdfPath}`,
    );
  }
  if (outcome.exitCode !== 0) {
    let tail = "";
    try {
      tail = readFileSync(outcome.stderrPath, "utf8").trim().split("\n").slice(-3).join(" | ");
    } catch {
      tail = "stderr unavailable";
    }
    throw new WorkbenchError(
      outcome.exitCode === 2 ? ERROR_CODES.INVALID_ARTIFACT : ERROR_CODES.RUNTIME_UNAVAILABLE,
      `render-helper exited ${outcome.exitCode ?? "signal"}: ${tail || "no stderr"}`,
    );
  }
  const manifestPath = join(outDir, "render.json");
  let parsed: RenderedPdf;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as RenderedPdf;
  } catch {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `render-helper exited 0 but wrote no parseable render.json under ${outDir}`,
    );
  }
  if (typeof parsed.pageCount !== "number" || !Array.isArray(parsed.pages)) {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      "render-helper render.json is missing pageCount/pages",
    );
  }
  return parsed;
}
