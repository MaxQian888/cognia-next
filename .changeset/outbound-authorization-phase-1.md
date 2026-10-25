---
"cognia-next": minor
---

Add outbound action authorization (ADR-0239): every agent send and connector delivery to a third party is checked against who the request authorized. Replies into the thread you asked from stay silent; a send anywhere else asks the first time, approval cards name each recipient and offer "allow for this request", and "always allow" is gone for outbound tools. People can list who a Bot or a connected bot account may reach unattended. It runs in shadow mode by default, which records what it would do and changes no send; Settings → Security shows what enforcement would change and lets you allow recipients before turning it on. Once enforced, an unattended send to a recipient nobody allowed becomes a draft or waits for approval instead of going out, and a recipient you refuse stays refused for the rest of that request, across tools and sub-runs.
