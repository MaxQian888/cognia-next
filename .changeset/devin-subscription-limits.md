---
"cognia-next": minor
---

Add Devin subscription quota to the CLI `/limits` panel. External-agent backends now resolve their linked subscription provider through the same limits-source registry as configured providers: a new `devin` source reads `GetUserStatus` (daily/weekly quota windows, ACU, credit balances, overage, auto top-up) via a new POST-capable `authedRequest` context seam, and a per-provider credential-resolver table seeds the query from the agent's own store (`DEVIN_API_KEY`/`DEVIN_TOKEN`/`DEVIN_BASE_URL` env, then `~/.local/share/devin/credentials.toml`). Agents without a linked provider keep the previous "not supported" notice.
