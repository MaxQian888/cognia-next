---
"cognia-next": patch
---

Fix stopping OpenAI Realtime speech sometimes doing nothing. A cancel issued while the WebSocket was still connecting was silently dropped, and that request could then never be cancelled — audio kept synthesizing and streaming to the UI. Cancellation now uses a state-storing signal, so pressing stop reliably ends the request no matter when it arrives.
