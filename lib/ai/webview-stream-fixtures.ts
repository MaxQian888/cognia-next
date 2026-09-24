/**
 * Test support for the webview `streamText` rejection leak that
 * `webview-safe-telemetry.ts` closes. Imported by tests only.
 *
 * The suites drive the REAL `streamText` against these mock models with the
 * Node runtime probe cleared, which is the path the browser/Capacitor webview
 * takes. Jest 30's circus fails the running test on any unhandled rejection
 * Node reports while it runs, so a suite drains one macrotask after the call
 * ({@link drainRejectionReports}) to let Node report before the test ends.
 */

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4 } from "ai/test"

/**
 * Clear `process.release`, which is what the SDK's `isNodeRuntime()` probes.
 * The webview `process` polyfill carries none. Returns the restore function.
 */
export function simulateWebviewRuntime(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "release")
  Object.defineProperty(process, "release", { configurable: true, value: undefined })
  return () => {
    if (descriptor) Object.defineProperty(process, "release", descriptor)
  }
}

/** One macrotask: long enough for Node to report an unhandled rejection. */
export function drainRejectionReports(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function streamOf(
  parts: LanguageModelV4StreamPart[],
  end: (controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>) => void
) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      end(controller)
    },
  })
}

/** A model whose stream emits `text` and finishes normally. */
export function completedStreamModel(text = "full answer"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: streamOf(
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 2, text: 2, reasoning: undefined },
            },
          },
        ],
        (controller) => controller.close()
      ),
    }),
  })
}

/**
 * A model whose response opens and then ends before any output or finish
 * chunk, the way a gateway drops an idle streaming response. The SDK reports a
 * NoOutputGeneratedError on the stream and rejects its result promises with
 * it, whether or not anyone reads them.
 */
export function truncatedStreamModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: streamOf([{ type: "stream-start", warnings: [] }], (controller) =>
        controller.close()
      ),
    }),
  })
}

/**
 * A model whose stream emits `text`, then stays open until the call's abort
 * signal fires and errors with the abort reason, like a fetch body does. The
 * SDK rejects its result promises with that reason.
 */
export function abortableStreamModel(text = "partial answer"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: streamOf(
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
        ],
        (controller) =>
          abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason), {
            once: true,
          })
      ),
    }),
  })
}
