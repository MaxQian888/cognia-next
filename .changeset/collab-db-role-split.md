---
"cognia-next": patch
---

Collaboration server: migrations now run on a separate admin connection and the server queries as an ordinary database role, so row-level security is enforced; it refuses to start on a superuser or BYPASSRLS role unless `COLLAB_ALLOW_PRIVILEGED_DB_ROLE=true`, and `/health` reports `rls`. Compose provisions the `cognia_collab_app` role automatically and now forwards the shared-chat, Canvas and feed switches.
