# Cloudflare 部署 Share 与 Diagnostics 的可行性研究

Date: 2026-08-21

## 结论摘要

- **Share 可以立即部署到 Cloudflare。** 仓库已经有可部署的 TypeScript Worker，使用 R2 存密文 envelope、KV 存 TTL/浏览次数/撤销状态，并保持与 Rust 服务相同的 HTTP 路径和响应形状（[Worker README](../../services/share-server/worker/README.md)、[实现](../../services/share-server/worker/src/index.ts)、[Wrangler 配置](../../services/share-server/worker/wrangler.toml)）。如果目标只是尽快摆脱腾讯云源站、证书和接入备案故障，这条路径已经足够成熟。
- **现有 Share Worker 不是严格的语义等价实现。** Cloudflare 明确说明 KV 是最终一致的，旧值在其他地区可能 60 秒或更久才失效，而且 KV 不适合原子读改写；因此并发读取时 `burnAfterRead` / `maxViews` 可能被超额读取（[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)）。Rust/SQLite 实现则用原子事务推进计数并删除耗尽记录（[Share server README](../../services/share-server/README.md)）。生产推荐改为 **Worker + 每个 share 一个 SQLite-backed Durable Object + R2**。
- **Diagnostics 不能像 signaling 一样直接编译成普通 Worker。** 当前服务是原生 Rust/Axum 进程，依赖 PostgreSQL、S3/MinIO、AWS KMS 协议、临时文件系统、后台循环和外部 `minidump-stackwalk` 进程（[Cargo.toml](../../services/diagnostic-server/Cargo.toml)、[main.rs](../../services/diagnostic-server/src/main.rs)、[processing.rs](../../services/diagnostic-server/src/processing.rs)）。Workers 的 Rust 运行时是 `wasm32-unknown-unknown`，WASI 仍属实验性且只实现部分系统调用，不能原样承载该进程模型（[Cloudflare Rust Workers](https://developers.cloudflare.com/workers/languages/rust/)、[Workers Wasm/WASI](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)）。
- **Diagnostics 可以部分或整体迁入 Cloudflare 产品组合，但至少需要 Workers Paid。** 低改造方案是 Cloudflare Worker/Container 运行现有 API 与 stackwalker，外接托管 PostgreSQL、R2 和外部 KMS；长期方案再拆成 Worker API、R2、D1 或 PostgreSQL、Queues 和专用 symbolication Container。Containers 只在 Workers Paid 提供（[Containers overview](https://developers.cloudflare.com/containers/)）。

## 研究范围与仓库事实

本报告只使用 Cloudflare 官方资料和本仓库源代码/ADR。价格、配额和产品状态以 2026-08-21 查到的官方页面为准，实际部署前仍应重新核对。

Share 是保存客户端 AES-GCM 密文的 blind store，服务端拿不到 URL fragment 中的解密密钥。API 包括创建、读取、统计、续期、撤销、TTL、最大浏览次数和 burn-after-read（[Worker README](../../services/share-server/worker/README.md)）。当前 Cloudflare 实现已经具备完整路由、认证、owner token、R2/KV bindings、测试和 staging 配置（[Worker source](../../services/share-server/worker/src/index.ts)、[wrangler.toml](../../services/share-server/worker/wrangler.toml)）。

Diagnostics 是另一类负载。ADR-0102 要求一个自托管、多租户、可撤回/删除、服务端隐私扫描、符号化、分组、保留、告警、审计和 envelope encryption 的系统（[ADR-0102](../content/docs/en/adr/0102-unified-observability-crash-diagnostics.md)）；ADR-0135 又把 resumable upload、triage、tenant policy、raw artifact access 和 key rotation 等路径接入产品（[ADR-0135](../content/docs/en/adr/0135-diagnostic-service-completion.md)）。这不是一个简单的无状态 JSON API。

需要特别澄清：**`diagnostic-server` 当前没有 OTLP ingest endpoint。** 仓库中的 OTLP 是桌面端可选的 trace/metric exporter；异常服务接收的是 `/v1/incidents`、checked parts、symbols 和管理 API（[OpenAPI](../../services/diagnostic-server/openapi.yaml)、[ADR-0074](../content/docs/en/adr/0074-otel-native-telemetry.md)）。因此本次迁移不应顺手把通用 OTLP collector 纳入 Diagnostics；若未来需要 OTLP，应作为独立接入面设计。

## Cloudflare 产品能力、限制与费用

| 产品            | 与本项目的用途                                         | 关键限制                                                                                                                                      | 免费/付费层（当前官方值）                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workers         | API、鉴权、路由、轻量隐私规则、编排                    | 128 MB 内存；Free 每次 10 ms CPU；Paid 默认 30 秒、最高 5 分钟 CPU；Free/Pro 账户请求体 100 MB                                                | Free 100,000 请求/日；Paid 最低 $5/月，含 1,000 万请求和 3,000 万 CPU-ms，超额 $0.30/百万请求、$0.02/百万 CPU-ms（[limits](https://developers.cloudflare.com/workers/platform/limits/)、[pricing](https://developers.cloudflare.com/workers/platform/pricing/)）                                                                                                                                                                                                               |
| Durable Objects | Share 的强一致生命周期状态；按 share code 分片         | SQLite 单对象 Paid 10 GB；单 key/value 或 SQL row/BLOB 最大 2 MB；单对象约 1,000 req/s 软上限，故不能用一个全局对象                           | Free 100,000 请求/日、13,000 GB-s/日；Paid 含 100 万请求、400,000 GB-s，超额 $0.15/百万请求、$12.50/百万 GB-s；SQLite 行计费与 D1 类似（[limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[FAQ](https://developers.cloudflare.com/durable-objects/reference/faq/)）                                                                                                |
| KV              | 非关键配置、低频缓存；现有 Share metadata              | 最终一致；同一个 key 最多 1 write/s；单 value 25 MiB。不能严格实现 max-views/burn 原子性                                                      | Free 100,000 reads/日、1,000 writes/日、1 GB；Paid 含 1,000 万 reads、100 万 writes/月，超额分别 $0.50/$5.00 每百万（[limits](https://developers.cloudflare.com/kv/platform/limits/)、[pricing](https://developers.cloudflare.com/kv/platform/pricing/)）                                                                                                                                                                                                                      |
| R2              | Share 密文体；Diagnostics dump、attachment、symbol     | 单对象约 5 TiB；单次上传约 5 GiB，但经 Worker 入口仍受 Worker 请求体限制                                                                      | 每月免费 10 GB-month、100 万 Class A、1,000 万 Class B；Standard 超额 $0.015/GB-month、$4.50/百万 A、$0.36/百万 B，公网 egress 免费（[limits](https://developers.cloudflare.com/r2/platform/limits/)、[pricing](https://developers.cloudflare.com/r2/pricing/)）                                                                                                                                                                                                               |
| D1              | Cloudflare-native Diagnostics metadata 的候选          | SQLite 而非 PostgreSQL；单库串行执行；查询最长 30 秒；单 row/BLOB 2 MB；Paid 单库 10 GB                                                       | Free 500 MB/库、5 GB/账户、500 万 rows read/日、100,000 rows written/日；Paid 含 25 billion reads、50 million writes、5 GB，超额 $0.001/百万 reads、$1/百万 writes、$0.75/GB-month（[limits](https://developers.cloudflare.com/d1/platform/limits/)、[pricing](https://developers.cloudflare.com/d1/platform/pricing/)）                                                                                                                                                       |
| Queues          | 异步 processing、retention、alert 触发                 | 消息最大 128 KB，只能放 incident/object key；最长保留 14 天；consumer 最长 15 分钟 wall time、最高 5 分钟 CPU；默认至少一次投递，处理必须幂等 | Free 10,000 operations/日、24h retention；Paid 含 100 万 ops/月，超额 $0.40/百万；正常一次投递通常产生 write/read/delete 三次操作（[limits](https://developers.cloudflare.com/queues/platform/limits/)、[pricing](https://developers.cloudflare.com/queues/platform/pricing/)、[delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)）                                                                                                           |
| Containers      | 原生 Axum、`minidump-stackwalk`、临时文件、重 CPU 处理 | 仅 HTTP 经 Worker 进入；必须 `linux/amd64`；磁盘完全临时，休眠/重启后丢失；当前无内建自动扩缩容/智能负载均衡，需显式 ID 或固定随机池          | 仅 Paid；$5 套餐含 25 GiB-hours memory、375 vCPU-min、200 GB-hours disk；实例从 256 MiB/1⁄16 vCPU/2 GB 到 12 GiB/4 vCPU/20 GB（[architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)、[scaling](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/)、[limits](https://developers.cloudflare.com/containers/platform-details/limits/)、[pricing](https://developers.cloudflare.com/containers/pricing/)） |

## Share：可部署性与等价性

### 现在就能部署的路径

现有 Worker 已经覆盖生产 API，并且 10 MiB body cap 明显低于 Free/Pro 的 100 MB Worker 请求体限制。R2 的 10 GB-month 免费存储和免公网 egress 也适合短生命周期密文对象。只需完成生产 KV namespace、R2 bucket、`SHARE_UPLOAD_SECRET`、DNS route 和部署凭证的配置；这些前置步骤已写在 [Worker README](../../services/share-server/worker/README.md) 和 [wrangler.toml](../../services/share-server/worker/wrangler.toml) 中。

这一路径会让 API 和 TLS 落在 Cloudflare 边缘、不再反代腾讯云上的 Share 进程，因此能从架构上绕开当前腾讯云源站的证书与接入备案拦截；中国大陆访问质量仍需单独验证。

### 中国大陆访问与备案边界

域名注册商在阿里云并不要求服务也部署在阿里云；此前被腾讯云拦截，更可能是因为已经取得的备案没有把腾讯云加入接入商。腾讯云官方说明，已在其他接入商备案的域名如果解析到腾讯云中国大陆服务器，仍需办理腾讯云接入备案；多个接入商可以并存（[腾讯云接入备案](https://cloud.tencent.com/document/product/243/97669)）。

迁到普通 Cloudflare 全球网络后，请求不再进入腾讯云大陆源站，因此可以避开这一个腾讯云接入校验点，但这不等于获得了 Cloudflare 中国大陆节点，也不能据此承诺大陆访问质量。Cloudflare 官方说明，全球网络流量跨越中国网络边界时可能有明显延迟和可靠性问题；真正的 Cloudflare China Network 是 Enterprise 的单独订阅，并且每个 apex domain 仍须提供有效 ICP 备案（[China Network overview](https://developers.cloudflare.com/china-network/)）。另外，China Network 当前不支持在中国大陆创建 R2 bucket，也不支持 R2 custom domain；需要 Global Acceleration 等单独方案（[available products](https://developers.cloudflare.com/china-network/reference/available-products/)）。

因此，“先恢复服务”和“优化大陆访问”应拆成两个目标：Share/Diagnostics 可以先部署在普通 Cloudflare 上做真实网络验证；若主要用户在大陆，再根据多省、多运营商探测结果决定是否补腾讯云接入备案、使用境外容器源站，或采购 Cloudflare China Network。

### 为什么 KV 版本不是完全等价

`handleRead` 先从 KV 读取 `viewCount`，再读取 R2，最后用异步 `ctx.waitUntil()` 更新 KV 或删除对象（[Worker source](../../services/share-server/worker/src/index.ts)）。两个并发请求可能同时读到同一个旧计数并都返回 payload；跨地区 KV 缓存又会放大窗口。Cloudflare 官方明确建议需要原子事务时使用 Durable Objects，而不是 KV（[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)）。

这对普通 TTL share 影响较小，但对 `burnAfterRead=true` 或 `maxViews=1` 是契约级风险。仓库中的 Rust 服务明确用 `BEGIN IMMEDIATE` 把计数推进和耗尽删除放在同一事务，并指出 R2+KV 无法提供同样保证（[Share server README](../../services/share-server/README.md)）。

### 推荐的 Share 生产架构

```text
Client
  -> share.cognia.cn/v1/* Worker
      -> Durable Object(id = hash/share code): authoritative metadata + serialized consume
      -> R2: opaque encrypted envelope
```

- 每个 code 映射到独立 SQLite-backed Durable Object，避免全局热点；DO 存 owner token hash、TTL、view count、revocation 和消费状态。
- envelope 继续放 R2。DO 单 row/value 最大 2 MB，而 Share 支持 10 MiB；把完整 envelope 塞进 DO 会需要分块和更多存储操作，没有必要（[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)）。
- 读取由 DO 串行化地 claim 一次 view，再返回 R2 对象；最后一次 view 在 claim 时使后续请求不可再读取。R2 读取失败时要定义 reservation 回滚/超时策略，否则会出现“没有超读，但一次读取额度被消耗”的可用性差异。
- KV 可保留为非权威缓存或完全移除。R2 本身是强一致对象存储（[R2 architecture](https://developers.cloudflare.com/r2/how-r2-works/)），真正的竞态来自 lifecycle metadata，而不是密文对象读取。

**决策建议：** 若当前首要目标是恢复服务，先部署现有 R2+KV Worker，并在产品/运营上暂时避免承诺严格一次读取；随后以 DO 迁移作为 P0 语义加固。若 burn-after-read 是安全承诺而非便利功能，则应先完成 DO 再上线。

## Diagnostics：哪些可以边缘化

### 可以迁到 Cloudflare 的部分

1. **入口路由、grant 验证、基础限流和 kill switch** 可以放 Worker，减轻 Container/API 压力。
2. **MinIO/S3 对象存储可以换成 R2。** R2 提供 S3-compatible API，官方说明现有 S3 代码通常只需更换 endpoint 和 credentials（[R2 S3 guide](https://developers.cloudflare.com/r2/get-started/s3/)）。当前 `ArtifactStore` 已基于 `object_store::aws::AmazonS3Builder` 并支持自定义 endpoint（[storage.rs](../../services/diagnostic-server/src/storage.rs)），这是整个 Diagnostics 中改造成本最低的一层。
3. **异步调度可以改用 Queues。** 消息只携带 `incidentId`、`tenantId` 和对象 key，不携带 dump；消费者依靠现有数据库状态机和幂等键去重。当前 SQL 已通过 `FOR UPDATE SKIP LOCKED` claim processing、retention 和 alert 工作（[db.rs](../../services/diagnostic-server/src/db.rs)），迁移到至少一次投递队列时必须保留同等级别的幂等控制。
4. **原生符号化可以放 Container。** Container 能运行现有 Linux 二进制、spawn `minidump-stackwalk` 并使用临时目录；临时文件在一次 job 后就被删除，符合 Container ephemeral disk 的约束（[processing.rs](../../services/diagnostic-server/src/processing.rs)、[Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)）。

### 不能无改造边缘化的部分

#### PostgreSQL

当前迁移和 repository 使用 PostgreSQL `uuid`、`jsonb`、`timestamptz`、row-level security/current settings、`ILIKE`、`FOR UPDATE SKIP LOCKED`、`RETURNING` 和多表事务（[migrations](../../services/diagnostic-server/migrations/)、[db.rs](../../services/diagnostic-server/src/db.rs)）。D1 可以保存关系 metadata，但不是 SQLx/PostgreSQL 的 drop-in replacement；完整迁移需要重写 schema、查询、claim/lease 算法、tenant isolation 和迁移工具。

短期应保留托管 PostgreSQL，并从 Container 直接连接。若未来把 API 重写成 Worker，可用 Hyperdrive 连接现有 PostgreSQL；Cloudflare 官方将 Hyperdrive 定位为 Workers 到现有 Postgres/MySQL 的连接池和查询加速层，而不是数据库本身（[Hyperdrive overview](https://developers.cloudflare.com/hyperdrive/)）。

#### KMS 与 crypto-shredding

当前服务不是只依赖存储层静态加密：它调用 AWS KMS `GenerateDataKey` / `Decrypt`，用 tenant encryption context 包裹 DEK，并通过删除 wrapped tenant keys 实现 crypto-shredding（[kms.rs](../../services/diagnostic-server/src/kms.rs)、[crypto.rs](../../services/diagnostic-server/src/crypto.rs)）。R2 加密不能替代这一应用层 tenant key lifecycle。迁移后仍需使用兼容现有 AWS KMS API 的外部 KMS，或单独实现并审计新的 `KeyWrappingService`；不能把 Worker secret 当作等价 KMS。

#### minidump-stackwalk 与处理资源

当前模型允许单个 incident 1 GiB、attachment 100 MiB、minidump 512 MiB（[model.rs](../../services/diagnostic-server/src/model.rs)）；symbolicator 会落盘 dump/symbol、spawn 原生进程，允许 120 秒超时，并读取最多 50 MiB stackwalk 输出（[config.rs](../../services/diagnostic-server/src/config.rs)、[processing.rs](../../services/diagnostic-server/src/processing.rs)）。这与普通 Worker 的 128 MB 内存、Wasm 系统调用和 Free/Pro 100 MB request body 明显冲突（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。

即便 API 后端是 Container，请求仍先经过 Worker，因此 >100 MB 的单 part 不能在 Free/Pro 账户上原样代理。要保留 512 MiB minidump 契约，必须在以下方案中选择一个：

- 客户端把每个 artifact 再切成 <100 MB chunks，服务端在 Container 临时盘重组；
- API 发放 R2 S3 presigned multipart upload，客户端直传 R2，之后由 Queue/Container 扫描、加密并转入正式 key；
- 购买允许更大请求体的计划，但 Business 200 MB 仍小于 512 MiB，Enterprise 默认 500 MB 也需核对二进制 MiB/十进制 MB 差异。

第二种方案最 Cloudflare-native，但会改变当前“服务端 privacy scan 后才持久化正式 artifact”和应用层 envelope encryption 的安全边界，必须设计隔离的 staging bucket、短 TTL、不可公开访问、处理失败清理和审计，不应作为简单配置变更。

#### 常驻后台循环

当前单进程用 `tokio::spawn` 常驻运行 processing、retention 和 alerts 循环（[main.rs](../../services/diagnostic-server/src/main.rs)）。Container 默认空闲 10 分钟后休眠，重启后磁盘全新（[Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)）。可以关闭休眠并固定运行一个 Container，但这会降低 scale-to-zero 的成本优势，并且当前 Container 横向路由仍需应用显式管理固定实例（[scaling](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/)）。更稳妥的方向是用 Queue/Cron/Workflow 唤起有界任务，Container 只执行符号化等原生工作。

## 推荐架构

### 阶段 A：最低改造、先上线

```text
Client
  -> Cloudflare Worker/custom domain
      -> one fixed Cloudflare Container: current Axum API + stackwalker
          -> managed PostgreSQL
          -> R2 through S3 API
          -> external AWS-compatible KMS
```

这条路径复用最多现有 Rust 代码，避免腾讯云 Caddy/证书成为公开入口。要求如下：

- 构建 `linux/amd64` image；Cloudflare Container 当前要求该架构（[get started](https://developers.cloudflare.com/containers/get-started/)）。
- PostgreSQL、R2、KMS 都是外部持久依赖；不能把 compose 中的 Postgres、MinIO 或 Floci 数据盘直接塞进 Container，因为磁盘不持久。
- 先把上传 part cap 降到 Worker 入口限制以内，或在客户端实现 chunking；否则现有 512 MiB minidump 契约会产生隐藏回归。
- 为 Container cold start（官方称常见为 1–3 秒）设置 readiness、请求等待和回退策略（[Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)）。
- 初期使用一个固定 Container ID，保留 PostgreSQL `SKIP LOCKED` 状态机；不要在尚未验证并发 claim、KMS cache 和临时盘容量前直接扩到随机池。

### 阶段 B：事件驱动混合架构

```text
Client
  -> API Worker (auth, policy, grants, upload orchestration)
      -> PostgreSQL via Hyperdrive (or later D1)
      -> R2 staging/final buckets
      -> Queue: incidentId/object keys only
          -> Processing Worker
              -> Symbolication Container
              -> external KMS
              -> R2 + metadata DB
      -> Cron/Queues: retention and alerts
```

这能把便宜、短时、全球分布的工作留在 Worker，把 native/heavy work 留给 Container。Queues 的 128 KB message cap 决定消息必须只传引用；默认至少一次投递决定所有状态迁移和告警发送必须幂等（[Queue limits](https://developers.cloudflare.com/queues/platform/limits/)、[delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)）。

是否把 PostgreSQL 换成 D1，应作为独立迁移项目：按 tenant 或 project 分库可以绕开 D1 单库串行吞吐和 10 GB 上限，但会重写 repository、迁移、跨租户运维查询、RLS、claim lease 和备份恢复。没有这轮重写，不应把 D1 列为“配置替换”。

## 主要风险与验收门槛

| 风险                                | 影响                               | 上线前验收                                                                        |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| Share KV eventual consistency       | burn/maxViews 并发超读             | 对同一 code 做跨地域并发读取；严格模式必须证明只成功一次                          |
| Worker body cap                     | 大 minidump 上传 413               | 用 100/200/512 MiB artifacts 做真实公网上传矩阵；记录各 Cloudflare plan 行为      |
| Container ephemeral disk/cold start | 处理中断、临时空间不足、首请求延迟 | kill/sleep/restart 中断 symbolication，证明数据库 lease 可回收且 R2 数据不丢      |
| Queue at-least-once                 | 重复分组、重复告警、重复删除       | 重放同一 message，所有状态、审计和 webhook 都保持幂等                             |
| PostgreSQL 跨区连接                 | 延迟、连接上限、单区故障           | 压测 Hyperdrive/直连、连接池、超时、故障恢复；迁移 job 与 serving role 分权不退化 |
| KMS 外部依赖                        | 无法读取/删除 artifacts            | KMS 超时、轮换、旧 key 解密、crypto-shred 后不可恢复的端到端测试                  |
| R2 staging 安全边界                 | 未扫描 artifact 暂存               | bucket 私有、短 TTL、失败清理、审计、无绕过下载路径                               |
| Container 平台成本与路由成熟度      | 长驻进程账单和扩缩容复杂度         | 以真实 symbolication CPU/memory/disk 时长计算月成本，不只按 $5 基础套餐估算       |

## 最终建议

1. **Share 先上 Cloudflare。** 若恢复可用性优先，可直接部署仓库现有 Worker；同时把 DO lifecycle hardening 建为 P0。若产品对 burn-after-read 有严格安全承诺，则 DO 必须先于生产开放。
2. **Diagnostics 不做“普通 Worker 全量迁移”。** 先做一周以内可验证的 Container POC：现有 image + R2 S3 endpoint + 托管 PostgreSQL + 外部 KMS，只开放 health、grant、一个小 artifact 上传和一个 minidump symbolication 垂直切片。
3. **POC 通过后选阶段 A 或 B。** 低流量、自托管优先选阶段 A；要规模化和精细成本控制再做阶段 B。D1 重写和直接 R2 multipart upload 都是独立安全/数据迁移项目，不与首次上线捆绑。
4. **完整 Diagnostics 不适合 Free tier。** Containers 无 Free 层；实际费用还会叠加 Container 资源、Workers、Queues、R2、外部 PostgreSQL 和 KMS。上线前用真实 dump 大小、symbolication 时间、每日 incident 数量做账单模型。

## Cloudflare 一手资料索引

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) / [pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) / [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) / [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/) / [limits](https://developers.cloudflare.com/kv/platform/limits/) / [pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [R2 S3 compatibility](https://developers.cloudflare.com/r2/get-started/s3/) / [limits](https://developers.cloudflare.com/r2/platform/limits/) / [pricing](https://developers.cloudflare.com/r2/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) / [pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) / [pricing](https://developers.cloudflare.com/queues/platform/pricing/) / [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Containers overview](https://developers.cloudflare.com/containers/) / [lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/) / [limits](https://developers.cloudflare.com/containers/platform-details/limits/) / [pricing](https://developers.cloudflare.com/containers/pricing/)
- [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
