# Logto email delivery / Logto 邮件投递

This Worker connects a self-hosted Logto **HTTP Email** connector to Cloudflare
Email Sending. It is separate from `cognia-status`: authentication mail must not
require changing the public status service's notification routes or database.
Authentication mail uses the dedicated `auth.cognia.cn` sending domain.

本 Worker 将自托管 Logto 的 **HTTP Email** connector 接入 Cloudflare Email Sending。
它独立于状态服务，使用专属 `auth.cognia.cn` 发信域名。

## Deploy / 部署

The account must have Email Sending enabled for the configured sender domain.
`wrangler.toml` restricts the email binding to `noreply@auth.cognia.cn`.
Disable the sending domain's `preview_enabled` setting: authentication mail
must not retain OTP bodies in Cloudflare activity-log previews.
The endpoint accepts only authenticated Logto code messages; it cannot accept
arbitrary subjects, bodies or sender addresses.

账号需已开通对应域名的 Email Sending。发信地址由 binding 固定，接口仅接受经过认证的
Logto 验证码请求，不接受调用方指定的标题、正文或发件地址。发信域名的
`preview_enabled` 设为 `false`，避免在 Cloudflare 活动日志预览中保留验证码正文。

Create a private JSON file outside the repository, mode `0600`, containing a
two independent random secrets of at least 32 characters:

在仓库外建立权限为 `0600` 的私有 JSON 文件，保存两个独立生成、至少 32 字符的密钥：

```json
{
  "LOGTO_EMAIL_TOKEN": "<random authentication secret>",
  "LOGTO_EMAIL_HASH_KEY": "<independent stable hashing secret>"
}
```

Deploy with Wrangler (the identity service already has a pinned installation):

使用 Wrangler 部署；本仓库 identity service 已有固定版本的安装：

```sh
pnpm --dir services/identity-server exec wrangler deploy \
  --config ../../services/logto-email/wrangler.toml \
  --secrets-file /absolute/private/worker-secrets.json
```

The custom domain is `logto-email.cognia.cn`; `workers.dev` and preview URLs are
disabled. No Wrangler OAuth credential is copied into Logto or this Worker.

服务使用 `logto-email.cognia.cn`，关闭 `workers.dev` 与预览地址。
不要把 Wrangler OAuth 凭据写入 Logto 或 Worker。

Both secrets and the `DELIVERY` Durable Object binding are mandatory; missing
configuration returns `503`. The `email-delivery-v1` migration provisions
SQLite-backed objects. Keep migration tags after deployment.

两个密钥与 `DELIVERY` binding 都必须配置，否则拒绝发送并返回 `503`。
`email-delivery-v1` migration 创建 SQLite Durable Objects，部署后保留 migration tag。

## Configure Logto / 配置 Logto

Back up the current sign-in experience and connectors before making changes.
Select the **HTTP Email** connector and configure:

先备份现有登录策略及 connector，再选择 **HTTP Email** connector：

```json
{
  "endpoint": "https://logto-email.cognia.cn/send",
  "authorization": "Bearer <the same LOGTO_EMAIL_TOKEN>"
}
```

Add this method to the existing `signIn.methods` array, retaining all existing
methods and the rest of the sign-in experience:

在现有 `signIn.methods` 数组中增加以下项，保留其他登录方式与安全策略：

```json
{
  "identifier": "email",
  "password": false,
  "verificationCode": true,
  "isPasswordPrimary": false
}
```

This enables **login for accounts with a primary email**. It does not change
registration: the current deployment still requires username/password during
account creation, and an account without a password may be asked to set one on
first login. Mandatory TOTP and recovery-code enrollment remain in force.
Do not silently attach an email to an existing social account or disable MFA.

此配置为**已设置主邮箱的账号**启用验证码登录，不改变注册要求。当前部署仍要求
用户名与密码；无密码账号首次登录时可能需补设密码。TOTP 与恢复码策略继续生效。
不要自动将邮箱绑定到现有社交账号，也不要为了测试关闭 MFA。

Set Logto's `verificationCodePolicy` to the following values. Keep expiry
aligned with `CODE_TTL_SECONDS` in `template.ts`; the email and delivery dedupe
window use the same five-minute duration.

设置以下 Logto 验证码策略。有效期须与 `template.ts` 的 `CODE_TTL_SECONDS` 一致，
邮件文案与投递去重窗口均使用五分钟：

```json
{
  "verificationCodePolicy": {
    "expirationDuration": 300,
    "maxRetryAttempts": 5
  }
}
```

Templates support `SignIn`, `Register`, `ForgotPassword` and `Generic`, in English
and Chinese (`payload.locale`). HTML uses inline styles, a contiguous copyable
code, mobile and dark-mode styles, and a plain-text alternative. No remote
images, fonts or tracking resources load. The subject and preheader omit OTPs.

支持中英文 HTML 与纯文本模板；验证码连续可复制，适配窄屏和暗色模式，无远程图片、
字体或追踪资源。标题与预览文案不包含验证码。

## Delivery safety and concurrency / 投递安全与并发

- Authenticated JSON bodies are limited to 16 KiB while streaming, with a
  three-second body deadline. Invalid UTF-8 and malformed payloads are rejected.
- Each recipient maps to a separate Durable Object through a keyed HMAC.
  Transactions reserve an attempt and its cleanup alarm atomically before
  sending. If alarm setup fails, the reservation rolls back and no mail is sent.
  A burst of the same
  recipient/purpose/code shares one provider attempt; different recipients
  progress independently. Successful duplicates remain suppressed across
  restarts for five minutes.
- Recipients share a 60-second cooldown and a sliding limit of 10 attempts per
  hour across all template usages. Failures count toward this budget.
- Provider calls have an eight-second HTTP deadline. A timeout does not cancel
  a provider send. Unknown outcomes are retained and not automatically resent;
  late acceptance is recorded. A genuinely new code can be requested after the
  cooldown. `429` and temporary failures include `Retry-After`.
- Durable storage holds only HMAC digests, timestamps and status, never raw
  addresses, codes, IPs or bodies. An alarm deletes state one hour after the
  last attempt. Provider errors are not echoed or logged.

- 流式读取时执行 16 KiB 上限和三秒超时，拒绝非法 UTF-8 与畸形请求。
- 按收件人 HMAC 分片，每个 Durable Object 独立协调；发送前在同一事务中预留尝试与
  cleanup alarm，alarm 失败则回滚且不发送。同一收件人、
  用途和验证码的并发请求共用一次投递，成功去重状态可跨重启保留五分钟。
- 同一收件人的所有用途共用 60 秒冷却、每小时最多 10 次的滑动窗口，失败也计数。
- 投递等待上限八秒；超时不代表发送已取消。未知结果不自动重发，迟到成功仍记录；
  冷却后可以申请新验证码。限流和暂时失败返回 `Retry-After`。
- 持久状态仅保存 HMAC、时间与结果，不保存原始地址、验证码、IP 或正文；最后一次
  尝试一小时后由 alarm 删除。异常详情不回显、不写日志。

`200` means provider acceptance or a previously accepted duplicate, **not inbox
delivery**. The Worker does not issue or verify codes; Logto owns expiry,
attempt counting, consumption and MFA. Logto's own frontend resend countdown
and identifier lockout remain enabled. There is no promise of exactly-once
delivery or unlimited provider throughput.

`200` 表示服务接受请求或已接受的重复请求，不代表收件箱已收到邮件。验证码的生成、
校验、消费和 MFA 仍由 Logto 负责；保留其重发倒计时和标识符锁定。此服务不承诺
邮件恰好送达一次，也不能突破邮件服务商的吞吐与配额。

## Local Logto transport / 本机 Logto 连接复用

The local Compose overlay preloads `deploy/compose/logto-mail/preload.mjs` and
mounts a small Got adapter beside the pinned HTTP Email connector. This adapter
extends the connector's existing Got instance with a bounded HTTPS pool: up to
64 active and 32 idle sockets per origin, a 90-second socket timeout, and a
20-second request deadline. Other Logto connectors and Got consumers retain their
original client. TLS verification and request-specific authorization stay intact;
POST is not added to Got's retry methods.

本机 Compose 为 HTTP Email connector 单独启用有界 HTTPS 连接池：每个 origin 最多
64 个活动连接、32 个空闲连接，socket timeout 为 90 秒，请求等待最多 20 秒。
其他 connector 不使用此适配器。鉴权仍逐请求传递，保留 TLS 校验，POST 不自动重试。
远端可以主动关闭连接，90 秒配置不保证连接始终存在。

These deployment modules are necessary because the pinned, read-only Logto image
owns the outgoing HTTP client; changing the Cloudflare Worker cannot remove client
DNS/TLS setup. They reuse the installed Got package without editing vendor files
or adding a runtime dependency. The Node module hook requires Node 22.15 or newer;
the current image was checked with Node 22.23.3 and Got 14.0.0. Recheck native
connector loading whenever changing `LOGTO_IMAGE`.

出站客户端位于只读 Logto 镜像内，因此在部署层挂载适配器，复用镜像已有 Got，
不修改第三方源码。需要 Node >=22.15；当前已验证 Node 22.23.3／Got 14.0.0。
升级镜像时须重新验证 connector 的真实加载路径。此配置在本机 overlay 启用，
独立的 production overlay 不会自动继承它。

The Cloudflare comparison kept every recipient DO fresh but reused client
connections after 6.5 seconds idle. Median per-request client completion improved from
1199.5ms to 675.5ms across ten paired 32-request batches; candidate acceptance was
320/320 versus 315/320 for the baseline. This does not remove named-DO cold lookup
or establish cold-process/mailbox-delivery latency. See the experiment report below.

十组配对实测中，32 并发的新收件人请求在空闲 6.5 秒后，客户端响应中位数由
1199.5ms 降至 675.5ms；新路径 320/320 接受，基线有 5 次连接失败。
此结果限定为已有客户端连接池的场景；命名 DO 冷路径仍存在，未重新测公网收信耗时。

```sh
node --test deploy/compose/logto-mail/preload.test.mjs
docker compose --env-file deploy/compose/.env.logto.local \
  -f deploy/compose/docker-compose.yml \
  -f deploy/compose/compose.local.logto.yaml up -d --no-deps --wait logto
```

To roll back just the transport, remove the preload export from the local
entrypoint and recreate only `logto`. Leave the mail Worker namespace, hash key,
connector credentials, PostgreSQL and Redis in place so quotas and dedupe survive.

仅回退连接池时，移除本机 entrypoint 的 preload export 后重建 `logto` 服务。
保留邮件 Worker namespace、hash key、connector 凭据及数据库，去重与限流不会迁移。

## Verify and recover / 验证与恢复

```sh
pnpm test --runTestsByPath services/logto-email/index.test.ts \
  services/logto-email/delivery.test.ts services/logto-email/template.test.ts \
  lib/logto/client.test.ts lib/logto/discovery.test.ts --runInBand
node scripts/smoke/logto-email-runtime.mjs
```

Use Cognia's normal Logto page, enter an account's primary email, confirm that an
incorrect code is rejected, and complete the received code and required MFA.
Verify the PKCE callback and token signature, issuer, audience and expiry.
Remove temporary users and revoke their tokens after verification.

通过 Cognia 的 Logto 登录页实测收信、错误验证码拒绝、正确验证码及 MFA、PKCE 回调
和 token 校验；完成后删除临时账号并撤销测试 token。

The smoke uses Wrangler's Miniflare/esbuild dependencies from the independently
managed `services/identity-server` installation. Install that service's dev
dependencies first if it is not already prepared.

The smoke runs compiled code in workerd with real local SQLite and a local mail
receiver. It never sends internet email. It checks 32-request bursts, restart
dedupe, recipient isolation and cooldown; raw results go under
`.cache/logto-email-hardening/`. Synthetic latency is not a mailbox delivery
benchmark. The durable path adds coordination/storage cost.

smoke 使用独立管理的 `services/identity-server` 安装中的 Wrangler/Miniflare/esbuild；
尚未准备该环境时，先安装该服务的开发依赖。
smoke 在 workerd 中运行真实编译产物和本地 SQLite，使用本地收件器，不向公网发信。
它验证 32 并发、重启去重、收件人隔离与冷却，原始记录位于
`.cache/logto-email-hardening/`。合成耗时不代表公网邮件速度；持久化协调有额外成本。

For a comparison against an already durable revision, keep its source and relative
imports in a local snapshot and explicitly use `--baseline-durable`. Without that
flag, the baseline is treated as the old uncoordinated sender and cannot establish
a persistence optimization. Use alternating paired batches and check compatibility:

比较已有持久化版本时，先保存其源码及相对导入，再显式传入 `--baseline-durable`；
否则基线按旧版无协调发送器处理，不能用于证明持久化优化。交替测量配对批次：

```sh
node scripts/smoke/logto-email-runtime.mjs \
  --baseline /absolute/path/to/baseline/index.ts --baseline-durable \
  --paired --samples 30 --check-compatibility \
  --output .cache/logto-email-comparison
```

`--guards-only` skips timing and checks restart-safe sliding quotas, unknown
outcomes, and state compatibility across baseline → current → baseline reloads.
The clock used by quota fixtures never enters deployment code or timing samples.
Run local timing separately from builds and tests. Report medians and MAD;
small changes within noise are inconclusive. The [2026-10-21 experiment report](../../docs/reports/2026-10-21-logto-email-persistence-performance.md)
records rejected storage/RPC experiments as well as the retained correctness fix.

`--guards-only` 跳过计时，只验证跨进程重启的滑动额度、未知结果不重发，以及升级/回滚的
状态兼容。额度测试时钟不进入部署代码或计时样本。计时应与构建、测试分开执行；记录
中位数与 MAD，噪声内的小幅变化不算提速。上述报告保留失败实验，避免重复采用无效改写。

For rollback, remove only the email sign-in method before removing its connector;
preserve the other current policies. To rotate the authentication secret, deploy
the new token plus the old token as optional `LOGTO_EMAIL_PREVIOUS_TOKEN`, update
the Logto connector, verify sending, then remove the previous token. Preserve
`LOGTO_EMAIL_HASH_KEY` during rotation so dedupe and quotas retain their identity.
Never commit connector credentials,
verification codes, tokens or MFA enrollment material.

回滚时先移除邮箱登录方式，再删除邮件 connector，保留其他当前策略。认证密钥轮换时
先部署新 token，同时用可选 `LOGTO_EMAIL_PREVIOUS_TOKEN` 接受旧 token，再更新
Logto connector、验证发信，最后移除旧 token。轮换时保持 `LOGTO_EMAIL_HASH_KEY`
不变，避免丢失去重与配额身份。凭据、验证码、token 和 MFA 材料不得提交。

Sources / 参考：

- [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/)
- [Cloudflare Workers email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Logto HTTP Email connector](https://docs.logto.io/integrations/http-email)
