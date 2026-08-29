---
"cognia-next": minor
---

Sites are reachable from plugins and from the agent. Plugins get a read-only `@cognia/plugin-sdk/api/site` surface — a projection that withholds Cloudflare account identifiers, local paths, collaborator lists, and visitor identities. The agent gets `list_sites`, `build_site`, and `deploy_site`; publishing always asks for confirmation and counts as an irreversible external action for run risk, while building — which produces a local version and publishes nothing — does not.
