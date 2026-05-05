# Slack Bot Setup Guide

This guide walks you through creating a Slack app, obtaining the required tokens and secrets, and configuring cognia-next to connect to your workspace.

---

## 1. Create a Slack App

1. Open [https://api.slack.com/apps](https://api.slack.com/apps) and sign in with your Slack account.
2. Click **Create New App** and choose **From scratch**.
3. Enter an **App Name** (e.g. "Cognia Bot") and select the **workspace** you want to install it in.
4. Click **Create App**.

---

## 2. Add OAuth Scopes

1. In your app settings, select **OAuth & Permissions** from the left sidebar.
2. Scroll down to **Bot Token Scopes** and add the following:

   | Scope               | Purpose                                   |
   | ------------------- | ----------------------------------------- |
   | `chat:write`        | Send messages to channels and DMs         |
   | `channels:history`  | Read messages in public channels          |
   | `im:history`        | Read messages in direct messages (DMs)    |
   | `app_mentions:read` | Receive events when the bot is @mentioned |
   | `users:read`        | Look up user information                  |
   | `users:read.email`  | (Optional) Access user email addresses    |

3. Click **Save Changes**.

---

## 3. Enable Socket Mode

cognia-next uses **Socket Mode** by default, which means it connects via a persistent WebSocket and does not require a public URL.

1. In your app settings, select **Socket Mode** from the left sidebar.
2. Toggle **Enable Socket Mode** to on.
3. You will be prompted to **Generate an App-Level Token**:
   - Enter a token name (e.g. "cognia-socket-token").
   - Add the scope `connections:write`.
   - Click **Generate**.
4. Copy the token — it starts with `xapp-`. **Store it securely.**

---

## 4. Install the App to Your Workspace

1. In your app settings, select **OAuth & Permissions** from the left sidebar.
2. Click **Install to Workspace** (or **Reinstall** if already installed).
3. Review the permissions and click **Allow**.
4. Copy the **Bot User OAuth Token** — it starts with `xoxb-`. **Store it securely.**

---

## 5. Copy the Signing Secret

1. In your app settings, select **Basic Information** from the left sidebar.
2. Scroll down to **App Credentials**.
3. Copy the **Signing Secret**. This is used to verify that webhook payloads originate from Slack.

---

## 6. Configure cognia-next

1. Open cognia-next and navigate to **Settings → Connections**.
2. Click **Add Adapter** and choose **Slack**.
3. In the **Slack Configuration** dialog:
   - Enter a **Display Name** for this bot (e.g. "My Workspace Bot").
   - Paste the **Bot Token** (`xoxb-...`) you copied in step 4.
   - Click **Test** to verify the token connects to Slack successfully. The dialog will display your bot's username and workspace name.
   - Paste the **Signing Secret** you copied in step 5.
   - Select **Socket Mode** as the transport (default).
   - Paste the **App Token** (`xapp-...`) you copied in step 3.
4. Click **Create**.

cognia-next will connect to Slack via Socket Mode. No public URL is required.

---

## 7. Verify the Connection

1. Send a **direct message** to your bot in Slack, or `@mention` it in a channel where it has been invited.
2. The message should appear in cognia-next within a second or two.
3. Check the **Connections** overview — the adapter should show status **Running**.

If the adapter shows **Down** or **Degraded**:

- Verify the bot token is correct (`xoxb-...`).
- Verify the app token is correct (`xapp-...`) and has the `connections:write` scope.
- Confirm Socket Mode is enabled in the Slack Developer Portal.
- Check the **Audit Log** tab in Settings → Connections for error details.

---

## Notes

- **Rate limits**: Slack enforces a burst limit of approximately 1 message per second per channel. cognia-next's outbound runner respects retryable errors (HTTP 429).
- **Events API webhook**: For production deployments behind a public URL, you can switch the transport to **Events API webhook** in the configuration dialog. This requires a publicly reachable HTTPS URL and is outside the scope of Phase 1.
- **Typing indicator**: Slack's `assistant.threads.setStatus` is restricted to Slack Assistant apps. Standard bot adapters do not support typing indicators in Phase 1.
- **File uploads**: Phase 1 sends files as hyperlinks via `chat.postMessage`. Native file upload via `files.upload` is planned for Phase 2.
