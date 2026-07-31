import type { BrowserEngine } from "@/lib/browser/agent-engine"
import type { RecordedStep } from "@/lib/browser/recording/protocol"
import type { RecordingDriver } from "@/lib/browser/recording/recorder"

async function evaluateHelper(engine: BrowserEngine, expression: string): Promise<unknown> {
  const result = await engine.evaluate(expression)
  if (!result.ok) throw new Error(result.error ?? "Browser recording helper failed")
  return result.value
}

/**
 * Recording adapter for any BrowserEngine whose page has Cognia's shared
 * overlay helpers injected. Remote Chromium and the embedded webview therefore
 * use the same recorder state machine and recorded-step protocol.
 */
export function createEngineRecordingDriver(engine: BrowserEngine): RecordingDriver {
  return {
    start: () => evaluateHelper(engine, "window.__cogniaStartRecord()"),
    resume: () => evaluateHelper(engine, "window.__cogniaResumeRecord()"),
    stop: () => evaluateHelper(engine, "window.__cogniaStopRecord()"),
    async drain() {
      const value = await evaluateHelper(engine, "window.__cogniaDrainRecord()")
      const parsed = typeof value === "string" ? JSON.parse(value) : value
      return Array.isArray(parsed) ? (parsed as RecordedStep[]) : []
    },
  }
}
