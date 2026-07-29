---
"cognia-next": minor
---

Integrations are now something you manage, at a new `/integrations` page. Previously a plugin that talked to an outside service owned its own accounts, its own event subscriptions, its own inbound deliveries and its own retry behaviour — so "which services am I connected to, under which account, and what are they allowed to do" had no single answer and nowhere to look it up. The hub answers it: connected accounts per integration, the events each is subscribed to, the actions it can run, the risk each action carries, and a disconnect that actually revokes rather than hiding a card.

Underneath it is a host-owned control plane instead of per-plugin plumbing. Accounts and subscriptions persist in the app database (schema v127), inbound events arrive through one ingress client that dedupes and acknowledges them, and outbound actions run through one runner with shared error and retry semantics — so a failing integration tells you which step failed instead of going quiet. Plugins bind to it declaratively; the host owns the credentials and the lifecycle, and every authenticated request passes the same outbound PII gate the rest of the app uses.

Existing plugin-owned integration state is migrated on first run. Nothing you had connected needs reconnecting.
