/**
 * Runner abstraction (M1): a Runner executes a build against a materialized
 * snapshot directory and reports PROCESS-level facts — exit code, duration,
 * how it was killed, where outputs landed. It does not interpret TeX
 * semantics; compiled vs compile-failed is decided by the build service from
 * logs and artifact validation.
 */
import type { BuildPreset } from "@latexwb/contracts";

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type BibliographyMode = "none" | "bibtex" | "biber" | "provided-bbl";

export interface RunnerCapabilities {
  runnerId: string;
  engines: Engine[];
  bibliographyModes: BibliographyMode[];
  isolation: "none" | "process" | "container";
  network: "host" | "none";
  enforces: {
    wallClock: boolean;
    cpu: boolean;
    memory: boolean;
    pids: boolean;
    diskQuota: boolean;
  };
  supportsSynctex: boolean;
  supportsRecorderFls: boolean;
  /** Real digest of the toolchain the runner will use — never a placeholder. */
  toolchainDigest: string;
}

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProbeReport {
  runnerId: string;
  available: boolean;
  checks: ProbeCheck[];
}

export interface BuildRequest {
  jobId: string;
  /** Directory containing the materialized snapshot files. */
  workDir: string;
  /** Root .tex entry path relative to workDir. */
  entryFile: string;
  engine: Engine;
  bibliographyMode: BibliographyMode;
  /** Job-private output directory the runner may write to. */
  outputDir: string;
  /** Job-private scratch dir (becomes TMPDIR/HOME for the child). */
  scratchDir: string;
  preset: BuildPreset;
  /** Aborted by the job layer for user cancellation. */
  signal?: AbortSignal;
  /**
   * Pinned build clock (Unix seconds) → SOURCE_DATE_EPOCH, which drives both
   * the PDF metadata dates and TeX's \today. Callers derive it from the
   * snapshot content so identical inputs rebuild byte-identically while a
   * draft still shows a real date; absent = 0 (the epoch).
   */
  sourceDateEpoch?: number;
}

/** SOURCE_DATE_EPOCH value for a request: a non-negative integer string. */
export function sourceDateEpochOf(req: Pick<BuildRequest, "sourceDateEpoch">): string {
  const v = req.sourceDateEpoch;
  return v !== undefined && Number.isSafeInteger(v) && v >= 0 ? String(v) : "0";
}

export interface RunnerResult {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  killedBy: "cancel" | "timeout" | "oom" | null;
  /** true when the output-byte cap forced termination (a resource limit, not a timeout). */
  outputTruncated: boolean;
  outputDir: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface Runner {
  capabilities(): RunnerCapabilities;
  probe(): Promise<ProbeReport>;
  run(req: BuildRequest): Promise<RunnerResult>;
  /**
   * Absolute path prefixes the engine legitimately reads OUTSIDE the job
   * directories (e.g. the tectonic bundle dir). Used to audit the deps
   * manifest: any recorded read outside job dirs + these roots means the
   * source escaped its boundary (e.g. `\input{/etc/hosts}`).
   * Return null when the question is not applicable — container-isolated
   * runners confine reads at the kernel boundary instead.
   */
  dependencyReadRoots?(req: BuildRequest): string[] | null;
}
