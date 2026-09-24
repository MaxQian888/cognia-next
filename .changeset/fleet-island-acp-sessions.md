---
"cognia-next": minor
---

Dynamic Island now projects ACP-managed external agent sessions (Devin gets its own badge; other ACP agents use a generic ACP identity with their configured display name) through a renderer-side Fleet projection backed by ExternalAgentManager. ACP rows support observing session status, answering permission requests, answering or declining elicitation/async questions, interrupting runs, and sending follow-up replies — all validated in the main window through the existing island action path, with chat-bound sessions navigating to their Cognia chat and unbound sessions opening the external-agent management page.
