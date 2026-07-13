---
title: "OneBot (QQ) Setup"
description: "Connect QQ via the OneBot protocol using NapCat, Lagrange, or LLOneBot over reverse or forward WebSocket."
---

# OneBot (QQ) Setup Guide

cognia-next connects to QQ through the **OneBot** protocol over two WebSocket topologies:

- **Reverse WS**: NapCat, Lagrange, or LLOneBot runs alongside the QQ client and dials
  into the cognia-next connector server.
- **Forward WS**: cognia-next dials the WebSocket server exposed by NapCat or another
  OneBot client.

Supported clients:

- [NapCat](https://github.com/NapNeko/NapCatQQ) — QQ for Windows/Linux, updated most frequently
- [Lagrange](https://github.com/LagrangeDev/Lagrange.Core) — cross-platform NTQQ
- [LLOneBot](https://github.com/LLOneBot/LLOneBot) — a LiteLoader plugin for QQNT

---

## Prerequisites

- cognia-next running in **desktop mode** (`pnpm tauri dev` or the installed app)
- A QQ account logged in via NapCat / Lagrange / LLOneBot
- Reverse WS: the machine running the QQ client (usually the same machine) can reach port
  `7842` (or whichever connector port you configured).
- Forward WS: cognia-next can reach the OneBot client's WebSocket server, e.g.
  `ws://127.0.0.1:3001`.

---

## Step 1 — Add the adapter in cognia-next

1. Open **Platform Connections**.
2. Click **Add connector** → **OneBot (QQ)**.
3. Fill in:
   - **Bot UIN (QQ number)** — the bot account's QQ number (e.g. `123456789`).
   - **Bearer Token** — when using an authenticated connection, set this to the same value
     as the OneBot client's `accessToken`.
   - **Expected client** — pick NapCat, Lagrange, or LLOneBot (display only).
   - **Transport** — choose **Reverse WS** when the client dials into cognia-next, or
     **Forward WS** when cognia-next dials the client's WebSocket server.
4. Click **Create**.

If you chose **Reverse WS**, the dialog shows an endpoint URL such as:

   ```
   ws://127.0.0.1:7842/ws/onebot/<adapterId>
   ```

Copy this URL — you will paste it into the NapCat / Lagrange / LLOneBot config next.

If you chose **Forward WS**, enter the OneBot client's WebSocket server address, e.g.
`ws://127.0.0.1:3001`.

---

## Step 2 — Choose a transport

### Option A: Reverse WS

Edit your NapCat `napcat.json` (or use the NapCat WebUI) and add the reverse-WS URL shown
by cognia-next:

```json
{
  "wsReverse": [
    {
      "enable": true,
      "url": "ws://127.0.0.1:7842/ws/onebot/<adapterId>",
      "reconnectInterval": 3000
    }
  ]
}
```

Replace `<adapterId>` with the value shown in the cognia-next dialog.

### Lagrange

In `appsettings.json`:

```json
{
  "Implementations": [
    {
      "Type": "ReverseWebSocket",
      "Host": "127.0.0.1",
      "Port": 7842,
      "Suffix": "/ws/onebot/<adapterId>",
      "ReconnectInterval": 3000
    }
  ]
}
```

### LLOneBot

In the LLOneBot plugin settings, add a **Reverse WebSocket** entry with the URL:

```
ws://127.0.0.1:7842/ws/onebot/<adapterId>
```

### Option B: Forward WS

Enable the OneBot client's WebSocket server and put its URL into cognia-next's **NapCat
WebSocket address** field. A common NapCat address is:

```
ws://127.0.0.1:3001
```

If a **Bearer Token** is set, cognia-next sends `Authorization: Bearer <token>` when it
opens the forward WebSocket.

---

## Step 3 — Configure the bearer token

For reverse WS, the inbound endpoint is fail-closed by default: with no bearer token
configured, cognia-next rejects the connection unless you explicitly enable **Allow
unauthenticated connections** in the adapter dialog.

Recommended setup:

1. In NapCat `napcat.json`, set:

   ```json
   {
     "accessToken": "my-secret-token"
   }
   ```

2. In the cognia-next adapter dialog, paste `my-secret-token` into the **Bearer Token
   (optional)** field.

cognia-next rejects reverse-WS connections that send the wrong or a missing token. Only
enable **Allow unauthenticated connections** when a trusted loopback client genuinely does
not use an access token.

---

## Step 4 — Restart and verify

1. After changing WebSocket or token settings, restart or reconnect the OneBot client.
2. On reverse WS the client dials into cognia-next within a few seconds; on forward WS
   cognia-next connects to the client's WebSocket server.
3. In the cognia-next adapter dialog, click **Verify connection** to wait up to 10 seconds
   for a fresh reverse-WS handshake, or **Connected now?** to read the live reverse-WS
   registry.
4. Once connected, the adapter status in **Platform Connections** shows **running** (green).

---

## Step 5 — Test the bot

- **Private message**: send a QQ private message to the bot's UIN.
- **Group @mention**: send `@<bot-UIN> hello` in a group — the bot replies if the group
  trigger policy matches.

---

## Bot identity & rich messages

Once the client connects, cognia-next automatically probes the bot's own identity with the
OneBot `get_login_info` action and shows the real nickname + UIN in the adapter's **Bot
identity** panel — the same way Telegram, Slack, and Lark surface their bot identity. If the
connected bot's UIN differs from the **Bot UIN** you entered, the panel shows a mismatch
warning; update the field to match.

Inbound QQ messages are mapped with high fidelity:

- **Merged forwards (合并转发)** are resolved via `get_forward_msg` so the real forwarded
  body (`nickname: text` lines) is delivered instead of a generic placeholder.
- **Location** segments become structured location data; **poke (戳一戳)**, **dice (骰子)**,
  **rock-paper-scissors (猜拳)**, **contact cards**, and legacy **XML/JSON cards** are
  rendered as readable text.

Outbound, the adapter can **merge-forward** existing messages into another conversation via
the NapCat `send_group_forward_msg` / `send_private_forward_msg` extension, and add QQ emoji
reactions via `set_msg_emoji_like` on NapCat upstreams.

---

## Troubleshooting

See the [QQ via OneBot FAQ](./qq-via-onebot-faq.md) for common issues.
