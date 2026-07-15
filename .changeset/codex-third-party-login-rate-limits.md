---
"cognia-next": patch
---

Recognize Codex logins that aren't a ChatGPT subscription. An API-key login — including a third-party provider configured with `model_provider` / `model_providers.<name>.base_url` in `~/.codex/config.toml` — has no rate limits to report, so the app-server answers `account/rateLimits/read` with "chatgpt authentication required". That correct answer was being handled as a failure: it logged a "Codex account refresh failed" warning and aborted the refresh before notifying the UI, so a perfectly healthy third-party login never showed its account in the Codex status card. The account and rate-limit reads are now independent, the expected refusal is recorded as "this account has no rate limits" instead of an error, and the status card is always updated with whatever was read. Genuine rate-limit failures are still reported.
