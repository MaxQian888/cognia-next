---
"cognia-next": minor
---

Adding a plugin marketplace source now previews the repository's catalog before it is saved: the marketplace name, its owner, how many plugins it lists, and the plugins themselves — data the app already fetched to validate the repository and then discarded. A pasted `github.com` URL is echoed back as the canonical `owner/repo@ref` it resolves to before any request is spent, and confirming reuses the fetched catalog rather than downloading it a second time.

Saved sources gained a health line: plugin count, last sync time, and — for the first time — the sync failures the app was already collecting and never showing, so a repository that was renamed, rate-limited, or shipped broken JSON now says so on its own row and offers a retry instead of silently contributing zero plugins to the browse grid. Each source can be refreshed on its own or opened on GitHub, and removing one is confirmed with the consequence spelled out: plugins already installed from it stay installed.
