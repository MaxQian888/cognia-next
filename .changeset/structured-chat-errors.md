---
"cognia-next": minor
---

Chat and Agent Team failures now carry structure instead of a bare string, so the error card can say what actually went wrong and what to do about it. A rate limit shows the provider's real Retry-After as a countdown rather than discarding it; an auth failure offers "Open settings" because the failure _is_ an auth failure, not because its English text happened to contain "api key" — that check silently never fired for providers answering in another language. Agent Team errors ("team no longer exists", "no supervisor configured", a failed member run) are localized rather than hard-coded English, and a member's name no longer gets glued onto the front of the error text where it stopped the parsers recognising the underlying failure.
