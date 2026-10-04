/**
 * Build-preset loading. Presets are administrator-owned configuration under
 * runtime/presets/: every file must validate against $defs/BuildPreset, and
 * the engine/bibliography claims are cross-checked against the runner's real
 * capabilities at selection time — a preset that overclaims is a config
 * error, not a silent downgrade.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertValid,
  ERROR_CODES,
  WorkbenchError,
  type BuildPreset,
} from "@latexwb/contracts";
import { TectonicRunner, TECTONIC_RUNNER_ID } from "./tectonic.ts";
import { DockerTexliveRunner, DOCKER_RUNNER_ID } from "./docker-runner.ts";
import type { Runner } from "./runner.ts";

export function loadPresets(presetsDir: string): BuildPreset[] {
  let files: string[];
  try {
    files = readdirSync(presetsDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const data = JSON.parse(readFileSync(join(presetsDir, f), "utf8")) as unknown;
    return assertValid<BuildPreset>("BuildPreset", data);
  });
}

export function loadPreset(presetsDir: string, presetId: string): BuildPreset {
  const preset = loadPresets(presetsDir).find((p) => p.id === presetId);
  if (preset === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `build preset ${presetId} not found in ${presetsDir}`,
    );
  }
  return preset;
}

export interface RunnerRegistryOptions {
  repoRoot: string;
  hostPolicyPath: string;
}

export function createRunners(options: RunnerRegistryOptions): Map<string, Runner> {
  const runners = new Map<string, Runner>();
  runners.set(TECTONIC_RUNNER_ID, new TectonicRunner({ repoRoot: options.repoRoot }));
  runners.set(
    DOCKER_RUNNER_ID,
    new DockerTexliveRunner({
      repoRoot: options.repoRoot,
      hostPolicyPath: options.hostPolicyPath,
    }),
  );
  return runners;
}

/**
 * Select a runner for a preset and verify the preset does not overclaim:
 * engine and bibliography mode must be inside the runner's real capability
 * set. Overclaim is a CONFIG_INVALID error — never a silent substitution.
 */
export function runnerForPreset(runners: Map<string, Runner>, preset: BuildPreset): Runner {
  const runner = runners.get(preset.runnerId);
  if (runner === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.CONFIG_INVALID,
      `preset ${preset.id} names unknown runnerId ${preset.runnerId}`,
    );
  }
  const caps = runner.capabilities();
  if (!caps.engines.includes(preset.engine)) {
    throw new WorkbenchError(
      ERROR_CODES.ENGINE_MISMATCH,
      `preset ${preset.id} requests engine ${preset.engine} but runner ${preset.runnerId} provides [${caps.engines.join(",")}]`,
    );
  }
  if (!caps.bibliographyModes.includes(preset.bibliographyMode)) {
    throw new WorkbenchError(
      ERROR_CODES.CONFIG_INVALID,
      `preset ${preset.id} requests bibliographyMode ${preset.bibliographyMode} but runner ${preset.runnerId} provides [${caps.bibliographyModes.join(",")}]`,
    );
  }
  return runner;
}
