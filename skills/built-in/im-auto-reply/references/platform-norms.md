# Per-platform IM norms

Quick reference for how each connector platform differs. When you don't know the platform, fall back to the conservative defaults in the main skill (short, plain, no unsupported rich content).

## Message length & formatting

| Platform | Length feel | Markdown | Rich content |
| --- | --- | --- | --- |
| Slack | Short; threads for depth | mrkdwn (not full MD) | Block Kit buttons, selects, sections |
| Lark / Feishu | Short–medium | Limited | Interactive cards, forms |
| Discord | Casual, short | Full markdown | Buttons, embeds (2000-char cap) |
| WhatsApp | Very short, 1–2 lines | None (plain text) | Quick-reply / list buttons only |
| Telegram | Short | Limited MD/HTML | Inline keyboards |

Pasting a markdown table or a raw URL into WhatsApp/Telegram renders as noise. Produce a structured surface and let the A2UI bridge map it to what the channel supports — never hand-format what the platform can't render.

## Threading & mentions
- Slack/Discord: reply in-thread when the inbound was in a thread; don't break a thread into the main channel.
- Group chats: only @-mention when the message is genuinely for a specific person; over-mentioning reads as spam.
- 1:1 DMs: no mentions, no greetings — just answer.

## Cadence & rate
- One message per idea. Don't send three messages in a burst where one would do.
- A reply that takes 200ms looks robotic in a human thread; the runtime paces sends, so don't also try to chunk artificially.

## Escalation phrasing (match register)
- Formal (Lark/Slack work channels): "I'll flag this for {person} to follow up."
- Casual (Discord/WhatsApp): "let me get {person} on this 👍"

Keep the promise truthful — only say a human will follow up if that handoff actually happens.
