# QQ via OneBot — FAQ

## Why UIN instead of OpenID?

cognia-next's OneBot adapter uses the bot's **UIN** (QQ number), which is what NapCat, Lagrange, and LLOneBot expose.

The **QQ Official Bot** platform uses **OpenID** — a completely different API with an official SDK and webhook. That platform will be supported by a separate `qq-official` adapter in a future release.

Do **not** mix the two: NapCat does not understand OpenID, and the QQ Official Bot API does not use OneBot.

---

## Group permission requirements

For the bot to receive group messages the bot account must be:

- A member of the group.
- (For @-mention responses) the group must allow any member to be @-mentioned, OR the bot must be explicitly mentioned.

Some groups restrict messaging to admins. In that case only admins can trigger the bot; cognia-next respects the OneBot event stream as-is.

---

## Reverse-WS firewall / connection refused

By default cognia-next's connectors server binds to `127.0.0.1` (loopback only). This means:

- NapCat and cognia-next **must run on the same machine**.
- If you run NapCat on a different host (e.g. a Docker container on the same LAN), the connection will fail.

**Solutions:**

1. Run NapCat on the same host as cognia-next.
2. If separation is required, use `ssh -L 8080:127.0.0.1:8080 user@cognia-host` to forward the port.
3. A future setting will allow binding to `0.0.0.0` — watch the changelog.

---

## Token rotation

If you change the bearer token in NapCat or cognia-next:

1. Update the token in cognia-next **Settings → Connections → (adapter) → Bearer Token**.
2. Update the `accessToken` in NapCat config.
3. **Restart cognia-next** so the new keyring entry is picked up by the axum WS server.
4. Restart NapCat to reconnect with the new token.

Simply saving the dialog is not enough — the Rust server reads the keyring at upgrade time.

---

## Frame size limits

OneBot clients typically cap individual WS frames at a few MB. If you send a very large file, the upload will fail with a frame-size error from NapCat.

Use the **file** segment type for large attachments: NapCat will upload the file via the QQ file transfer API and send a reference rather than embedding raw bytes.

---

## "Connection accepted but no events arrive"

If the adapter shows **running** (green) but no messages trigger the bot:

1. Check that the group trigger policy is set correctly — by default only @-mentions and `/ask` slash commands trigger the bot in groups.
2. Confirm NapCat is receiving messages: open the NapCat log and look for incoming `message` events.
3. Make sure the bot's QQ account is a member of the group and hasn't been muted.

---

## Multiple bots / adapters

You can add multiple OneBot adapters in cognia-next — each gets a unique `adapterId` and therefore a unique endpoint URL:

```
ws://127.0.0.1:8080/ws/onebot/adapter-abc-1
ws://127.0.0.1:8080/ws/onebot/adapter-abc-2
```

Point each NapCat instance to its own URL. Bearer tokens can differ per adapter.

---

## Protocol version differences

| Feature              | v11 (NapCat default)                  | v12 (Lagrange option)          |
| -------------------- | ------------------------------------- | ------------------------------ |
| `message_type` field | yes                                   | no — uses `detail_type`        |
| `user_id` type       | number                                | string                         |
| @-mention segment    | `at` with `qq` field                  | `mention` with `user_id` field |
| Send action          | `send_private_msg` / `send_group_msg` | `send_message`                 |
| Delete action        | `delete_msg`                          | `delete_message`               |

cognia-next auto-detects the version from the first event and caches it per adapter instance. You do not need to configure this manually.
