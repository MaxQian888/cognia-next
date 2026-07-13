/**
 * OCR runtime bootstrap.
 *
 * Wires every provider in `lib/ocr/providers/*` into the shared registry and
 * connects the platform-native providers to their respective Tauri / Capacitor
 * invokers. Called once at app boot — see
 * `components/providers/initializers/ocr-runtime-initializer.tsx`.
 *
 * Provider files self-register through their factory exports rather than via
 * `import './providers/foo'` side effects so the static export's tree-shaker
 * has full visibility.
 */

import { isTauri } from "@/lib/platform/detect"
import { registerOcrProvider, getSharedOcrRegistry } from "./registry"
import { mistralOcrProvider } from "./providers/mistral-ocr"
import { googleVisionProvider } from "./providers/google-vision"
import { awsTextractProvider } from "./providers/aws-textract"
import { azureDocIntelligenceProvider } from "./providers/azure-document-intelligence"
import { anthropicVisionProvider } from "./providers/anthropic-vision"
import { openAiVisionProvider } from "./providers/openai-vision"
import { geminiVisionProvider } from "./providers/gemini-vision"
import { mathpixProvider } from "./providers/mathpix"
import { ocrSpaceProvider } from "./providers/ocr-space"
import { abbyyCloudProvider } from "./providers/abbyy-cloud"
import { nanonetsProvider } from "./providers/nanonets"
import { larkBasicProvider } from "./providers/lark-basic"
import { tesseractWasmProvider } from "./providers/tesseract-wasm"
import { tesseractNativeProvider } from "./providers/tesseract-native"
import {
  __setNativeOcrInvoker,
  type NativeOcrInvoker,
  type NativeOcrInvokePayload,
  type NativeOcrResult,
} from "./providers/tesseract-native"
import {
  __setWindowsMediaOcrInvoker,
  __setWindowsMediaOcrReadiness,
  windowsMediaOcrProvider,
} from "./providers/windows-media-ocr"
import { __setAppleVisionTauriInvoker, appleVisionProvider } from "./providers/apple-vision"
import { mlkitAndroidProvider } from "./providers/mlkit-android"
import { __setOcrsInvoker, __setOcrsReadiness, ocrsProvider } from "./providers/ocrs"
import {
  __setPaddleOcrInvoker,
  __setPaddleOcrReadiness,
  paddleOcrProvider,
} from "./providers/paddle-ocr"
import { localHttpProvider } from "./providers/local-http"

const ALL_PROVIDERS = [
  mistralOcrProvider,
  googleVisionProvider,
  awsTextractProvider,
  azureDocIntelligenceProvider,
  anthropicVisionProvider,
  openAiVisionProvider,
  geminiVisionProvider,
  mathpixProvider,
  ocrSpaceProvider,
  abbyyCloudProvider,
  nanonetsProvider,
  larkBasicProvider,
  tesseractWasmProvider,
  tesseractNativeProvider,
  windowsMediaOcrProvider,
  appleVisionProvider,
  mlkitAndroidProvider,
  ocrsProvider,
  paddleOcrProvider,
  localHttpProvider,
]

let installed = false

export interface OcrRuntimeOptions {
  /** Inject a custom invoker — typically only used in tests. */
  nativeInvoker?: NativeOcrInvoker
  /** Inject a custom MSIX-status probe. Defaults to the Tauri command. */
  windowsReadinessProbe?: () => Promise<boolean>
  /**
   * Inject a custom model-readiness probe — tests pass a deterministic
   * function; production reads `ocr_model_status` from the Rust side. The
   * probe accepts the backend id (`ocrs` / `paddle-ocr`) and returns true
   * when the local model files are installed.
   */
  modelReadinessProbe?: (backend: "ocrs" | "paddle-ocr") => Promise<boolean>
}

/**
 * Install every provider into the shared registry and wire platform-native
 * invokers. Idempotent — calling twice is a no-op.
 */
export async function installOcrRuntime(opts: OcrRuntimeOptions = {}): Promise<void> {
  if (installed) return
  installed = true
  const registry = getSharedOcrRegistry()
  for (const provider of ALL_PROVIDERS) {
    if (registry.has(provider.id)) continue
    registerOcrProvider(provider)
  }

  const invoker = opts.nativeInvoker ?? (await tryBuildTauriInvoker())
  if (invoker) {
    __setNativeOcrInvoker(invoker)
    __setWindowsMediaOcrInvoker(invoker)
    __setAppleVisionTauriInvoker(invoker)
    __setOcrsInvoker(invoker)
    __setPaddleOcrInvoker(invoker)
  }

  const readinessProbe = opts.windowsReadinessProbe ?? (await tryBuildMsixProbe())
  if (readinessProbe) {
    __setWindowsMediaOcrReadiness(readinessProbe)
  }

  const modelProbe = opts.modelReadinessProbe ?? (await tryBuildModelStatusProbe())
  if (modelProbe) {
    __setOcrsReadiness(() => modelProbe("ocrs"))
    __setPaddleOcrReadiness(() => modelProbe("paddle-ocr"))
  }
}

/** Reset state — test-only. */
export function __resetOcrRuntime(): void {
  installed = false
  __setNativeOcrInvoker(null)
  __setWindowsMediaOcrInvoker(null)
  __setWindowsMediaOcrReadiness(null)
  __setAppleVisionTauriInvoker(null)
  __setOcrsInvoker(null)
  __setOcrsReadiness(null)
  __setPaddleOcrInvoker(null)
  __setPaddleOcrReadiness(null)
}

async function tryBuildTauriInvoker(): Promise<NativeOcrInvoker | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = (await import("@tauri-apps/api/core")) as {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    }
    return async (payload: NativeOcrInvokePayload) => {
      return invoke<NativeOcrResult>("ocr_extract_native", {
        payload: {
          backend: payload.backend,
          // Tauri serializes Uint8Array as a number array transparently.
          bytes: Array.from(payload.bytes),
          mime_type: payload.mimeType,
          languages: payload.languages,
        },
      })
    }
  } catch {
    return null
  }
}

async function tryBuildMsixProbe(): Promise<(() => Promise<boolean>) | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = (await import("@tauri-apps/api/core")) as {
      invoke: <T>(cmd: string) => Promise<T>
    }
    return async () => {
      try {
        const status = await invoke<{ has_package_identity?: boolean }>("ocr_msix_status")
        return !!status?.has_package_identity
      } catch {
        return false
      }
    }
  } catch {
    return null
  }
}

/**
 * Build a probe that asks the Rust side via `ocr_model_status` whether the
 * given backend's models are installed. Returns `null` (no probe) when the
 * runtime isn't Tauri — the providers will then either rely on the
 * fallback default (`null` → treat as ready) or throw `unsupported_shell`
 * when invoked without an installed model. Tests inject a stub via
 * `OcrRuntimeOptions.modelReadinessProbe`.
 */
async function tryBuildModelStatusProbe(): Promise<
  ((backend: "ocrs" | "paddle-ocr") => Promise<boolean>) | null
> {
  if (!isTauri()) return null
  try {
    const { invoke } = (await import("@tauri-apps/api/core")) as {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    }
    return async (backend) => {
      try {
        const status = await invoke<{ installed?: boolean }>("ocr_model_status", { backend })
        return !!status?.installed
      } catch {
        return false
      }
    }
  } catch {
    return null
  }
}
