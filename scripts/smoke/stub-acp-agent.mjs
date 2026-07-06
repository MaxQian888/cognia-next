#!/usr/bin/env node
/**
 * Stub ACP agent for the tier-2 compose smoke (ADR-0059 W6 / D6).
 *
 * A minimal stdio "agent": announces itself, echoes every stdin line back as
 * a JSON object, and exits cleanly on stdin EOF. Enough to prove the whole
 * headless external-agent plane — SpawnPolicy admission (only under
 * `COGNIA_SMOKE_AGENT=1`), ExecBackend spawn/send/kill, and the frozen
 * `external-agent://*` event stream — without any vendor credentials.
 *
 * Baked into the cognia-server image at /opt/cognia/smoke/stub-acp-agent.mjs.
 */
process.stdout.write(JSON.stringify({ type: "stub_ready", pid: process.pid }) + "\n")

process.stdin.setEncoding("utf8")
let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    process.stdout.write(JSON.stringify({ type: "stub_echo", line }) + "\n")
  }
})
process.stdin.on("end", () => process.exit(0))

// Never exit on our own — the smoke kills us explicitly.
setInterval(() => {}, 60_000)
