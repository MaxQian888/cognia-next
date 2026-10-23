# Logto DO cold-path follow-up and real mailbox login — 2026-10-21

## Outcome / 结论

本轮完成固定分片的隔离对照，以及正式账号 `cognia_max` 的真实邮箱 OTP → 已有 TOTP →
Cognia PKCE callback → JWT 校验 → refresh → refresh token 撤销完整流程。

**没有上线新的 DO 路由或存储改写。** 固定分片只有在对象已激活时明显更快；真正冷启动时
客户端主指标没有改善。保留已有每收件人 DO、原有 namespace/密钥/事务，以及上一轮的
Logto 专属 HTTPS 连接池。没有为了快速通过测试重置 MFA、清空限流或去重状态。

## Pre-registered comparison / 预登记对照

- User path: fresh recipient → authenticated mail boundary → durable reservation →
  mail provider acceptance. Main metric: median per-request client duration per batch.
- Actual local Logto container, Node 22.23.3 / Got 14.0.0, using its mounted HTTPS
  adapter; same machine, network, deployment and shared connection pool across arms.
- Temporary Cloudflare Worker, SQLite DOs and a fixed 20ms Worker RPC mail receiver.
  Recipients are exclusively `example.invalid`; the probe has no Email Sending binding.
- Baseline: unchanged per-recipient HMAC named DO and `EmailDelivery` implementation.
- Candidate: 16 deterministic buckets, recipient-specific storage keys and transient
  in-flight actors; provider work stays outside the reservation transaction. The same
  delivery implementation performs reservation, quota checks and acceptance storage.
- Three arms: fresh baseline recipient DOs; fresh candidate shard names each batch;
  reused candidate shards prewarmed once before all rounds. All recipients are new
  in every arm. Prewarming is explicitly part of the reused-shard condition.
- One warmup plus ten measured rounds, 32 independent HTTP requests per arm, rotating
  arm order. No measured POST retries. Raw results include failures.
- Practical/noise gate: paired median client gain ≥10%, and greater than twice the
  paired-difference MAD. Guardrails require correct application responses/counts and
  candidate acceptance at least as good as baseline.
- First attempt aborted on HTTP 522 in round 7, with no Worker/handler timing header.
  Its raw response is retained and not silently dropped or classified as DO execution.
  A second contract was registered before rerunning: retain network/522 failures,
  abort application/counter failures, complete ten rounds and evaluate acceptance.

Contracts and raw data are in `.cache/logto-email-cold-next/`:
`experiment.json`, `experiment-v2.json`, `benchmark-aborted-7.jsonl`,
`benchmark-v2.jsonl`, `benchmark-v2-summary.json`. The isolated prototype and client
remain in that cache for reproduction; neither enters the production bundle.

## Measured results / 实测结果

Ten measured rounds per arm; durations are median ± MAD in milliseconds:

| Arm                                      | Client median per batch | Worker median per batch | Accepted |
| ---------------------------------------- | ----------------------: | ----------------------: | -------: |
| New recipient, one cold DO per recipient |          651.69 ± 12.89 |           419.50 ± 6.50 |  320/320 |
| New recipients, 16 cold shards           |          661.62 ± 20.06 |          397.50 ± 15.50 |  320/320 |
| New recipients, 16 already active shards |           311.56 ± 7.76 |            62.00 ± 1.00 |  320/320 |

All successful requests in the completed run recorded provider count=1.

- Cold shards: paired gain **−9.89ms**, paired MAD **23.87ms**, relative gain
  **−1.46%**. Fails both practical and noise gates; no cold-path speedup established.
- Already active shards: paired gain **345.11ms**, paired MAD **18.30ms**, relative
  gain **53.29%**. This is a measured amortization benefit under this warm condition;
  it does not establish lower initial or reactivation latency.
- Warm-shard handler median is 29ms, cold-shard handler 59ms, baseline 58.5ms.
  The large warm benefit is consistent with avoiding activation/lookup work, rather
  than a faster email template. No sub-millisecond precision is claimed for Worker
  clock measurements.
- These small batches are not a production capacity, p95 or provider throughput
  certification. The first aborted run remains a recorded failure.

Cloudflare documents that named IDs require a first-use global uniqueness check,
whereas randomly allocated IDs can skip it. Random IDs still require a persisted,
consistent mapping to preserve identity. Location hints apply only to initial
placement and do not relocate existing objects. Sources are linked below.

## Safety decision / 安全判定

A direct switch from per-recipient objects to bucket objects would make existing
`delivery` records unreachable. Those records include the rolling hourly timestamps
and accepted/pending/uncertain message digests. Empty bucket state cannot be treated
as evidence that a recipient has never sent a message.

A safe future migration would have to preserve those states, serialize concurrent
migration/sends, persist routing decisions before provider dispatch, cover all old
objects and in-flight requests, and support a state-preserving rollback. During any
lazy legacy lookup, new recipients still pay the cold lookup being optimized.
Merely retaining the same HMAC key or adding a memory cache does not solve this.

Because the measured true-cold candidate failed the performance gate, no production
migration machinery or scheduled prewarming was added. The shared-shard prototype's
happy-path counters are not a proof of its restart, cleanup or rollback safety.
Production correctness checks below apply to the retained production implementation.

## Actual mailbox login / 真实邮箱完整登录

One manually assisted login used the existing bound QQ mailbox and formal account.
The user received the email and supplied its OTP, then entered the existing TOTP in
an isolated headed Chromium session. No new account or MFA enrollment was created.

The harness uses the repository's actual `loginToLogto`, `refreshLogtoToken` and
`revokeLogtoToken` functions, with a loopback callback registered on the existing
native client. Tokens stay in process memory; no session/token file is written.
Browser measurement records only API path, start time, status and duration, without
request bodies, OTPs, TOTP values, credentials or authorization codes.

| Stage                              | Observed result / duration                                             |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Request email OTP                  | HTTP 200, **2320ms**                                                   |
| QQ receiving-server delivery event | `delivered` at 2026-10-21T12:05:42Z, about **5.6s** from request start |
| Verify email OTP                   | HTTP 200, **38.5ms**                                                   |
| Identify formal account            | HTTP 204, **21.4ms**                                                   |
| Submit before mandatory MFA        | HTTP 403, gate remains enforced                                        |
| Invalid TOTP observed              | HTTP 400                                                               |
| Valid existing TOTP                | HTTP 200, **38.0ms**                                                   |
| Submit authenticated interaction   | HTTP 200, **30.6ms**                                                   |
| Callback → tokens ready            | **52ms**, token request **50.4ms**                                     |
| Refresh                            | **18.8ms**, successful rotation                                        |
| Refresh revocation and reuse       | revocation accepted; subsequent refresh rejected as `invalid_grant`    |

Cloudflare's event query filtered the exact recipient, `auth.cognia.cn`, and this
request's time window. Its `delivered` status means the receiving mail server accepted
mail; it does not measure inbox visibility. Event timestamps have second precision.
The roughly 3.25 seconds from API response to that event is downstream delivery time.
No internal DO timing was added to this real email request, so its 2.32 seconds cannot
be split into DO, provider and network time using this sample alone.

Signed ID/access token claims matched the existing formal subject; verified email,
issuer, audience, expiry and signatures passed, while a deliberately wrong audience
was rejected. Refresh tokens were revoked after verification. The browser was closed.

The full interactive harness took 331.1 seconds, including preparation, mailbox reading,
chat exchanges and MFA input. That duration is not server latency. This is one complete
real login, not a statistical inbox latency comparison or proof of new-recipient cold
creation: the real mailbox already had a DO, whereas the isolated comparison uses
fresh recipients. No full-login speedup is claimed from the rejected shard candidate.

Evidence: `browser-timing.json`, `real-login.json`, `email-delivery-confirmed.json`,
`security-readback.json` in `.cache/logto-email-cold-next/`. No OTP or TOTP value is
included in the evidence files or this report.

## Checks and cleanup / 检查与清理

- Focused Jest: **5 suites / 71 tests passed**.
- Native connector loader isolation test: **1 passed**.
- Real workerd guards: all five passed — concurrent different-code cooldown,
  upgrade/rollback dedupe, unknown outcome without resend, hourly quotas across full
  process restarts, exact sliding-window boundary.
- Repository `pnpm lint`: passed. Final review follows the user’s instruction to
  check only corresponding files and skip further typecheck; the earlier scoped
  Worker TypeScript check had already passed.
- Read-back: formal email/Feishu unchanged; MFA `Mandatory`, existing TOTP and 10 unused
  backup codes remain; OTP policy 300 seconds / 5 attempts; connector URL and credential
  unchanged.
- No coverage requested or run. Main-app build and Tauri/Capacitor UI not rerun; this
  turn changes no application, connector, Worker or Compose deployment source.
- Cleanup verified through Cloudflare API: temporary Worker, domain and both SQLite
  namespaces removed. The private benchmark secret and spent authorization URL were
  deleted; raw redacted evidence remains under the task cache.
- Production remains at `6e29ac41-b9b1-421d-8def-7fec8a6d1cb5`, 100% traffic;
  `EmailDelivery` binding/source unchanged. Logto container remains healthy.
- Actual Logto adapter without authorization returned **401**. The host Python
  diagnostic was separately rejected with Cloudflare **403 / 1010** (browser-signature
  block), so it cannot establish Worker status. No security rule was disabled.
- Final verification: `cleanup-verification.json`; scoped formatting and diff checks
  passed. No application, Worker, connector or Compose source changed this turn.

## Sources / 参考

- [Cloudflare namespace API: named versus random IDs](https://developers.cloudflare.com/durable-objects/api/namespace/)
- [Cloudflare DO data location and placement hints](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Cloudflare Email Service activity statuses](https://developers.cloudflare.com/email-service/observability/logs/)
- [Cloudflare Email Service GraphQL event metadata](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)
- [Cloudflare error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
