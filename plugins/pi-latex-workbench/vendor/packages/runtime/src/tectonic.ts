/**
 * local-tectonic runner (M1 default): runs the provisioned tectonic binary
 * directly on the host — NO isolation beyond a sanitized environment and a
 * wall-clock deadline. Capabilities state this honestly: cpu/memory/pids/
 * diskQuota enforcement are all false; nothing here pretends ulimit or a
 * private TMPDIR is a quota.
 *
 * Network is always "none": argv carries `-b <local bundle dir>
 * --only-cached`, so the child reads resource files only from the extracted
 * provisioned bundle. Missing inputs surface as nonzero exit + MISSING_*
 * diagnostics parsed by the build service — never a silent download.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ERROR_CODES,
  sha256Hex,
  WorkbenchError,
} from "@latexwb/contracts";
import { spawnCapture } from "./spawn.ts";
import { loadToolchain, tectonicBinary } from "./toolchain.ts";
import type {
  BuildRequest,
  ProbeReport,
  Runner,
  RunnerCapabilities,
  RunnerResult,
} from "./runner.ts";
import { sourceDateEpochOf } from "./runner.ts";

export const TECTONIC_RUNNER_ID = "local-tectonic";

export interface TectonicRunnerOptions {
  repoRoot: string;
  /** Injectable for tests; defaults to the real binary lookup. */
  binaryPath?: string;
}

function substituteArgv(template: string[], vars: Record<string, string>): string[] {
  return template.map((arg) =>
    arg.replace(/\{(entry|outdir)\}/g, (_, name: string) => {
      const value = vars[name];
      if (value === undefined) {
        throw new WorkbenchError(ERROR_CODES.CONFIG_INVALID, `unknown argv placeholder {${name}}`);
      }
      return value;
    }),
  );
}

export class TectonicRunner implements Runner {
  private readonly repoRoot: string;
  private readonly binaryPathOverride: string | undefined;
  private cachedDigest: string | null = null;

  constructor(options: TectonicRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.binaryPathOverride = options.binaryPath;
  }

  private binary(): { path: string; version: string; sha256: string } | null {
    if (this.binaryPathOverride !== undefined) {
      if (!existsSync(this.binaryPathOverride)) return null;
      return { path: this.binaryPathOverride, version: "unknown", sha256: "" };
    }
    return tectonicBinary();
  }

  private digest(): string {
    if (this.cachedDigest !== null) return this.cachedDigest;
    const toolchain = loadToolchain(this.repoRoot);
    if (toolchain.toolchainDigest !== null) {
      this.cachedDigest = toolchain.toolchainDigest;
      return this.cachedDigest;
    }
    // No resolved lock: derive nothing — capability digest must be real, so
    // fall back to the digest of the extracted manifest itself when present.
    const manifest = join(toolchain.bundleDir, "SHA256SUM");
    if (existsSync(manifest)) {
      this.cachedDigest = sha256Hex(readFileSync(manifest));
      return this.cachedDigest;
    }
    this.cachedDigest = "0".repeat(64); // unavailable toolchain: callers must check probe()
    return this.cachedDigest;
  }

  capabilities(): RunnerCapabilities {
    return {
      runnerId: TECTONIC_RUNNER_ID,
      engines: ["xelatex"],
      // Empirically verified on tectonic 0.17: it runs its built-in BibTeX
      // pass when the .aux demands it; .bbl pass-through works as ordinary
      // input. biber is not a tectonic capability and is NOT claimed.
      bibliographyModes: ["none", "bibtex", "provided-bbl"],
      isolation: "none",
      network: "none",
      enforces: {
        wallClock: true,
        cpu: false,
        memory: false,
        pids: false,
        diskQuota: false,
      },
      supportsSynctex: true,
      // tectonic has no -recorder/.fls; the dependency manifest comes from
      // --makefile-rules instead.
      supportsRecorderFls: false,
      toolchainDigest: this.digest(),
    };
  }

  async probe(): Promise<ProbeReport> {
    const checks: ProbeReport["checks"] = [];
    const binary = this.binary();
    checks.push(
      binary === null
        ? { name: "binary", ok: false, detail: "tectonic not found on PATH" }
        : {
            name: "binary",
            ok: true,
            detail: `${binary.path} ${binary.version} sha256=${binary.sha256 || "unverified"}`,
          },
    );

    const toolchain = loadToolchain(this.repoRoot);
    const manifestOk = existsSync(join(toolchain.bundleDir, "SHA256SUM"));
    checks.push({
      name: "bundle",
      ok: manifestOk,
      detail: manifestOk
        ? `extracted bundle at ${toolchain.bundleDir}`
        : `no extracted bundle at ${toolchain.bundleDir} — run 'latexwb provision-toolchain'`,
    });
    checks.push({
      name: "lock",
      ok: toolchain.resolved,
      detail: toolchain.resolved
        ? `toolchainDigest=${toolchain.toolchainDigest}`
        : `toolchain-lock status=${toolchain.lock?.status ?? "missing"}`,
    });
    return {
      runnerId: TECTONIC_RUNNER_ID,
      available: checks.every((c) => c.ok),
      checks,
    };
  }

  /**
   * Outside the job dirs the engine may legitimately read only the
   * provisioned bundle. Everything else recorded in deps.mk is a boundary
   * escape — `--untrusted`/`--only-cached` do NOT stop absolute-path
   * \input (verified: tectonic 0.17 opened /etc/passwd).
   */
  dependencyReadRoots(_req: BuildRequest): string[] {
    return [resolve(loadToolchain(this.repoRoot).bundleDir)];
  }

  async run(req: BuildRequest): Promise<RunnerResult> {
    const caps = this.capabilities();
    if (!caps.engines.includes(req.engine)) {
      throw new WorkbenchError(
        ERROR_CODES.ENGINE_MISMATCH,
        `runner ${TECTONIC_RUNNER_ID} provides engines [${caps.engines.join(",")}], requested ${req.engine}`,
      );
    }
    if (!caps.bibliographyModes.includes(req.bibliographyMode)) {
      throw new WorkbenchError(
        ERROR_CODES.CONFIG_INVALID,
        `runner ${TECTONIC_RUNNER_ID} does not support bibliographyMode=${req.bibliographyMode}`,
      );
    }
    const binary = this.binary();
    if (binary === null) {
      throw new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, "tectonic binary not found");
    }
    const toolchain = loadToolchain(this.repoRoot);
    if (!existsSync(join(toolchain.bundleDir, "SHA256SUM"))) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        "no provisioned bundle — run 'latexwb provision-toolchain'",
      );
    }

    mkdirSync(req.outputDir, { recursive: true });
    mkdirSync(req.scratchDir, { recursive: true });
    const homeDir = join(req.scratchDir, "home");
    const tmpDir = join(req.scratchDir, "tmp");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });

    // Environment built from the preset allowlist only — fixed values, no
    // inheritance. TEXINPUTS/TEXMF*/PERL*/PYTHON*/proxy/credential variables
    // are absent because they are not on the allowlist.
    const envValues: Record<string, string> = {
      PATH: `${dirname(binary.path)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: homeDir,
      TMPDIR: tmpDir,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
    };
    const env: Record<string, string> = {};
    for (const name of req.preset.envAllowlist) {
      const value = envValues[name];
      if (value === undefined) {
        throw new WorkbenchError(
          ERROR_CODES.CONFIG_INVALID,
          `preset envAllowlist names ${name} but the runner has no fixed value for it`,
        );
      }
      env[name] = value;
    }
    // Runner invariant (not preset-negotiated): pin the build timestamp so
    // tectonic emits byte-identical PDFs for identical inputs — required for
    // the release clean-room rebuild hash comparison. Tectonic honors
    // SOURCE_DATE_EPOCH for PDF CreationDate/ID and \today; the caller
    // derives it from the snapshot (0 = the epoch when not supplied).
    env["SOURCE_DATE_EPOCH"] = sourceDateEpochOf(req);

    const argv = substituteArgv(req.preset.argvTemplate, {
      entry: req.entryFile,
      outdir: resolve(req.outputDir),
    });
    // argv[0] in the template is the literal program name; substitute the
    // resolved binary so PATH games cannot swap it. The bundle path is a
    // runner-controlled value injected by the runner — presets may only use
    // {entry}/{outdir}, so `-b <bundleDir>` is inserted here, never templated.
    argv[0] = binary.path;
    const compileIdx = argv.indexOf("compile");
    argv.splice(compileIdx === -1 ? argv.length : compileIdx + 1, 0, "-b", resolve(toolchain.bundleDir));

    const outcome = await spawnCapture({
      argv,
      cwd: req.workDir,
      env,
      stdoutPath: join(req.scratchDir, "stdout.log"),
      stderrPath: join(req.scratchDir, "stderr.log"),
      limits: {
        wallClockMs: req.preset.limits.wallClockMs,
        maxOutputBytes: req.preset.limits.maxOutputBytes,
      },
      signal: req.signal,
    });

    return {
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      // Local runner has no memory enforcement, so nothing here can honestly
      // report "oom".
      killedBy: outcome.killedBy,
      outputTruncated: outcome.outputTruncated,
      outputDir: req.outputDir,
      stdoutPath: outcome.stdoutPath,
      stderrPath: outcome.stderrPath,
    };
  }
}
