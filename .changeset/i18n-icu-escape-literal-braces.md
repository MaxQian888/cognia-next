---
"cognia-next": patch
---

Fix a class of i18n console errors where messages containing literal `{{token}}`, JSON examples (`{ "k": 1 }`), or `<placeholder>` tokens were rejected by next-intl's ICU MessageFormat parser (`INVALID_MESSAGE: MALFORMED_ARGUMENT` / `UNCLOSED_TAG`). The most visible case was Settings → Connections → Canned Responses, whose body placeholder and description threw on every render. Affected strings across canned responses, connection send-test help, workflow node forms, the LSP server config placeholder, and the export format hint are now apostrophe-escaped so the literal tokens render as intended. A build-time validator (`pnpm i18n:validate`, wired into `i18n:build`) now guards every bundle string against malformed ICU.
