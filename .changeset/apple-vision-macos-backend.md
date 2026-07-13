---
"cognia-next": patch
---

Fix the Apple Vision OCR backend being unavailable on macOS: the `apple-vision` native backend is now implemented in-process via Vision.framework (`VNRecognizeTextRequest`) and registered automatically on macOS builds — no feature flag, sidecar, or model download required.
