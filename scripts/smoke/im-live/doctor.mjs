// Preflight.
//
// Everything checked here is something that would otherwise surface 120 seconds
// later as an unexplained silence: a driver that is really the target, a token
// with the wrong shape, a chat nobody joined, a fixture that is not running.
// The one thing doctor CANNOT see is the target app's own configuration —
// that lives in the desktop app's Dexie, out of reach of this process — which
// is why the run's diagnostic table exists alongside it.

import { STATUS } from "./diagnose.mjs"
import { FixtureUnavailableError } from "./fixture-client.mjs"

/** The model fixture is a precondition for every platform, so it is checked once. */
export async function checkFixture(fixture) {
  try {
    const probe = await fixture.probe()
    return {
      name: "model fixture reachable",
      ok: true,
      detail: `${fixture.baseUrl} (${probe.count} request(s) captured so far)`,
    }
  } catch (error) {
    return {
      name: "model fixture reachable",
      ok: false,
      detail:
        error instanceof FixtureUnavailableError
          ? error.message
          : `${fixture.baseUrl}: ${error?.message ?? error}`,
    }
  }
}

/** One platform's driver-side checks. */
export async function doctorPlatform({ platform, driver }) {
  let checks
  try {
    checks = await driver.doctor()
  } catch (error) {
    checks = [{ name: "driver reachable", ok: false, detail: error?.message ?? String(error) }]
  }
  const ok = checks.every((check) => check.ok)
  return { platform, status: ok ? STATUS.PASS : STATUS.DOCTOR_FAILED, checks }
}

/** Human-readable block for one platform. */
export function formatChecks(platform, checks) {
  const lines = [`  ${platform}:`]
  for (const check of checks) {
    lines.push(
      `    ${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`
    )
  }
  return lines.join("\n")
}
