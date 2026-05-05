# Discord Bot Setup Guide

This guide walks you through creating a Discord application, obtaining a bot token and public key, inviting the bot to a server, and configuring cognia-next to use it.

---

## 1. Create a Discord Application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and sign in.
2. Click **New Application** in the top-right corner.
3. Enter a name for your application (e.g. "Cognia Bot") and click **Create**.

---

## 2. Add a Bot User

1. In your application, select **Bot** from the left sidebar.
2. Click **Add Bot**, then confirm with **Yes, do it!**
3. Under **Token**, click **Reset Token** and copy the token. **Store it securely — you will not be able to see it again.**

> The bot token is what cognia-next uses to authenticate with Discord. Never share it publicly.

---

## 3. Note the Public Key

1. In your application, go to **General Information**.
2. Copy the **Public Key** (64-character hex string).

This is used for Ed25519 signature verification when Discord sends interaction payloads to a webhook endpoint. Phase 1 uses Gateway (WebSocket) mode, so this is **optional** for now — but it is good practice to save it for a future webhook migration.

---

## 4. Configure Gateway Intents

1. In your application, select **Bot** from the left sidebar.
2. Scroll down to **Privileged Gateway Intents**.
3. Enable the following:
   - **Server Members Intent** — allows the bot to see guild members.
   - **Message Content Intent** — **required** for the bot to read message content in guild channels.

> Without **Message Content Intent**, the `content` field of guild messages will be empty. Direct Messages do not require this intent.

cognia-next uses intent bitmask **33281** by default:

| Intent          | Value     |
| --------------- | --------- |
| GUILDS          | 1         |
| GUILD_MESSAGES  | 512       |
| MESSAGE_CONTENT | 32768     |
| DIRECT_MESSAGES | 4096      |
| **Total**       | **33281** |

---

## 5. Invite the Bot to Your Server

1. In your application, select **OAuth2 → URL Generator** from the left sidebar.
2. Under **Scopes**, check `bot`.
3. Under **Bot Permissions**, check at minimum:
   - **Send Messages**
   - **Read Message History**
   - **View Channels**
   - **Embed Links** (for image attachments)
4. Copy the generated URL and open it in your browser.
5. Select the server you want to add the bot to and click **Authorise**.

---

## 6. Configure cognia-next

1. Open cognia-next and navigate to **Settings → Connections**.
2. Click **Add Adapter** and choose **Discord**.
3. In the **Discord Configuration** dialog:
   - Enter a **Display Name** for this bot (e.g. "My Server Bot").
   - Paste the **Bot Token** you copied in step 2.
   - Optionally paste the **Public Key** from step 3.
   - Click **Test** to verify the token connects to Discord successfully.
4. Click **Create**.

cognia-next will connect to the Discord Gateway using WebSocket mode. No public URL is required.

---

## 7. Verify the Connection

After creating the adapter, check the **Connections** overview. The adapter should show status **Running** within a few seconds as the Gateway WebSocket handshake completes (HELLO → IDENTIFY → READY).

If the adapter shows **Down** or **Degraded**:

- Verify the bot token is correct (reset it if needed).
- Confirm the **Message Content Intent** is enabled in the Developer Portal.
- Check the **Audit Log** tab in Settings → Connections for error details.

---

## Notes

- **Rate limits**: Discord rate-limits bots at 50 messages per second per channel. cognia-next's outbound runner respects retryable errors (HTTP 429).
- **Large servers**: For bots in 100+ servers, you must apply for **Gateway Privileged Intents** through the Developer Portal.
- **Sharding**: Not supported in Phase 1. Single-shard operation only.
- **Voice messages**: Not supported in Phase 1. Planned for Phase 2.
