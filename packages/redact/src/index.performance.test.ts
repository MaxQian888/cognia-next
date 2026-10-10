import { Worker } from "node:worker_threads"
import { pathToFileURL } from "node:url"

// A regressed regex can block for minutes. Run the real module in a worker so
// the test can fail promptly instead of freezing the entire Jest process.
function measure(input: string): Promise<{
  scanMs: number
  redactMs: number
  normalizeMs: number
  clean: boolean
  unchanged: boolean
  roundTrip: boolean
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `import { parentPort, workerData } from "node:worker_threads";
       const { hasNoLeakingPii, normalizeForRedaction, redactText, unredactText } =
         await import(workerData.moduleUrl);
       let start = performance.now();
       const clean = hasNoLeakingPii(workerData.input);
       const scanMs = performance.now() - start;
       start = performance.now();
       const result = redactText(workerData.input);
       const redactMs = performance.now() - start;
       start = performance.now();
       normalizeForRedaction(workerData.input);
       const normalizeMs = performance.now() - start;
       parentPort.postMessage({ scanMs, redactMs, normalizeMs, clean,
         unchanged: result.redacted === workerData.input,
         roundTrip: unredactText(result.redacted, result.map) === workerData.input });`,
      {
        eval: true,
        execArgv: ["--input-type=module"],
        workerData: { moduleUrl: pathToFileURL(require.resolve("./index")).href, input },
      }
    )
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error("PII scan exceeded the 2 second worker deadline"))
    }, 2000)
    worker.once("message", (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    worker.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe("large-text PII scanning", () => {
  it.each([
    ["single word token", "x".repeat(2_500_000)],
    ["single log line", `2026-10-10 INFO payload=${"x-".repeat(1_250_000)}`],
    ["repeated JWT prefixes", "eyJx-".repeat(500_000)],
    ["malformed compressed IPv6 suffix", `aa:bb::${"a".repeat(2_500_000)}_`],
    ["unterminated PEM blocks", "-----BEGIN PRIVATE KEY-----".repeat(100_000)],
  ])("scans and redacts a multi-MB %s in under 500 ms per operation", async (_name, input) => {
    const result = await measure(input)
    expect(result.clean).toBe(true)
    expect(result.unchanged).toBe(true)
    expect(result.roundTrip).toBe(true)
    expect(result.scanMs).toBeLessThan(500)
    expect(result.redactMs).toBeLessThan(500)
    expect(result.normalizeMs).toBeLessThan(500)
  })

  it("still detects PII at the end of a multi-MB log line", async () => {
    const result = await measure(`INFO payload=${"x-".repeat(1_250_000)} alice@example.com`)
    expect(result.clean).toBe(false)
    expect(result.unchanged).toBe(false)
    expect(result.roundTrip).toBe(true)
    expect(result.scanMs).toBeLessThan(500)
    expect(result.redactMs).toBeLessThan(500)
  })

  it("normalizes multi-MB malformed terminal escapes without retrying inside them", async () => {
    const result = await measure(`\x1b[${";".repeat(2_500_000)}`)
    expect(result.clean).toBe(true)
    expect(result.unchanged).toBe(true)
    expect(result.normalizeMs).toBeLessThan(500)
    expect(result.scanMs).toBeLessThan(500)
    expect(result.redactMs).toBeLessThan(500)
  })
})
