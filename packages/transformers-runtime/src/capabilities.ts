import type { TransformersCapabilities } from "./types"

/** Detects browser primitives only; it never creates a Worker or imports Transformers.js. */
export function getTransformersCapabilities(): TransformersCapabilities {
  const worker = typeof Worker !== "undefined"
  const webgpu = typeof navigator !== "undefined" && "gpu" in navigator

  return {
    available: worker,
    worker,
    webgpu,
    wasm: true,
    recommendedDevice: webgpu ? "webgpu" : "wasm",
  }
}
