/**
 * Spawn a child with a sanitized environment, streamed stdout/stderr capture
 * to files, a real wall-clock deadline, and process-group termination. This
 * is the only child-process boundary in the runtime: argv is supplied fully
 * resolved by the caller and env is an explicit allowlist map — nothing is
 * inherited from process.env unless the caller put it there.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface SpawnLimits {
  wallClockMs: number;
  /** SIGTERM grace period before SIGKILL. */
  killGraceMs?: number;
  /** Kill the process when its captured output exceeds this many bytes. */
  maxOutputBytes?: number;
}

export interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  killedBy: "cancel" | "timeout" | null;
  stdoutPath: string;
  stderrPath: string;
  /** true when maxOutputBytes forced the kill. */
  outputTruncated: boolean;
}

function killTree(pid: number, sig: NodeJS.Signals): void {
  // The child was spawned detached => its pid is a process-group id on POSIX.
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

export function spawnCapture(options: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  limits: SpawnLimits;
  signal?: AbortSignal | undefined;
}): Promise<SpawnOutcome> {
  const { argv, cwd, env, stdoutPath, stderrPath, limits } = options;
  mkdirSync(dirname(stdoutPath), { recursive: true });
  mkdirSync(dirname(stderrPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedBy: "cancel" | "timeout" | null = null;
    let timedOut = false;
    let outputTruncated = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error(`failed to spawn ${argv[0]}`));
      return;
    }

    const stdoutStream: WriteStream = createWriteStream(stdoutPath);
    const stderrStream: WriteStream = createWriteStream(stderrPath);
    const onOutputCap = (): void => {
      // Output ceiling breached — a resource limit, NOT a wall-clock timeout:
      // killedBy stays null and outputTruncated carries the real reason.
      outputTruncated = true;
      killTree(pid, "SIGTERM");
      forceKillTimer = setTimeout(() => killTree(pid, "SIGKILL"), limits.killGraceMs ?? 2000);
      forceKillTimer.unref();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (!outputTruncated && limits.maxOutputBytes !== undefined &&
          stdoutBytes + stderrBytes > limits.maxOutputBytes) {
        onOutputCap();
      }
      stdoutStream.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (!outputTruncated && limits.maxOutputBytes !== undefined &&
          stdoutBytes + stderrBytes > limits.maxOutputBytes) {
        onOutputCap();
      }
      stderrStream.write(chunk);
    });

    const deadline = setTimeout(() => {
      timedOut = true;
      killedBy = "timeout";
      killTree(pid, "SIGTERM");
      forceKillTimer = setTimeout(() => killTree(pid, "SIGKILL"), limits.killGraceMs ?? 2000);
      forceKillTimer.unref();
    }, limits.wallClockMs);
    deadline.unref();

    const onAbort = (): void => {
      if (settled) return;
      killedBy = "cancel";
      killTree(pid, "SIGTERM");
      forceKillTimer = setTimeout(() => killTree(pid, "SIGKILL"), limits.killGraceMs ?? 2000);
      forceKillTimer.unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      stdoutStream.end();
      stderrStream.end();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceKillTimer !== null) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      stdoutStream.end();
      stderrStream.end();
      resolve({
        exitCode: code,
        signal,
        durationMs: Date.now() - startedAt,
        timedOut,
        killedBy,
        stdoutPath,
        stderrPath,
        outputTruncated,
      });
    });
  });
}
