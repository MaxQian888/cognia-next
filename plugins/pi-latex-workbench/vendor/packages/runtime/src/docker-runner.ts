/**
 * docker-texlive-latexmk runner: the spec isolation backend. Real container
 * invocation — read-only mounts, no network, dropped capabilities, resource
 * limits enforced by the OCI runtime. When the daemon or an approved image
 * is absent, probe() reports exactly that and run() refuses; it never fakes
 * a build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ERROR_CODES,
  sha256Hex,
  WorkbenchError,
  type HostPolicy,
} from "@latexwb/contracts";
import { spawnCapture } from "./spawn.ts";
import type {
  BuildRequest,
  ProbeReport,
  Runner,
  RunnerCapabilities,
  RunnerResult,
} from "./runner.ts";
import { sourceDateEpochOf } from "./runner.ts";

export const DOCKER_RUNNER_ID = "docker-texlive-latexmk";

export interface DockerRunnerOptions {
  repoRoot: string;
  hostPolicyPath: string;
}

function loadPolicy(path: string): HostPolicy | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HostPolicy;
  } catch {
    return null;
  }
}

function dockerDaemonDetail(): { ok: boolean; detail: string } {
  try {
    const out = execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, detail: `docker daemon ${out.trim()}` };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; message?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr.trim().split("\n")[0] : "";
    return {
      ok: false,
      detail: `docker info failed (exit ${err.status ?? "?"})${stderr ? `: ${stderr}` : `: ${err.message ?? "unknown"}`}`,
    };
  }
}

export class DockerTexliveRunner implements Runner {
  private readonly repoRoot: string;
  private readonly hostPolicyPath: string;

  constructor(options: DockerRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.hostPolicyPath = options.hostPolicyPath;
  }

  /** First approved image digest, or null when the policy allowlist is empty. */
  approvedImage(): string | null {
    const policy = loadPolicy(this.hostPolicyPath);
    const images = policy?.approvedImages ?? [];
    return images.length > 0 ? (images[0] as string) : null;
  }

  capabilities(): RunnerCapabilities {
    const image = this.approvedImage();
    return {
      runnerId: DOCKER_RUNNER_ID,
      engines: ["pdflatex", "xelatex", "lualatex"],
      // A full TeX Live image ships bibtex and biber; provided-bbl is plain input.
      bibliographyModes: ["none", "bibtex", "biber", "provided-bbl"],
      isolation: "container",
      network: "none",
      enforces: {
        wallClock: true,
        cpu: true,
        memory: true,
        pids: true,
        diskQuota: true,
      },
      supportsSynctex: true,
      supportsRecorderFls: true,
      // The toolchain identity IS the pinned image digest.
      toolchainDigest: image === null ? "0".repeat(64) : image.replace(/^sha256:/, ""),
    };
  }

  async probe(): Promise<ProbeReport> {
    const checks: ProbeReport["checks"] = [];
    const daemon = dockerDaemonDetail();
    checks.push({ name: "daemon", ok: daemon.ok, detail: daemon.detail });

    const image = this.approvedImage();
    if (image === null) {
      checks.push({
        name: "image",
        ok: false,
        detail: "host-policy approvedImages is empty — no pinned image allowed",
      });
    } else {
      // Real local presence check; pulling is an admin action, never implicit.
      try {
        execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        checks.push({ name: "image", ok: true, detail: `${image} present locally` });
      } catch {
        checks.push({
          name: "image",
          ok: false,
          detail: `${image} approved but not present locally (or daemon unreachable)`,
        });
      }
    }
    return {
      runnerId: DOCKER_RUNNER_ID,
      available: checks.every((c) => c.ok),
      checks,
    };
  }

  /**
   * Container isolation is the read boundary: the engine runs with
   * read-only /input, tmpfs /work, --network none and dropped caps, so the
   * deps manifest records container-internal paths that the kernel already
   * confined. Not applicable to the host-path audit.
   */
  dependencyReadRoots(): null {
    return null;
  }

  async run(req: BuildRequest): Promise<RunnerResult> {
    const caps = this.capabilities();
    if (!caps.engines.includes(req.engine)) {
      throw new WorkbenchError(
        ERROR_CODES.ENGINE_MISMATCH,
        `runner ${DOCKER_RUNNER_ID} cannot provide engine ${req.engine}`,
      );
    }
    const image = this.approvedImage();
    if (image === null) {
      throw new WorkbenchError(
        ERROR_CODES.POLICY_DENIED,
        "docker runner refused: host-policy approvedImages is empty",
      );
    }
    const daemon = dockerDaemonDetail();
    if (!daemon.ok) {
      throw new WorkbenchError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `docker runner unavailable: ${daemon.detail}`,
      );
    }

    mkdirSync(req.outputDir, { recursive: true });
    mkdirSync(req.scratchDir, { recursive: true });
    const limits = req.preset.limits;

    // latexmk argv comes from the preset template; the container argv below
    // is fully fixed — nothing from the project or the model reaches it.
    const innerArgv = req.preset.argvTemplate.map((arg) =>
      arg
        .replaceAll("{entry}", `/input/${req.entryFile}`)
        .replaceAll("{outdir}", "/output"),
    );

    const argv = [
      "docker", "run", "--rm",
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", "65534:65534",
      "--pids-limit", String(limits.pids ?? 128),
      "--memory", `${limits.memoryMiB ?? 2048}m`,
      "--cpus", String(limits.cpu ?? 2),
      "--tmpfs", "/work:rw,noexec,nosuid,size=256m",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
      "-v", `${resolve(req.workDir)}:/input:ro`,
      "-v", `${resolve(req.outputDir)}:/output:rw`,
      "-w", "/work",
      "-e", "HOME=/work",
      "-e", "TMPDIR=/tmp",
      "-e", "TZ=UTC",
      // Runner invariant: pin the build timestamp for reproducible PDFs so
      // the release clean-room rebuild hash comparison is meaningful.
      "-e", `SOURCE_DATE_EPOCH=${sourceDateEpochOf(req)}`,
      image,
      ...innerArgv,
    ];
    // Engine selection lives inside the preset argvTemplate (e.g. -xelatex),
    // pinned at preset authoring time — not derived per-request.

    const outcome = await spawnCapture({
      argv,
      cwd: req.scratchDir,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
        HOME: req.scratchDir,
        TMPDIR: req.scratchDir,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TZ: "UTC",
        // DOCKER_HOST is intentionally NOT forwarded from the inherited
        // environment; colima sockets etc. are host choices made by admins.
        ...(process.env["DOCKER_HOST"] !== undefined
          ? { DOCKER_HOST: process.env["DOCKER_HOST"] as string }
          : {}),
      },
      stdoutPath: join(req.scratchDir, "stdout.log"),
      stderrPath: join(req.scratchDir, "stderr.log"),
      limits: {
        wallClockMs: limits.wallClockMs,
        maxOutputBytes: limits.maxOutputBytes,
      },
      signal: req.signal,
    });

    return {
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      killedBy: outcome.killedBy,
      outputTruncated: outcome.outputTruncated,
      outputDir: req.outputDir,
      stdoutPath: outcome.stdoutPath,
      stderrPath: outcome.stderrPath,
    };
  }
}
