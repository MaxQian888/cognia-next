# @cognia/vector

Unified vector-store layer for Cognia. Exposes a backend-agnostic `IVectorStore`
interface plus the embedding adapter, dimension guard, readiness probes, the
Tauri invoke bridge to the Rust-side cloud/native backends, and the one-shot
credential migration.

Framework-agnostic (no React / Next / Zustand / Dexie). Host capabilities (platform detection, Bedrock sidecar execution and plugin
events) are installed through `setVectorRuntimeAdapters` before store creation.
The app supplies these synchronously before hydration; CLI and headless bootstrap
install the same adapter before consumers run. Missing execution adapters fail
explicitly. Native capability queries remain safe before bootstrap and during SSR.

Readiness contracts and the host/vector registry live in `backend-readiness`;
legacy host persistence modules re-export this API and retain the same records.
RAG retains its existing independent registry. The transformers manager is a
workspace package dependency. No production module imports the host `@/` alias.

```ts
import { createVectorStore } from "@cognia/vector/store"
import { generateEmbeddings } from "@cognia/vector/embedding"
```

Consumed in dev/test from source (`packages/vector/src`); the optional `dist`
build only proves the package compiles standalone.
