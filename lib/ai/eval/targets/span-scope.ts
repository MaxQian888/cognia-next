/**
 * Run-scoped trace id for eval targets that span multiple sessions (team /
 * workflow). The target threads this id into the run so every emitted
 * `agentTraces` span shares it, then assembles the sample from
 * `queryByTrace(traceId)`. Chat targets don't need this — they read spans by
 * their single session id.
 */

let seq = 0

export function newEvalTraceId(): string {
  // Math.random() is unavailable in some sandboxes; combine time + a process
  // counter so concurrent runs within the same ms still differ.
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER
  return `evtrace_${Date.now().toString(36)}_${seq.toString(36)}`
}
