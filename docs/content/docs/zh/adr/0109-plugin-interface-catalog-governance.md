---
title: "ADR-0109：插件接口目录治理"
description: 以 Plugin Interface Catalog 统一各 SDK 与运行时中的 ctx.* 契约。
---

# ADR-0109：插件接口目录治理

- **状态：** 已接受
- **日期：** 2026-08-06

## 背景

公开 Plugin API 分散在 TypeScript 声明、权限映射、Rust 路由、Python 镜像、WIT 与手写文档中，已经发生语义漂移。`PluginContext` 的实际命名空间数量远高于文档描述，生命周期清理散落在 manager 分支中，跨进程版本也被分别硬编码。

## 决策

1. `packages/plugin-sdk/contract/catalog.json` 是公开方法 ID、`ctx.*` 路径、稳定性、运行时与平台支持、权限与同意策略、数据分类、传输行为、生命周期所有权和实现证据的唯一事实源。
2. `ctx.*` 继续作为唯一规范作者接口。本次迁移不增加 `ctx.api`、`ctx.meta` 或第二套永久公共 API。
3. 契约生成器只生成声明与镜像；领域 factory 仍是手写业务实现。TypeScript、Rust、Python、plugin point 与文档生成物漂移会阻断 CI。
4. API 调用统一遵循：descriptor 查找、运行时/平台校验、权限/同意、数据/出站策略、超时/取消、adapter 调用、transport 归一化、脱敏审计。未登记方法 fail-closed。发布顺序为只读校验、shadow 对比、单运行时切换，再全面启用。
5. `PluginPermission` 是规范类型，旧权限类型名保留为弃用别名。原生操作继续经过 Rust 第二道权限门；renderer proxy 只是纵深防御，不是 JavaScript 沙箱。
6. 每次插件加载拥有 disposable ledger。激活失败和卸载会逆序、幂等清理并汇总错误；迁移期间保留旧清理路径作为回滚方案。
7. Python 等跨进程运行时以加法方式返回 SDK、protocol、contract 版本、runtime ID、capabilities 与 legacy-adapter 标记。旧运行时缺少握手时进入显式 legacy adapter，而不是拒绝已有插件。
8. 公共 API 弃用至少保留两个 host minor release。移除只能发生在下一个 SDK major，并要求替代项、迁移文档和使用证据。提交的 API surface baseline 会阻止方法/路径删除以及 runtime/platform 支持收缩；纯新增保持兼容。
9. 性能使用固定插件夹具，记录 boot、load、activate、contribution registration、API call、teardown 与 manager/context chunk。基线锁定后，时延回退超过 5% 或 chunk 增长超过 2% 将触发插件专项门禁。旧 factory 与 cleanup 路径在迁移阶段保留回滚开关。

## 影响

- 作者接口以及既有成功值、异常类型保持兼容，同时治理结果变得可审计。
- Catalog 变更必须携带证据并重新生成镜像，但不会自动生成业务实现。
- 更强的 renderer 隔离仍属于独立安全项目。
- 只有在运行时采用率与遥测充分后，才可移除 legacy adapter 和旧 cleanup 路径。
