import { Worker } from "node:worker_threads"
import { pathToFileURL } from "node:url"
import { estimateFallbackTokens, resolveTokenCount } from "./fallback-estimator"

describe("cl100k fallback token estimator", () => {
  it("counts Latin, CJK, and mixed text with the shared tokenizer", () => {
    expect(estimateFallbackTokens("Hello world")).toBeGreaterThan(0)
    expect(estimateFallbackTokens("你好，世界")).toBeGreaterThan(0)
    expect(estimateFallbackTokens("Cognia 支持 Bedrock")).toBeGreaterThan(0)
  })

  it("returns zero for empty input", () => {
    expect(estimateFallbackTokens("")).toBe(0)
    expect(estimateFallbackTokens(null)).toBe(0)
  })

  it("keeps provider-reported usage authoritative", () => {
    expect(resolveTokenCount("a very long fallback string", 7)).toBe(7)
    expect(resolveTokenCount("fallback", undefined)).toBe(estimateFallbackTokens("fallback"))
    expect(resolveTokenCount("x".repeat(2_500_000), 7)).toBe(7)
  })

  it("keeps exact cl100k counts for ordinary bounded text", () => {
    expect(estimateFallbackTokens("Hello world")).toBe(2)
    expect(estimateFallbackTokens("abcde")).toBe(2)
    expect(estimateFallbackTokens("abcdefgh")).toBe(1)
  })

  it("uses the multilingual heuristic for large or pathological tokenizer pieces", () => {
    expect(estimateFallbackTokens("中".repeat(40_000))).toBe(60_000)
    expect(estimateFallbackTokens("x".repeat(300))).toBe(75)
    expect(estimateFallbackTokens("!".repeat(300))).toBe(75)
    expect(estimateFallbackTokens(" ".repeat(300))).toBe(1)
  })

  it("estimates a 2.5 MB single-token upload in under 500 ms", async () => {
    const result = await new Promise<{ tokens: number; ms: number }>((resolve, reject) => {
      const worker = new Worker(
        `import { parentPort, workerData } from "node:worker_threads";
         import { registerHooks } from "node:module";
         registerHooks({ resolve(specifier, context, nextResolve) {
           return specifier === "@cognia/rag/cjk-tokenizer"
             ? { url: workerData.cjkModuleUrl, shortCircuit: true }
             : nextResolve(specifier, context);
         }});
         const { estimateFallbackTokens } = await import(workerData.moduleUrl);
         const text = "x".repeat(2_500_000);
         const start = performance.now();
         const tokens = estimateFallbackTokens(text);
         parentPort.postMessage({ tokens, ms: performance.now() - start });`,
        {
          eval: true,
          execArgv: ["--input-type=module", "--conditions=cognia-source"],
          workerData: {
            moduleUrl: pathToFileURL(require.resolve("./fallback-estimator")).href,
            cjkModuleUrl: pathToFileURL(require.resolve("@cognia/rag/cjk-tokenizer")).href,
          },
        }
      )
      const timer = setTimeout(() => {
        void worker.terminate()
        reject(new Error("Token estimation exceeded the 2 second worker deadline"))
      }, 2000)
      worker.once("message", (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      worker.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.ms).toBeLessThan(500)
  })
})
