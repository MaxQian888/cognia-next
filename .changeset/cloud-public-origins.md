---
"cognia-next": minor
---

Cloud deployments can now be reached from a browser and can hand out working invitation links. `/api/auth/config` (version 3) announces the collaboration server as a browser reaches it (`COGNIA_PUBLIC_COLLAB_URL`, falling back to `COGNIA_COLLAB_URL`) and the web app's origin (`COGNIA_WEB_ORIGIN`). The Compose front door proxies `/collab/*` to the collaboration server, which also gained an exact-origin CORS allow-list (`COLLAB_ALLOWED_ORIGINS`) for split-origin installs. Invitation links minted on the desktop or a phone are built on the announced origin instead of `tauri://localhost`, and a deployment that announces none offers the bare token.
