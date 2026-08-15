---
"cognia-next": minor
---

Settings sections now declare the capabilities they administer instead of a `desktopOnly` host flag, so a browser paired to a cloud brain sees the sections whose backend runs on that brain (terminal, source control, connections, sandbox, LSP, tools, webhooks, gateway, Pro IDE, workspace trust, subscription) while local-shell surfaces stay desktop-bound; the OCR service RPCs (`ocr_list_native_backends`, `ocr_list_available_backends`, `ocr_extract_native`, `ocr_download_model`) are host-neutral and answer identically on the desktop and the headless server.
