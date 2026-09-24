/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node CommonJS harness */
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")
const { createRequire } = require("node:module")
const root = process.env.COGNIA_ROOT || process.cwd()
const dir = __dirname
const req = createRequire(path.join(root, "package.json"))
const { chromium } = req("@playwright/test")
const variants = ["baseline", "optimized"]
for (const variant of variants)
  execFileSync(process.execPath, [path.join(dir, "run.cjs"), variant, "--bundle-only"], {
    cwd: root,
    stdio: "inherit",
  })
const bundles = Object.fromEntries(
  variants.map((variant) => [
    variant,
    fs.readFileSync(path.join(dir, variant + ".bundle.js"), "utf8"),
  ])
)
const sha = (variant) =>
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(dir, variant + ".messages.ts.txt")))
    .digest("hex")
const frozen = JSON.parse(fs.readFileSync(path.join(dir, "optimized.json")))
if (sha("optimized") !== frozen.sourceSha256)
  throw Error("Product source differs from frozen final benchmark")
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2
}
const summary = (values) => {
  const medianMs = median(values)
  return {
    medianMs,
    madMs: median(values.map((value) => Math.abs(value - medianMs))),
    rawMs: values,
  }
}
;(async () => {
  const server = http.createServer((request, response) => {
    const variant = request.url.startsWith("/baseline") ? "baseline" : "optimized"
    response.setHeader(
      "Content-Type",
      request.url.endsWith(".js") ? "application/javascript" : "text/html"
    )
    response.end(
      request.url.endsWith(".js")
        ? bundles[variant]
        : '<!doctype html><script src="/' + variant + '.js"></script>'
    )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const browser = await chromium.launch({ headless: true })
  const contexts = {}
  const pages = {}
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    method:
      "One browser, two isolated contexts, alternating baseline/optimized AB then BA order each round; two warmups and30 measured pairs for each operation and fixture; same frozen production source as final independent run",
    warmup: 2,
    samples: 30,
    criterion:
      "Median improvement >=20% and absolute median difference >2*max(MAD baseline,MAD optimized), numerical epsilon1e-6ms",
    baselineSourceSha256: sha("baseline"),
    optimizedSourceSha256: sha("optimized"),
    scope: frozen.scope,
    workloads: [],
  }
  try {
    for (const variant of variants) {
      contexts[variant] = await browser.newContext()
      pages[variant] = await contexts[variant].newPage()
      await pages[variant].goto("http://127.0.0.1:" + server.address().port + "/" + variant)
      await pages[variant].waitForFunction(() => !!window.bench)
    }
    for (const count of [1000, 10000]) {
      for (const variant of variants)
        await pages[variant].evaluate((count) => window.bench.setup(count, true), count)
      const workload = { count, attachments: true, textBytesPerMessage: 2048, metrics: {} }
      for (const kind of ["streaming", "restore-recent"]) {
        const raw = { baseline: [], optimized: [] }
        const rounds = []
        for (let round = -2; round < 30; round++) {
          const order = round % 2 === 0 ? variants : [...variants].reverse()
          const result = { round, order }
          for (const variant of order) {
            const ms = await pages[variant].evaluate(
              ({ kind, round }) => window.bench.run(kind, round),
              { kind, round }
            )
            result[variant] = ms
            if (round >= 0) raw[variant].push(ms)
          }
          if (round >= 0) rounds.push(result)
        }
        const baseline = summary(raw.baseline),
          optimized = summary(raw.optimized)
        const differenceMs = baseline.medianMs - optimized.medianMs
        const improvementPercent = (100 * differenceMs) / baseline.medianMs
        const noise = 2 * Math.max(baseline.madMs, optimized.madMs)
        workload.metrics[kind] = {
          baseline,
          optimized,
          improvementPercent,
          practicalWin: improvementPercent >= 20 && differenceMs > noise + 1e-6,
          practicalRegression: improvementPercent <= -20 && -differenceMs > noise + 1e-6,
          pairedDifference: summary(rounds.map((item) => item.baseline - item.optimized)),
          rounds,
        }
      }
      workload.correctness = {}
      for (const variant of variants)
        workload.correctness[variant] = await pages[variant].evaluate(
          (count) => window.bench.verify(count, true),
          count
        )
      for (const variant of variants) delete workload.correctness[variant].lastText
      report.workloads.push(workload)
      console.log(
        JSON.stringify({
          count,
          metrics: Object.fromEntries(
            Object.entries(workload.metrics).map(([kind, value]) => [
              kind,
              {
                baselineMedianMs: value.baseline.medianMs,
                baselineMadMs: value.baseline.madMs,
                optimizedMedianMs: value.optimized.medianMs,
                optimizedMadMs: value.optimized.madMs,
                improvementPercent: value.improvementPercent,
                practicalWin: value.practicalWin,
                practicalRegression: value.practicalRegression,
                pairedMedianDifferenceMs: value.pairedDifference.medianMs,
              },
            ])
          ),
        })
      )
    }
    fs.writeFileSync(path.join(dir, "paired.json"), JSON.stringify(report, null, 2) + "\n")
    const rows = report.workloads.flatMap((item) =>
      Object.entries(item.metrics).map(
        ([kind, value]) =>
          `| ${item.count} | ${kind} | ${value.baseline.medianMs.toFixed(2)} ± ${value.baseline.madMs.toFixed(2)} | ${value.optimized.medianMs.toFixed(2)} ± ${value.optimized.madMs.toFixed(2)} | ${value.improvementPercent.toFixed(2)}% | ${value.practicalWin ? "PASS" : value.practicalRegression ? "REGRESSION" : "No threshold crossing"} |`
      )
    )
    fs.writeFileSync(
      path.join(dir, "paired.md"),
      [
        "# Paired follow-up measurement",
        "",
        report.method + ".",
        "",
        `Baseline source: \`${report.baselineSourceSha256}\`. Optimized source: \`${report.optimizedSourceSha256}\`.`,
        "",
        "| Rows | Operation | Baseline median ± MAD (ms) | Optimized median ± MAD (ms) | Improvement | Threshold |",
        "| ---: | --- | ---: | ---: | ---: | --- |",
        ...rows,
        "",
        "This follow-up was triggered by the original independent-run recent-80 read regression, which remains in comparison.md. Pairing controls experiment timing and workload conditions more closely, but is not proof of absence of regressions on other machines, concurrent workloads or whole-app paths. All30 pairs, AB/BA order and paired differences are retained in paired.json.",
        "",
      ].join("\n")
    )
  } finally {
    for (const context of Object.values(contexts)) await context.close()
    await browser.close()
    server.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
