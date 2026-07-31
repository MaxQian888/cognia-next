---
"cognia-next": patch
---

Harden the desktop TTS HTTP proxy. It previously accepted any URL and method, turning a command named "tts" into a general SSRF primitive that could reach `localhost`, link-local, or cloud-metadata endpoints; it had no request timeout (a stuck socket pended forever); it buffered the whole response with no size cap; it rebuilt the HTTP client every call, losing connection pooling; and its send errors interpolated the reqwest error, which can carry the URL — and Gemini puts the API key in the query string. Requests are now restricted to an https allowlist of the known provider hosts, carry connect/total timeouts, stream the body under a 25 MB cap, reuse a cached client on the direct path, and surface errors without echoing the URL or key. (The comment claiming the proxy holds the key was also corrected — the frontend supplies it.)
