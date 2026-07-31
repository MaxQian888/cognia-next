---
"cognia-next": minor
---

Feishu/Lark "Send as me" now uses the current OAuth 2.0 authorization-code flow (accounts.feishu.cn authorize + authen/v2/oauth/token, PKCE, `offline_access`+`im:message` scopes) with a configurable, tunnel-relayed redirect URL. The Lark connector settings surface the redirect URL to copy and register in the Feishu console Security Settings, guide you to grant the required scopes, and the callback is relayed through the Companion tunnel and replayed even on a cold start. Adds a Lark setup-guide section documenting the flow.
