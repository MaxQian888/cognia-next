---
title: "0084 — Cognia Sites"
description: "定义由 Cognia 自主管理的站点创作、不可变版本、可恢复部署、供应商资源和访客访问，同时不重复实现项目、编辑器、浏览器、Git、终端与凭据体系。"
---

# ADR 0084 — Cognia Sites

**状态：** 已接受  
**日期：** 2026-07-18

## 背景

Codex Sites 把现有源码工作区与本地预览、不可变的已保存版本、生产部署、环境配置、存储、访客访问、域名、日志、分析、下线和删除组合成完整生命周期。Cognia 需要在自身产品控制下完成这套能力。OpenAI 私有的 Sites connector 与托管控制面只用于确认产品语义，不作为可复用依赖。

仅增加一条 metadata 和一个部署按钮并不安全：导入项目的构建脚本不可信；Git commit 不能保存构建制品；远程主机路由会让凭据落点含糊；供应商操作可能在客户端超时后实际成功；D1、R2、域名、Access 应用或策略也可能是共享或外部接入资源，而非 Cognia 所有。

## 决策

### 组合方式与作用域

Site 是关联到现有 Cognia `Project` 的部署聚合。它明确记录一个 workspace root、规范化的源码子路径和执行目标，不重复拥有项目文件、chat、editor、Git、terminal、artifact、browser、credential 或 settings。

首个完整供应商为 Cloudflare Workers。供应商行为位于 Sites 专用 hosting 边界之后；消息 connector 与 WASM plugin runtime 不承担托管控制面职责。主 Next.js 应用继续保持 static export，构建、制品、凭据和供应商操作由明确选择的原生主机执行。

### 持久化生命周期

不同基数与不变量使用独立持久化对象：

- `siteProjects` 保存 Site 身份、源码关联、供应商关联、创作权限和当前生命周期状态。
- `siteVersions` 完成后只追加、不可修改。版本保存源码来源、lockfile 与 toolchain 指纹、构建配置、兼容性配置、routes、bindings、非敏感变量、secret reference revision、artifact digest 和 artifact location。
- `siteDeployments` 记录哪个不可变版本与环境 revision 正在承载流量。回滚是对历史版本创建一次新部署，不修改历史版本。
- `siteOperations` 是 build、provision、upload、deploy、access、environment、domain、takedown、reconcile 与 purge 的持久化幂等状态机。它按执行目标租约运行，记录 attempt 和 provider request/resource ID，并能在崩溃或超时后恢复。
- `siteResources` 记录所有供应商对象及其 `managed`、`adopted` 或 `shared` 所有权。只有不再被引用的 managed resource 才能被破坏性清理。

已保存的 artifact bytes 采用 content-addressed、不可变存储；source commit 本身不够。保留与垃圾回收不能删除任何被 deployment 或未完成 operation 引用的 artifact。D1 data、R2 object 与 secret value 属于可变外部状态，明确不被表述为代码回滚。

### 执行与凭据

导入项目的 dependency installation 与 build 均视为不可信代码，必须在 fail-closed Sites confinement profile 中执行：显式读写 mount、CPU/memory/time/output 上限，默认禁止网络。确需网络时必须作为独立的用户批准 allowlist capability。Provider credential 永远不得注入 build process。

Credential call 必须携带明确 execution target。本地凭据使用不可路由的 local keyring path，不能被 process-wide remote-host transport 静默转发。Provider upload/deploy 只能在 build 完成后启动，并由 provider operation boundary 获得凭据，不能把凭据交给 source script 或写入 command text。

### 授权与访客访问

创作授权与已部署站点的访客访问必须分层：

1. Cognia authoring policy 控制谁可以编辑配置、保存版本、部署、修改访问范围或清除 Site。
2. Provider-neutral visitor policy 描述 `private`、指定身份/域、organization 或 `public`。
3. Provider adapter 编译并验证 visitor policy。Cloudflare Access 是 enforcement adapter，不是 Cognia 的 authoring authority。系统检测并展示 drift；受限 Site 的策略若无法验证或存在 bypass，则 fail closed。
4. 应用内部的数据授权仍由已部署应用自身负责。

### 预览与破坏性操作

本地预览复用 project editor、terminal session 与 Browser UI，但必须仲裁 native embedded-browser singleton。Sites preview 先获得明确 owner lease，不能导航或销毁其他 Browser surface。

Takedown 与 deletion 是两个动作。Takedown 移除生产流量但保留版本和供应商数据。删除 Cognia Site 需要显式确认与 reconcile，之后才清理本地 metadata。Purge 是独立的强类型破坏性操作，只按依赖顺序删除符合条件的 managed resource，并报告保留的 adopted/shared resource。

## 影响

该设计使用若干小型 Sites 表和 operation reconciler，而不是一个可变 metadata 对象；在启用生产部署前还必须提供原生 confinement 和 target-local credential seam。这些额外状态是实现不可变版本、崩溃恢复、多窗口安全、可审计删除与真实所有权边界的必要成本。

Desktop 是创作和部署主机。Mobile 只有在显式增加 sync table、delta reader、tombstone 与 handler 后才可接收只读 projection；普通 Web 不宣称能访问本地 Sites metadata。
