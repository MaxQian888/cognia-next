/**
 * The plugin contract's share of `lib/jobs/background-jobs.ts`, which re-exports these.
 */
export type BackgroundMonitorCondition =
  | { kind: "jobExit"; jobId: string }
  | { kind: "jobOutput"; jobId: string; pattern: string }
  | {
      kind: "shellPredicate"
      command: string
      program: string
      args: string[]
      cwd: string
      env?: Record<string, string>
      intervalMs?: number
    }
  | { kind: "upstream"; source: string; id: string }
