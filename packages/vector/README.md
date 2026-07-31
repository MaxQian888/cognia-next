# @cognia/vector

Unified vector-store layer for Cognia. Exposes a backend-agnostic `IVectorStore`
interface plus the embedding adapter, dimension guard, readiness probes, the
Tauri invoke bridge to the Rust-side cloud/native backends, and the one-shot
credential migration.

Framework-agnostic (no React / Next / Zustand / Dexie). Host integration points
(platform detection, persistence readiness, the transformers manager) are reached
back through the `@/` alias, mirroring the other extracted `@cognia/*` packages.

```ts
import { createVectorStore } from "@cognia/vector/store"
import { embedTexts } from "@cognia/vector/embedding"
```

Consumed in dev/test from source (`packages/vector/src`); the optional `dist`
build only proves the package compiles standalone.
