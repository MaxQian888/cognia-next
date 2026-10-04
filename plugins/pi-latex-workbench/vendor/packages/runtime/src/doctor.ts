/**
 * Environment probes behind `latexwb doctor` / latex_project.doctor.
 * Every check runs the real command/file access and reports what it actually
 * found; nothing is auto-installed and nothing reports a fake capability.
 *
 * Severity contract (what agents read):
 *   - error   — the host cannot do its job; the code is in blockingCodes and
 *               `latexwb doctor` exits 2. Every error diagnostic is blocking
 *               and every blocking code has an error diagnostic.
 *   - warning — a real capability gap on a working host (an optional backend
 *               is down, rendering is unprovisioned); report it, don't block.
 *   - info    — facts: build readiness, absent optional tooling.
 * Build readiness is decided by the runners' own probes: once one build
 * runner is available, the other backends are optional.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { sha256Hex, type Diagnostic, type DoctorReport } from "@latexwb/contracts";
import { createRunners, loadPresets } from "./presets.ts";
import { loadRenderer } from "./render.ts";

export const ADAPTER_VERSION = "0.0.0";
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

interface ProbeResult {
  available: boolean;
  detail: string;
}

function probeCommand(command: string, args: string[], timeoutMs = 10_000): ProbeResult {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const firstLine = stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
    return { available: true, detail: firstLine.trim() };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; status?: number };
    if (err.code === "ENOENT") {
      return { available: false, detail: `${command}: command not found (ENOENT)` };
    }
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    const summary = stderr.split("\n").find((l) => l.trim().length > 0) ?? err.message;
    return {
      available: false,
      detail: `${command} exited ${err.status ?? "?"}: ${summary}`,
    };
  }
}

function probeSqlite(): ProbeResult {
  try {
    const require = createRequire(import.meta.url);
    require("node:sqlite");
    return { available: true, detail: "node:sqlite DatabaseSync available" };
  } catch (error) {
    return { available: false, detail: `node:sqlite unavailable: ${(error as Error).message}` };
  }
}

function sha256OfBinary(command: string): string | null {
  try {
    const which = execFileSync("which", [command], { encoding: "utf8" }).trim();
    if (which.length === 0) return null;
    const real = realpathSync(which);
    return sha256Hex(readFileSync(real));
  } catch {
    return null;
  }
}

export interface DoctorOptions {
  /** Path to host-policy.json (mode source). */
  hostPolicyPath?: string;
  /** Path to toolchain-lock.json. */
  toolchainLockPath?: string;
  /** Repo root used to locate the provisioned render-helper manifest. */
  repoRoot?: string;
}

interface RendererProbe extends ProbeResult {
  /**
   * "absent": never provisioned (or location unknown) — a host choice, e.g.
   * a non-macOS host. "broken": provisioned but unusable (manifest unreadable,
   * helper missing, sha256 mismatch) — a damaged install.
   */
  state: "ok" | "absent" | "broken";
}

function probeRenderer(repoRoot: string | undefined): RendererProbe {
  if (repoRoot === undefined) {
    return {
      available: false,
      state: "absent",
      detail: "repoRoot not supplied — renderer location unknown",
    };
  }
  try {
    const loaded = loadRenderer(repoRoot);
    if (loaded === null) {
      return {
        available: false,
        state: "absent",
        detail: "not provisioned — run 'latexwb provision-renderer'",
      };
    }
    return {
      available: true,
      state: "ok",
      detail: `${loaded.manifest.version} manifestSha256=${loaded.manifestSha256}`,
    };
  } catch (error) {
    return { available: false, state: "broken", detail: (error as Error).message };
  }
}

interface CapabilityEntry {
  name: string;
  available: boolean;
  detail: string;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface DoctorOptionsFull extends DoctorOptions {
  // repoRoot (inherited) is used both for runner construction and the
  // render-helper probe.
}

/** One registered build runner as its own probe() saw it. */
interface RunnerStatus {
  id: string;
  available: boolean;
  engines: string[];
  bibliographyModes: string[];
  isolation: string;
  /** Build presets (runtime/presets) that run on this runner. */
  presetIds: string[];
  /** Capability summary + every probe check — the capability-entry detail. */
  detail: string;
  /** Only the failed probe checks, for diagnostics. */
  failures: string;
}

function presetIdsByRunner(repoRoot: string): Map<string, string[]> {
  const byRunner = new Map<string, string[]>();
  try {
    for (const preset of loadPresets(join(repoRoot, "runtime", "presets"))) {
      byRunner.set(preset.runnerId, [...(byRunner.get(preset.runnerId) ?? []), preset.id]);
    }
  } catch {
    // An invalid preset file is a build-time CONFIG_INVALID, reported by the
    // build service; the doctor just omits the preset listing.
  }
  return byRunner;
}

/**
 * Full doctor: base probes plus a real probe() of every registered runner.
 * Runner results are added as `runner.<id>` capability entries; their detail
 * string summarizes each underlying check so a single report explains why a
 * backend is unavailable. Runner availability decides build readiness, which
 * in turn decides whether missing optional backends block.
 */
export async function buildDoctorReportFull(options: DoctorOptionsFull = {}): Promise<DoctorReport> {
  if (options.repoRoot === undefined || options.hostPolicyPath === undefined) {
    return assembleReport(options, null);
  }
  const runners = createRunners({
    repoRoot: options.repoRoot,
    hostPolicyPath: options.hostPolicyPath,
  });
  const presets = presetIdsByRunner(options.repoRoot);
  const statuses: RunnerStatus[] = [];
  for (const [id, runner] of runners) {
    const probe = await runner.probe();
    const caps = runner.capabilities();
    const capSummary =
      `engines=[${caps.engines.join(",")}] bib=[${caps.bibliographyModes.join(",")}] ` +
      `isolation=${caps.isolation} network=${caps.network} ` +
      `enforces=${Object.entries(caps.enforces).filter(([, v]) => v).map(([k]) => k).join(",") || "none"}`;
    statuses.push({
      id,
      available: probe.available,
      engines: [...caps.engines],
      bibliographyModes: [...caps.bibliographyModes],
      isolation: caps.isolation,
      presetIds: presets.get(id) ?? [],
      detail:
        `${capSummary}; probe: ` +
        probe.checks.map((c) => `${c.name}=${c.ok ? "ok" : c.detail}`).join("; "),
      failures: probe.checks.filter((c) => !c.ok).map((c) => `${c.name}=${c.detail}`).join("; "),
    });
  }
  return assembleReport(options, statuses);
}

/**
 * Base probes only. Runners are NOT probed here, so no build path is
 * confirmed: the report blocks with NO_BUILD_RUNNER and keeps the optional
 * backends blocking. Use buildDoctorReportFull for a readiness verdict.
 */
export function buildDoctorReport(options: DoctorOptions = {}): DoctorReport {
  return assembleReport(options, null);
}

function diagnostic(code: string, severity: Diagnostic["severity"], message: string): Diagnostic {
  return {
    code,
    severity,
    message,
    source: null,
    page: null,
    causeId: null,
    evidenceArtifactIds: [],
    rawLogRange: null,
    confidence: "certain",
  };
}

const listed = (values: string[]): string => `[${values.join(",")}]`;

/** @param runners probed runners, or null when runners were not probed. */
function assembleReport(options: DoctorOptions, runners: RunnerStatus[] | null): DoctorReport {
  const policy = options.hostPolicyPath ? readJsonFile(options.hostPolicyPath) : null;
  const lock = options.toolchainLockPath ? readJsonFile(options.toolchainLockPath) : null;

  const capabilities: CapabilityEntry[] = [];
  const blockingCodes: string[] = [];
  const diagnostics: Diagnostic[] = [];

  // Single choke point for the severity contract: error ⇔ blocking.
  const emit = (code: string, severity: Diagnostic["severity"], message: string): void => {
    if (severity === "error" && !blockingCodes.includes(code)) blockingCodes.push(code);
    diagnostics.push(diagnostic(code, severity, message));
  };
  const record = (name: string, probe: ProbeResult): void => {
    capabilities.push({ name, available: probe.available, detail: probe.detail });
  };

  const ready = (runners ?? []).filter((r) => r.available);
  const buildReady = ready.length > 0;
  const readyIds = ready.map((r) => r.id).join(", ");

  // ---- build readiness first: the one line an agent needs at a glance ------
  if (buildReady) {
    for (const r of ready) {
      emit(
        "BUILD_READY",
        "info",
        `runner ${r.id} available: engines=${listed(r.engines)} bibliography=${listed(r.bibliographyModes)}` +
          (r.presetIds.length > 0 ? ` presets=${listed(r.presetIds)}` : ""),
      );
    }
  } else {
    emit(
      "NO_BUILD_RUNNER",
      "error",
      runners === null
        ? "build runners were not probed (repoRoot/hostPolicyPath not supplied) — no build path is confirmed"
        : `no build runner is available — ${runners.map((r) => `${r.id}: ${r.failures || "probe failed"}`).join(" | ")}. ` +
            "Make local-tectonic available (tectonic 0.17 on PATH, then 'latexwb provision-toolchain' for the " +
            "offline bundle + lock), or start a docker daemon with an approved texlive image in host-policy approvedImages.",
    );
  }

  // ---- host basics: always blocking ----------------------------------------
  const required = (name: string, probe: ProbeResult, code: string): void => {
    record(name, probe);
    if (!probe.available) emit(code, "error", `${name}: ${probe.detail}`);
  };

  required("node", { available: true, detail: `node ${process.version}` }, "NODE_UNSUPPORTED");
  required("node:sqlite", probeSqlite(), "SQLITE_UNAVAILABLE");

  const pi = probeCommand("pi", ["--version"]);
  required("pi", pi, "PI_UNAVAILABLE");

  // The tectonic binary on PATH is what the local-tectonic runner executes;
  // its availability is judged by that runner's probe (binary/bundle/lock),
  // so this entry is a recorded fact (version + sha256), not a verdict.
  const tectonic = probeCommand("tectonic", ["--version"]);
  if (tectonic.available) {
    const digest = sha256OfBinary("tectonic");
    record("tectonic", {
      available: true,
      detail: digest === null ? tectonic.detail : `${tectonic.detail} sha256=${digest}`,
    });
  } else {
    record("tectonic", tectonic);
  }

  // ---- optional backends ----------------------------------------------------
  // latexmk and the OCI daemon only matter to the docker-texlive-latexmk
  // runner (which runs latexmk INSIDE its container image — host latexmk is
  // never executed). With a build runner available their absence is a fact
  // (info), not a fault; the runner-level warning below carries the actual
  // capability gap once instead of three times. With no runner available they
  // stay blocking errors, as ADR-0001 recorded: the host has no build path,
  // and every missing backend is one of the ways to get one.
  const optionalBackend = (name: string, probe: ProbeResult, code: string, role: string): void => {
    record(name, probe);
    if (probe.available) return;
    if (buildReady) {
      emit(code, "info", `${name}: ${probe.detail} — optional (${role}); builds use runner ${readyIds}`);
    } else {
      emit(code, "error", `${name}: ${probe.detail}`);
    }
  };
  optionalBackend(
    "latexmk",
    probeCommand("latexmk", ["--version"]),
    "LATEXMK_MISSING",
    "used only inside the docker-texlive-latexmk image",
  );
  // OCI isolation backend probe: docker CLI alone is not enough, the daemon
  // must answer `docker info` (colima/dockerd may be stopped).
  optionalBackend(
    "docker",
    probeCommand("docker", ["info", "--format", "{{.ServerVersion}}"]),
    "OCI_UNAVAILABLE",
    "docker-texlive-latexmk isolation backend",
  );

  // python3 runs only the developer generators (scripts/generate-*.py):
  // nothing in import/build/patch/check/render/release needs it.
  {
    const py = probeCommand("python3", ["--version"]);
    record("python3", py);
    if (!py.available) {
      emit("PYTHON_MISSING", "warning", `python3: ${py.detail} — needed only to regenerate contract types / command vocabulary (dev scripts)`);
    }
  }

  // ---- M4 renderer: the provisioned Swift/PDFKit helper ---------------------
  // Builds never use it: compile, diagnostics, patches and checks that read
  // sources all work without it. Without it latex_render fails, the
  // render-dependent release checks (text-extraction, page-dimensions,
  // font-coverage, baseline-compare, pdf-side answer-isolation) report
  // unsupported/needs-review, and a release that requires page review stays
  // blocked by its OWN gate (review.no-rendered-pages) — the release reports
  // that itself. Rendering is also macOS-arm64-only, so "not provisioned" is
  // a legitimate host state: warning. A PROVISIONED helper that fails
  // verification (unreadable manifest, missing binary, sha256 mismatch) is a
  // damaged install that must be re-provisioned: that stays blocking.
  const renderer = probeRenderer(options.repoRoot);
  record("render-helper.swift-pdfkit", renderer);
  if (renderer.state === "absent") {
    emit(
      "RENDERER_UNAVAILABLE",
      "warning",
      `render-helper.swift-pdfkit: ${renderer.detail} — builds are unaffected; latex_render and ` +
        "render-dependent checks (text-extraction, page-dimensions, font-coverage, visual review) are unavailable",
    );
  } else if (renderer.state === "broken") {
    emit("RENDERER_UNAVAILABLE", "error", `render-helper.swift-pdfkit: ${renderer.detail}`);
  }

  const toolchainDigest =
    lock !== null && typeof lock["toolchainDigest"] === "string"
      ? (lock["toolchainDigest"] as string)
      : null;
  const toolchainResolved = lock !== null && lock["status"] === "resolved" && toolchainDigest !== null;
  required(
    "toolchain-resolved",
    toolchainResolved
      ? { available: true, detail: `toolchainDigest=${toolchainDigest}` }
      : {
          available: false,
          detail:
            lock === null
              ? "toolchain-lock.json unreadable or absent"
              : `toolchain-lock.json status=${String(lock["status"])} toolchainDigest=null`,
        },
    "TOOLCHAIN_UNRESOLVED",
  );

  // ---- runners ---------------------------------------------------------------
  for (const r of runners ?? []) {
    capabilities.push({ name: `runner.${r.id}`, available: r.available, detail: r.detail });
    // With no runner available, NO_BUILD_RUNNER (above) already carries every
    // runner's failed checks as the blocking error.
    if (r.available || !buildReady) continue;
    // Warning, not info: an unavailable runner on a working host is a real
    // capability gap — targets needing what only it provides (other engines,
    // biber, container isolation, or its presets) fail at build time with
    // ENGINE_MISMATCH/CONFIG_INVALID/RUNTIME_UNAVAILABLE. Not an error:
    // targets on the available runner build fine, so nothing is blocked.
    const coveredEngines = new Set(ready.flatMap((x) => x.engines));
    const coveredBib = new Set(ready.flatMap((x) => x.bibliographyModes));
    const gap = [
      ...(r.engines.some((e) => !coveredEngines.has(e))
        ? [`engines=${listed(r.engines.filter((e) => !coveredEngines.has(e)))}`]
        : []),
      ...(r.bibliographyModes.some((b) => !coveredBib.has(b))
        ? [`bibliography=${listed(r.bibliographyModes.filter((b) => !coveredBib.has(b)))}`]
        : []),
      ...(ready.every((x) => x.isolation !== r.isolation) ? [`isolation=${r.isolation}`] : []),
      ...(r.presetIds.length > 0 ? [`presets=${listed(r.presetIds)}`] : []),
    ];
    emit(
      "RUNTIME_UNAVAILABLE",
      "warning",
      `runner ${r.id} unavailable (optional backend; builds use runner ${readyIds})` +
        (gap.length > 0 ? ` — unavailable here: ${gap.join(" ")}` : "") +
        `; probe: ${r.failures || "probe failed"}`,
    );
  }

  return {
    kind: "doctor",
    mode: policy !== null && policy["mode"] === "trusted-local" ? "trusted-local" : "isolated-sdk",
    piPackageName: pi.available ? PI_PACKAGE_NAME : null,
    piVersion: pi.available ? pi.detail.replace(/^pi\s+/i, "") : null,
    adapterVersion: ADAPTER_VERSION,
    toolchainDigest,
    capabilities,
    blockingCodes,
    diagnostics,
  };
}
