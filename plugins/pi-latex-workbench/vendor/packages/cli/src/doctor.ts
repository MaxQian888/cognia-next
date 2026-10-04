import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDoctorReportFull, type DoctorOptionsFull } from "@latexwb/runtime";
import { validators, type DoctorReport } from "@latexwb/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

export function defaultDoctorOptions(): DoctorOptionsFull {
  return {
    repoRoot,
    hostPolicyPath: join(repoRoot, "runtime/host-policy.json"),
    toolchainLockPath: join(repoRoot, "runtime/toolchain-lock.json"),
  };
}

export async function runDoctor(options: DoctorOptionsFull = {}): Promise<{
  report: DoctorReport;
  exitCode: number;
}> {
  const report = await buildDoctorReportFull({ ...defaultDoctorOptions(), ...options });
  // The report itself must satisfy the contract schema before we emit it.
  validators.DoctorReport(report);
  return { report, exitCode: report.blockingCodes.length === 0 ? 0 : 2 };
}
