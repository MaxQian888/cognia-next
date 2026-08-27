import test from "node:test"
import assert from "node:assert/strict"

import { STATUS } from "./diagnose.mjs"
import { LockHeldError } from "./lock.mjs"
import { PLATFORM_FIELDS } from "./config.mjs"
import { main, parseArgs } from "./index.mjs"

function envFor(...platforms) {
  const env = {}
  for (const platform of platforms) {
    for (const spec of Object.values(PLATFORM_FIELDS[platform])) {
      if (spec.optional) continue
      env[spec.env] = `value-for-${spec.env}`
    }
  }
  return env
}

/** Deps that make `main` a pure orchestration test: no network, no disk. */
function deps(overrides = {}) {
  const out = { log: [], err: [] }
  const base = {
    argv: [],
    env: envFor("telegram"),
    log: (m) => out.log.push(m),
    logError: (m) => out.err.push(m),
    loadEnv: () => ({ loaded: false }),
    discover: async () => ({ baseUrl: "http://127.0.0.1:9", token: "t", source: "env" }),
    makeFixture: () => ({
      baseUrl: "http://127.0.0.1:9",
      probe: async () => ({ ok: true, count: 0 }),
    }),
    makeDriver: (platform) => ({
      platform,
      conversationId: `conv-${platform}`,
      doctor: async () => [{ name: "identity", ok: true, detail: "driver" }],
    }),
    runOne: async ({ report }) => report.finish(STATUS.PASS),
    writeReport: async ({ report }) =>
      `test-results/im-live/${report.runId}/${report.platform}.json`,
    lockImpl: () => ({ file: "lock", stoleFrom: null, release() {} }),
    makeRunId: () => "abcd1234",
  }
  return { out, args: { ...base, ...overrides } }
}

test("parseArgs defaults to every platform and no shortcuts", () => {
  assert.deepEqual(parseArgs([]), { platform: "all", allowUnconfigured: false, doctorOnly: false })
})

test("parseArgs accepts both --platform x and --platform=x", () => {
  assert.equal(parseArgs(["--platform", "slack"]).platform, "slack")
  assert.equal(parseArgs(["--platform=slack"]).platform, "slack")
})

test("parseArgs ignores the pnpm `--` separator", () => {
  assert.equal(parseArgs(["--", "--platform", "lark"]).platform, "lark")
})

test("parseArgs reads the two flags", () => {
  const args = parseArgs(["--allow-unconfigured", "--doctor"])
  assert.equal(args.allowUnconfigured, true)
  assert.equal(args.doctorOnly, true)
})

test("parseArgs rejects a typo instead of silently running everything", () => {
  assert.throws(() => parseArgs(["--platfrom", "slack"]), /unknown argument/)
  assert.throws(() => parseArgs(["--platform"]), /--platform needs a value/)
})

test("a clean single-platform run exits zero and names the evidence file", async () => {
  const { out, args } = deps({ argv: ["--platform", "telegram"] })
  assert.equal(await main(args), 0)
  assert.ok(
    out.log.some((l) => l.includes("telegram: PASS → test-results/im-live/abcd1234/telegram.json")),
    out.log
  )
  assert.ok(out.log.some((l) => l.includes("1 PASS")))
})

test("an unreachable fixture stops before any platform is touched", async () => {
  let madeDriver = false
  const { out, args } = deps({
    argv: ["--platform", "telegram"],
    makeFixture: () => ({
      baseUrl: "http://127.0.0.1:9",
      probe: async () => {
        throw new Error("connection refused")
      },
    }),
    makeDriver: () => {
      madeDriver = true
      return {}
    },
  })
  assert.equal(await main(args), 1)
  assert.equal(madeDriver, false)
  assert.ok(
    out.err.some((l) => l.includes("cannot continue without the deterministic model fixture"))
  )
})

test("`all` refuses to start when a platform is unconfigured", async () => {
  const { args } = deps({ argv: ["--platform", "all"] })
  await assert.rejects(main(args), /not configured/)
})

test("--allow-unconfigured runs the rest and reports the others as NOT_CONFIGURED", async () => {
  const { out, args } = deps({ argv: ["--platform", "all", "--allow-unconfigured"] })
  assert.equal(await main(args), 0, "an absent platform must not fail the run")
  assert.ok(out.log.some((l) => l.includes("slack: NOT_CONFIGURED")))
  assert.ok(out.log.some((l) => l.includes("IM_LIVE_SLACK_DRIVER_USER_TOKEN")))
  assert.ok(out.log.some((l) => l.includes("1 PASS, 4 NOT_CONFIGURED")))
})

test("--doctor prints the checks and never posts anything", async () => {
  let ran = false
  const { out, args } = deps({
    argv: ["--platform", "telegram", "--doctor"],
    runOne: async () => {
      ran = true
    },
  })
  assert.equal(await main(args), 0)
  assert.equal(ran, false)
  assert.ok(out.log.some((l) => l.includes("ok   identity")))
})

test("a failing doctor exits non-zero", async () => {
  const { args } = deps({
    argv: ["--platform", "telegram", "--doctor"],
    makeDriver: (platform) => ({
      platform,
      conversationId: "c",
      doctor: async () => [{ name: "privacy", ok: false, detail: "on" }],
    }),
  })
  assert.equal(await main(args), 1)
})

test("a held lock fails that platform and lets the others continue", async () => {
  const { out, args } = deps({
    argv: ["--platform", "all", "--allow-unconfigured"],
    env: envFor("telegram", "matrix"),
    lockImpl: ({ platform }) => {
      if (platform === "telegram")
        throw new LockHeldError("telegram/conv is already being driven by pid 7", { pid: 7 })
      return { file: "lock", stoleFrom: null, release() {} }
    },
  })
  assert.equal(await main(args), 1)
  assert.ok(out.err.some((l) => l.includes("already being driven by pid 7")))
  assert.ok(
    out.log.some((l) => l.includes("matrix: PASS")),
    "matrix must still run"
  )
})

test("the lock is released even when the run throws", async () => {
  let released = 0
  const { args } = deps({
    argv: ["--platform", "telegram"],
    lockImpl: () => ({ file: "lock", stoleFrom: null, release: () => released++ }),
    runOne: async () => {
      throw new Error("platform exploded")
    },
  })
  assert.equal(await main(args), 1)
  assert.equal(released, 1)
})

test("a thrown run is still written to an evidence file", async () => {
  const written = []
  const { out, args } = deps({
    argv: ["--platform", "telegram"],
    runOne: async () => {
      throw new Error("platform exploded")
    },
    writeReport: async ({ report }) => {
      written.push(report.toJSON())
      return "f.json"
    },
  })
  await main(args)
  assert.equal(written[0].status, STATUS.FAIL)
  assert.match(written[0].error, /platform exploded/)
  assert.ok(out.err.some((l) => l.includes("platform exploded")))
})

test("a stolen lock is announced so a concurrent run is not a mystery", async () => {
  const { out, args } = deps({
    argv: ["--platform", "telegram"],
    lockImpl: () => ({ file: "lock", stoleFrom: 4242, release() {} }),
  })
  await main(args)
  assert.ok(out.log.some((l) => l.includes("took over a stale lock from pid 4242")))
})

test("a failed turn's diagnosis reaches stderr", async () => {
  const { out, args } = deps({
    argv: ["--platform", "telegram"],
    runOne: async ({ report }) => {
      report.recordTurn({
        turn: 1,
        marker: "cognia-e2e:telegram:abcd1234:turn-1",
        probe: { messageId: "p" },
        fixtureHit: null,
        replies: [],
        diagnosis: {
          status: STATUS.TIMEOUT,
          summary: "nothing arrived",
          causes: [{ code: "sibling_identity_unknown", detail: "d", where: "bus.ts step 9.6" }],
          markerReplyCount: 0,
          extraReplyCount: 0,
        },
      })
      return report.finish(STATUS.TIMEOUT)
    },
  })
  assert.equal(await main(args), 1)
  assert.ok(out.err.some((l) => l.includes("[sibling_identity_unknown]")))
  assert.ok(out.err.some((l) => l.includes("bus.ts step 9.6")))
})

test("messages that could not be cleaned up are called out by id", async () => {
  const { out, args } = deps({
    argv: ["--platform", "telegram"],
    runOne: async ({ report }) => {
      report.recordCleanup({
        deleted: [],
        retained: [{ id: "m1", reason: "forbidden" }],
        ok: false,
      })
      return report.finish(STATUS.PASS)
    },
  })
  await main(args)
  assert.ok(out.err.some((l) => l.includes("delete them by hand: m1")))
})

test("secrets never reach the console", async () => {
  const { out, args } = deps({
    argv: ["--platform", "telegram"],
    runOne: async () => {
      throw new Error("auth failed for value-for-IM_LIVE_TELEGRAM_DRIVER_BOT_TOKEN")
    },
  })
  await main(args)
  const printed = [...out.log, ...out.err].join("\n")
  assert.ok(!printed.includes("value-for-IM_LIVE_TELEGRAM_DRIVER_BOT_TOKEN"), printed)
  assert.ok(printed.includes("«telegram.driverBotToken»"), printed)
})
