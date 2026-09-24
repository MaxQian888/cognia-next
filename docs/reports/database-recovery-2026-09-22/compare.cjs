/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node CommonJS harness */
const fs = require("node:fs")
const path = require("node:path")
const before = JSON.parse(fs.readFileSync(path.join(__dirname, "baseline.json")))
const after = JSON.parse(fs.readFileSync(path.join(__dirname, "optimized.json")))
const rows = []
for (const workload of before.workloads) {
  const peer = after.workloads.find(
    (item) => item.count === workload.count && item.attachments === workload.attachments
  )
  for (const [kind, old] of Object.entries(workload.metrics)) {
    const next = peer.metrics[kind]
    const delta = old.medianMs - next.medianMs
    const changePercent = (100 * delta) / old.medianMs
    const noise = 2 * Math.max(old.madMs, next.madMs)
    rows.push({
      count: workload.count,
      attachments: workload.attachments,
      kind,
      beforeMedianMs: old.medianMs,
      beforeMadMs: old.madMs,
      afterMedianMs: next.medianMs,
      afterMadMs: next.madMs,
      improvementPercent: changePercent,
      practicalWin: changePercent >= 20 && delta > noise + 1e-6,
      practicalRegression: changePercent <= -20 && -delta > noise + 1e-6,
    })
  }
}
const round = (n) => n.toFixed(2)
const md =
  [
    "| Rows | Attachment refs | Operation | Before median ± MAD (ms) | After median ± MAD (ms) | Improvement | Threshold |",
    "| ---: | :---: | --- | ---: | ---: | ---: | --- |",
    ...rows.map(
      (row) =>
        `| ${row.count} | ${row.attachments ? "yes" : "no"} | ${row.kind} | ${round(row.beforeMedianMs)} ± ${round(row.beforeMadMs)} | ${round(row.afterMedianMs)} ± ${round(row.afterMadMs)} | ${round(row.improvementPercent)}% | ${row.practicalWin ? "PASS" : row.practicalRegression ? "REGRESSION" : "no conclusive win"} |`
    ),
  ].join("\n") + "\n"
fs.writeFileSync(
  path.join(__dirname, "comparison.json"),
  JSON.stringify(
    {
      criterion: before.criterion,
      beforeSource: before.sourceSha256,
      afterSource: after.sourceSha256,
      rows,
    },
    null,
    2
  ) + "\n"
)
fs.writeFileSync(path.join(__dirname, "comparison.md"), md)
console.log(md)
