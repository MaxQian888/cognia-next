# NapCat protocol validation — 2026-10-21

## Outcome

Downloaded the official NapCat v4.18.38 Shell package and universal macOS
installer v1.7, verified both published SHA-256 digests, and exercised Cognia
against the release's actual WebSocket protocol modules with an offline QQ
kernel fixture. No QQ login or Tencent message delivery was attempted.

The protocol exercise exposed two history defects, now fixed in the working
tree:

- A failed NapCat history response was treated as an empty successful result.
  Cognia now requires both `status: "ok"` and `retcode: 0`, preserving the
  platform diagnostic on rejection.
- History pagination requested an additional page after a partial page or
  after reaching `max`. NapCat returns a failed response when no messages
  exist past that cursor. Cognia now stops at those boundaries.

The change is limited to `lib/connectors/adapters/onebot/index.ts` and its
co-located `index.test.ts` and `contract.test.ts`. This dated report is a new
file because the generic setup guide does not own machine-specific download
checksums, test artifacts, and acceptance evidence. No commit was created.

## Download and version evidence

Checked on 2026-10-21 in Asia/Shanghai. GitHub's latest stable release was
v4.18.38, published on 2026-10-12. The release tag is annotated:

- Commit: `bbd0d2aca3d470c20b33b1d4f95123335633bf26`
- Tag object: `e0f817edf1a32d0825d433bbf9c8e9dc06b32873`
- The archive's PAX comment matches that commit; the server source also
  matches the current tag's raw source byte-for-byte.

Downloads are under `/Users/bytedance/Downloads/NapCat-v4.18.38/`:

| Artifact                          | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `NapCat.Shell.zip`                | `735f2e633247df3ffd6e8ee8b84d7039c315b2655f5807e5f0029f93d2c30016` |
| `NapCatInstaller_arm64.amd64.zip` | `93537837ae2a5d645393fbe67a758fbaebe93ca2b8cad3a608582c4be12a92a4` |

Both were compared with GitHub release asset digests, then extracted into
`Shell/` and `Installer/`. The installer executable permissions were restored
from the archive. The Mac is arm64 on macOS 26.5.2; installed QQ is 6.9.98
(51102). NapCat's release includes macOS arm64 and x64 entries for that QQ
version. This is compatibility-table evidence, not a successful QQ launch.
QQ's application entry point and installed files were not modified.

## Protocol and test boundaries

NapCat implements OneBot 11 plus NapCat extensions. Cognia's OneBot 12 support
is a separate compatibility path; it is not an upgrade requirement for
NapCat v4.18.38.

The offline harness builds the following official, unmodified NapCat source
modules and exchanges real JSON over loopback WebSocket sockets:

- Forward server and reverse client, token authentication, lifecycle,
  heartbeat, RPC dispatch, response wrapping, and TypeBox message schemas.
- `get_version_info`, `get_group_msg_history`, `get_friend_msg_history`,
  `set_msg_emoji_like`, `delete_msg`, and the message-ID mapping implementation.

The Cognia side uses the actual adapter, parser, serializer, and both
WebSocket transports. Its Tauri command/event seam is replaced with a Node
WebSocket relay; Dexie is replaced with an in-memory adapter repository.
Admission and native attachment storage are excluded from this harness.

QQ core history, account information, and final sending are fixtures.
`get_login_info`, send/merged-forward actions, `get_msg`, and `get_forward_msg`
have fixture handlers. Outbound media validation proves protocol schema and
serialization compatibility; it does not prove valid media decoding,
upload, forwarding, or delivery in QQ.

### Completed checks

| Check                                                                   | Result           |
| ----------------------------------------------------------------------- | ---------------- |
| Missing token rejected by official server                               | Passed           |
| Forward WS identity and official version response                       | Passed           |
| Outbound text, mention, reply, emoji, image, file, voice, video schemas | Passed           |
| Private-send request and echo correlation                               | Passed           |
| Failed action surfaces a non-retryable error                            | Passed           |
| Inbound group message, mention, quoted reply parsing                    | Passed           |
| Official history action, numeric IDs and 45-message pagination          | Passed           |
| History rejection reaches the caller                                    | Passed after fix |
| Official emoji add/remove and recall action dispatch                    | Passed           |
| Forward reconnect re-probes identity                                    | Passed           |
| Official reverse client headers and Cognia RPC                          | Passed           |
| Wrong token cannot produce an identity snapshot                         | Passed           |

The existing history hydration hook catches adapter errors and records its
`failed` state. Its test suite was included in the focused verification.

## Verification evidence

| Command/check                                                                                                                                                            | Actual result                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Initial OneBot and configuration tests                                                                                                                                   | 17 suites / 322 tests passed                                                                                                          |
| New acknowledgement regressions before fix                                                                                                                               | 3 failed with promises resolving instead of rejecting                                                                                 |
| New pagination boundary regressions before fix                                                                                                                           | 4 failed with an extra exhausted-cursor request                                                                                       |
| `pnpm test -- lib/connectors/adapters/onebot components/settings/connections/forms/onebot-config.test.tsx hooks/connectors/use-history-hydration.test.ts --runInBand`    | Exit 0; 18 suites / 342 tests passed                                                                                                  |
| Official-source loopback protocol harness                                                                                                                                | Exit 0; 12/12 passed                                                                                                                  |
| `cargo test -p cognia-connectors ws_ --lib -- --test-threads=1`                                                                                                          | Exit 0; 27 passed, 0 failed, 242 filtered out                                                                                         |
| `pnpm typecheck`                                                                                                                                                         | Exit 0; TypeScript reported no errors                                                                                                 |
| `pnpm exec eslint lib/connectors/adapters/onebot/index.ts lib/connectors/adapters/onebot/index.test.ts lib/connectors/adapters/onebot/contract.test.ts --max-warnings=0` | Exit 0                                                                                                                                |
| `pnpm lint`                                                                                                                                                              | Exit 1; 4 unrelated `no-require-imports` errors in `docs/research/2026-10-21-scheduler-adversarial-probes.cjs`                        |
| Scoped `git diff --check`                                                                                                                                                | Exit 0                                                                                                                                |
| Preflight test-gap and PII auditors                                                                                                                                      | No actionable findings; read-only inspection                                                                                          |
| Offline mock control smoke                                                                                                                                               | Passed authenticated connection, unique receipts, mention injection, sent-request inspection, and rejection of unauthorized injection |

Commands were run through the installed RTK wrapper where applicable. Full
lint's unrelated errors were left untouched. Existing configuration UI tests
emit timer/React act warnings despite passing; they are not browser UI
acceptance evidence. No coverage run was requested or performed.

No new browser E2E is needed for this internal protocol correction: its
behavioral contracts are owned by the adapter generator, the loopback
protocol harness, and the existing hydration-hook test. No UI was changed.
Full browser/static-export builds, a running Cognia Tauri UI, the Agent
auto-reply pipeline, and production QQ messages were not tested.

## Reusable offline mock

The local validation project, pinned upstream source, bundles, logs, and
`results.json` are in:

`/Users/bytedance/Downloads/NapCat-v4.18.38/Validation/`

Rebuild against the current checked-out Cognia source, then rerun:

```sh
node /Users/bytedance/Downloads/NapCat-v4.18.38/Validation/build.mjs
node /Users/bytedance/Downloads/NapCat-v4.18.38/Validation/build-cognia.mjs
node /Users/bytedance/Downloads/NapCat-v4.18.38/Validation/verify.mjs
```

The source build uses the repository's installed esbuild/TypeScript. A
document-parser `import.meta` warning appears while making the temporary CJS
bundle; that parser is not executed by the OneBot harness. The harness and
its native dependencies remain outside the repository's dependency graph.

Start the interactive fixture (no QQ login required):

```sh
node /Users/bytedance/Downloads/NapCat-v4.18.38/Validation/verify.mjs --serve
```

| Cognia setting  | Fixture value                              |
| --------------- | ------------------------------------------ |
| Transport       | Forward WS                                 |
| Expected client | NapCat                                     |
| Bot UIN         | `100000`                                   |
| WebSocket URL   | `ws://127.0.0.1:3011`                      |
| Bearer Token    | `fixture-only-token` (local fixture value) |
| Test group      | `300001`                                   |

The control API binds only to `127.0.0.1:3012`. `GET /health` shows readiness.
Authenticated `POST /inject` emits a fixture message; authenticated
`GET /sent` returns the last 200 send requests. Example:

```sh
curl -sS http://127.0.0.1:3012/inject \
  -H 'Authorization: Bearer fixture-only-token' \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello from the offline test group"}'
```

It mentions bot `100000` by default. Set `"mention": false` to omit the
mention, `"private": true` for a private event, or `"replyTo": "<message-id>"`
to include a quote. Keep real account credentials out of this fixture.
Connecting a real Cognia runtime and enabling a model may invoke that
runtime's normal Agent pipeline; the standalone protocol tests do not.

This is a local test harness built from NapCat protocol source, not an
official QQ server emulator or a substitute for logged-in QQ acceptance.

## Sources

- [Official NapCat v4.18.38 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.38)
- [Official macOS installer v1.7](https://github.com/NapNeko/NapCat-Mac-Installer/releases/tag/v1.7)
- [Shell installation and macOS support](https://napneko.github.io/guide/boot/Shell)
- [NapCat OneBot implementation](https://napneko.github.io/onebot/index)
- [Pinned WebSocket server source](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-onebot/network/websocket-server.ts)
- [Pinned group-history action](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts)
