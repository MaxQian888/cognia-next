---
title: "Lark / Feishu Setup"
description: "Create a Lark (Feishu) bot app and connect it to cognia-next via the connector adapter."
---

# Lark / Feishu Setup Guide

This guide walks you through creating a Lark (Feishu) bot app and connecting it to cognia-next.

## Prerequisites

- A Lark / Feishu account with permission to create custom apps.
- Access to the [Lark Developer Console](https://open.feishu.cn/app).

---

## 1. Create a Lark Custom App

1. Open the [Lark Developer Console](https://open.feishu.cn/app).
2. Click **Create custom app**.
3. Enter an app name (e.g. "cognia-bot") and description, then click **Create**.
4. Note the **App ID** (`cli_...`) and **App Secret** on the **App Credentials** page
   (Menu: App settings → App credentials).

---

## 2. Configure Event Subscriptions

Lark sends messages to your bot via an event subscription. cognia-next supports two transport modes.

### Option A — Long Connection (Recommended)

Long connection establishes a persistent WebSocket from cognia-next to Lark's servers.
No public webhook URL is required.

1. Go to **Event subscriptions** in your app's menu.
2. Under **Subscription method**, select **Use long connection to receive events**.
3. Subscribe to the following event:
   - `im.message.receive_v1` — Bot receives a message

Click **Save**.

### Option B — Webhook

A public HTTPS endpoint on the same machine is required.

1. Go to **Event subscriptions** in your app's menu.
2. Under **Subscription method**, select **Configure request URL**.
3. Enter your webhook URL (e.g. `https://your-host.example.com/connectors/lark/<adapterId>`).
4. Lark will send a verification request; cognia-next's Rust HTTP proxy handles the handshake.
5. Subscribe to the following event:
   - `im.message.receive_v1` — Bot receives a message

Click **Save**.

---

## 3. Obtain the Verification Token and Encrypt Key

Still on the **Event subscriptions** page:

- **Verification Token**: Copy the token shown under "Verification Token". This is required.
- **Encrypt Key** (optional): If you want payload encryption, toggle **Enable Encrypt Key** and
  copy the generated key. Store it securely — it is required to decrypt incoming events.

> **Note**: If Encrypt Key is enabled, cognia-next will automatically decrypt events using
> AES-256-CBC with the key you provide.

---

## 4. Grant Required Scopes

Your app needs the following permissions. Go to **Permission management** and add:

| Scope                    | Purpose                                |
| ------------------------ | -------------------------------------- |
| `im:message`             | Read messages sent to the bot          |
| `im:message:send_as_bot` | Send messages as the bot               |
| `im:chat`                | Access chat information                |
| `im:resource`            | Access media resources (images, files) |

Click **Apply permissions** and wait for approval (self-service for custom apps in the same org).

---

## 5. Install the Bot to Your Workspace

1. Go to **Bot** in the menu. Enable the bot feature.
2. Go to **Version management & release** → Click **Create version**.
3. Fill in version details and click **Apply for online release** (or "Release internally" for
   org-only bots).
4. After approval, add the bot to the chats or groups where you want it to operate.

---

## 6. Configure in cognia-next

1. Open **Settings → Connections → Add adapter → Lark**.
2. Fill in the fields:

| Field                  | Value                                           |
| ---------------------- | ----------------------------------------------- |
| **App ID**             | `cli_...` from App credentials                  |
| **App Secret**         | App Secret from App credentials                 |
| **Verification Token** | Token from Event subscriptions                  |
| **Encrypt Key**        | (Optional) Encrypt Key from Event subscriptions |
| **Transport**          | "Long connection" (recommended) or "Webhook"    |

3. Click **Test** to verify App ID + App Secret.
4. Click **Create** to save. The adapter will start automatically.

---

## 7. Resolving the Bot's Own open_id

The adapter uses `selfBotOpenId` to detect when the bot is mentioned. cognia-next resolves this
at startup via the Lark API. If the bot's open_id cannot be resolved, mention detection falls back
to checking the `app_id` in event headers.

You can also find your bot's open_id by calling:

```
GET https://open.feishu.cn/open-apis/bot/v3/info
Authorization: Bearer <tenant_access_token>
```

The response includes `bot.open_id`.

---

## Troubleshooting

| Symptom                               | Likely cause                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| "Connection failed" on Test           | Incorrect App ID or App Secret                                               |
| Events not received (long connection) | Check that `im.message.receive_v1` is subscribed                             |
| Events not received (webhook)         | Verify the webhook URL is reachable and returns 200                          |
| Decrypt error                         | Encrypt Key mismatch — ensure the key matches the one in Event subscriptions |
| Bot not responding in groups          | Ensure the bot is installed to the group and has `im:message` scope          |
