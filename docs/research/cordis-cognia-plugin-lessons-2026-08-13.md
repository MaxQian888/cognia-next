# Cordis 对 Cognia 插件体系的可借鉴机制：一手资料备忘录

**研究日期：** 2026-08-13  
**研究边界：** 只研究 Cordis / Koishi 的官方源码、测试、提交历史、官方设计文档及 npm/GitHub 元数据；本文不分析 Cognia 当前实现，也不主张直接引入 Cordis。

## 结论先行

Cordis 最值得借鉴的不是它的 `Context` API 或 TypeScript `Proxy` 技巧，而是一个更基础的运行时约束：**插件实例必须是有明确所有者的生命周期节点；它创建的一切能力、订阅和资源都必须登记为该节点的 effect；服务依赖的出现与消失直接驱动节点启停；热更新复用“准备新实现—卸载旧节点—装载新节点—失败回滚”的生命周期机制。** Koishi 官方把目标定义为“路径无关”：最终行为只取决于最终启用的插件集合，而不取决于中间加载/卸载次数或顺序；其官方设计文档称这套机制已支撑超过 3,000 个插件的生态。[Koishi：可逆的插件系统](https://koishi.chat/zh-CN/cookbook/design/disposable)

对 Cognia 更稳妥的路线是**吸收运行时不变量，避免复制实现细节**：先统一资源所有权与 disposal，再做依赖驱动激活和可观测状态，之后才考虑作用域隔离与 HMR。Cordis 的核心设计已有 Koishi 生态验证，但独立项目当前仍明确标注 API 不稳定，`cordis` 最新版本是 `4.0.0-rc.8`；其 HMR 又依赖 Node 内部 ESM loader/cache，不适合作为跨 Tauri、浏览器、WASM 边界的直接基础设施。[Cordis README](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/README.md#L5-L7) [core package manifest](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/package.json#L1-L18) [HMR implementation](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/hmr/src/index.ts#L274-L309)

## 1. 将“插件实例”建模为资源所有权节点

Cordis 每次 `ctx.plugin()` 都创建一个 `Fiber` 和从父 `Context` 派生出的子上下文；该 Fiber 本身又通过 `parent.fiber.effect(...)` 登记为父节点的 effect，所以父插件卸载会自然递归卸载子插件。源码中的 `FiberState` 明确区分 `PENDING / LOADING / ACTIVE / FAILED / DISPOSED / UNLOADING`，而不是用一个 `enabled` 布尔值掩盖异步转换。[Fiber construction and states](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L78-L113) [parent-owned plugin effect](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L122-L199)

`ctx.effect()` 接受同步或异步 disposer，也接受 generator / async generator 连续产出多个 disposer；同一 effect 内按 LIFO 回收，重复调用 disposer 是幂等的。若 effect 初始化中途抛错，已收集的 disposer 会立即执行；测试同时覆盖同步/异步建立、初始化失败、中途终止和逆序清理。[effect types and execution](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L48-L69) [effect collection and disposal](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L229-L340) [effect tests](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/tests/dispose.spec.ts#L6-L74)

Cordis 没有要求每个插件作者手写一个庞大的 `dispose()`。相反，框架 API 自身可逆化：例如 `ctx.on()` 内部就是带标签的 effect，卸载时自动删除监听器；服务注册、访问器、mixin 和子插件也使用相同账本。[event registration as an effect](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/events.ts#L128-L158) [reversible service/accessor APIs](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/reflect.ts#L175-L236) [Koishi design explanation](https://koishi.chat/zh-CN/cookbook/design/disposable)

**可迁移经验：** Cognia 应定义单一的 `PluginScope` / `PluginInstance` 资源账本，并要求所有宿主能力都从该 scope 派生：事件订阅、命令/工具注册、工作流节点、UI contribution、定时器、worker/task、WASM instance、Tauri listener/handle、文件 watch、服务发布等都返回或登记 disposer。真正的验收标准不是“插件有 deactivate 钩子”，而是 `activate → dispose → activate` 后，宿主快照、注册表、监听器和后台任务与初始状态等价。Cordis 的嵌套插件测试正是比较卸载前后快照，并验证父节点卸载后只剩根监听器。[nested-plugin and snapshot tests](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/tests/plugin.spec.ts#L86-L143)

## 2. 依赖不是启动排序，而是激活条件

Cordis 将 `inject` 解析为 Fiber 的依赖集合。Fiber 为每个依赖保存当前 service implementation，并用 provider Fiber 的 `uid` 组成 epoch：缺少任一实现则保持 `PENDING`；provider 出现时进入 `LOADING`；实现消失或被另一个 Fiber 替换时，consumer 先 `UNLOADING` 清理旧副作用，再以新依赖重新执行。`inertia` 串行化这些转换，避免依赖快速抖动时加载与卸载并发穿插。[dependency checks and epoch](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L371-L435) [serialized unload/reload](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L437-L465)

服务发布也是 effect。provider 移除时，Cordis 先从 service store 删除实现、通知所有注入者刷新并等待这些 consumer settle，最后才从 provider 自身 store 移除，实现“consumer 生命周期包含在 provider 生命周期内”的顺序保证。[service provide/remove/notify](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/reflect.ts#L175-L227) Koishi 官方文档也明确说明：依赖未就绪时插件体不运行；依赖值变化时插件回滚；新值仍可用时再加载，而部分依赖功能应拆为 `ctx.inject()` 子插件。[Koishi：服务与依赖](https://koishi.chat/zh-CN/guide/plugin/service)

**可迁移经验：** 不要只在安装阶段做一次拓扑排序，也不要让插件到处 `if (service)`。将 `requires / optional / provides` 变成运行时图；服务实例身份变化也应视为依赖变化。每个可选能力拆成独立子 scope，使主插件可继续工作；强依赖 consumer 的 teardown 必须先于 provider teardown。需要显式规定循环依赖、多个 provider、optional dependency、启动超时和依赖抖动策略；Cordis 的默认模型在同一隔离域只允许一个同名 provider，重复发布会抛错。[single-provider enforcement](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/reflect.ts#L184-L200)

## 3. 隔离、覆盖和调用方归属是三个不同问题

Cordis 的 `Context.isolate(name)` 不复制整个容器，而是只为某个 service name 在派生上下文中换一个 symbol key；因此同名服务可在多个 realm 独立提供，也可以让多个上下文共享同一个 label。[context isolation](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/context.ts#L55-L77) [isolation behavior tests](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/tests/isolate.spec.ts#L6-L95)

`intercept(name, config)` 则不是替换服务，而是在上下文原型链上叠加该服务的调用配置，由 Service 自己定义 merge 规则。这适合 per-plugin / per-workspace 的策略、限额、路由或行为覆盖，而不必创建一个新 provider。[intercept context](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/context.ts#L71-L77) [service config resolution](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/service.ts#L51-L67)

更深的一层是“调用方归属”。Cordis 用 traceable proxy 把 service 方法里的 `this.ctx` 重绑定到访问该服务的上下文，使服务方法产生的 effect 能归属 consumer，而不是永久挂在 provider 上；Koishi 官方用 `console.addEntry()` 举例说明，consumer 卸载后可自动撤销由服务调用创建的入口。[traceable service construction](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/service.ts#L18-L39) [Koishi service hot-reload example](https://koishi.chat/zh-CN/guide/plugin/service)

**可迁移经验：** Cognia 的 scope 设计应分别表达：`realm`（看见哪个 provider）、`policy overlay`（怎样调用它）、`caller scope`（调用产生的资源归谁）。其中 caller-owned effect 极有价值，但没必要复制透明 `Proxy` 魔法；显式 `service.open(callerScope, ...)`、带 scope 的 capability handle，或由宿主包装返回值，通常更容易跨 JS/WASM/Rust 边界审计。

## 4. HMR 应被视为事务，而不是重新 `import()`

Cordis loader 用稳定 entry id 建模配置树；配置 diff 会更新上下文并调用 Fiber `update()`，disabled 或祖先 disabled 会卸载实例。entry 还生成包含配置 URL 和层级 id 的 outer stack，避免动态加载错误只剩难以定位的内部堆栈。[loader entry lifecycle](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/loader/src/config/entry.ts#L34-L72) [entry update and source-aware stack](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/loader/src/config/entry.ts#L84-L171)

配置文件 include 支持 JSON/YAML、按稳定 id patch、变更检测及 `.tmp` 后 rename 写回；配置树的 `await()` 会持续等待当前 entry init / Fiber transition，直到没有任务。[include patching and atomic-ish write](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/include/src/index.ts#L85-L164) [include persistence](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/include/src/index.ts#L187-L215) [loader task settlement](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/loader/src/config/tree.ts#L25-L45)

HMR 的关键顺序是：分析变更模块及依赖者；把插件入口当原子 reload unit；备份并清除 module cache；**先试导入/执行所有新入口模块**；再卸载旧 runtime 并用原 config/parent/entry 重建；任一导入或重建失败则恢复 cache，并尽力重新注册旧插件。框架自身依赖发生变化时不做局部 reload，而是请求整进程重启。[change classification](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/hmr/src/index.ts#L115-L151) [dependency analysis and cache backup](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/hmr/src/index.ts#L167-L318) [prepare/swap/rollback](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/hmr/src/index.ts#L320-L377)

这不是严格的原子事务：`RegistryService.delete()` 触发各 Fiber 的异步 `dispose()`，但不等待它们完成；HMR 随后即可创建新 Fiber。因此旧资源清理与新实例启动可能短暂重叠，回滚也是 best-effort。[non-awaited registry disposal](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/registry.ts#L162-L170) [HMR swap sequence](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/hmr/src/index.ts#L340-L374)

**可迁移经验：** Cognia 的更新协议应保存 old descriptor/config/state handles，先完成新包解析、签名/manifest/schema/compatibility 校验与冷启动准备，再进入有界的 `quiesce → dispose consumers → dispose provider → activate new → resume`；失败时恢复旧实例或明确进入 degraded 状态。局部 reload 的边界应来自 manifest dependency graph 和 contribution ownership，而不是只看改动文件名。

## 5. 可观测性应来自同一运行时账本

Cordis effect 自带 `label` 和嵌套 `children`，Fiber 暴露 `getEffects()`；运行时还发出 plugin、status、service、dispatch 等内部事件。Registry 保留同一插件 callback 对应的全部 Fiber 实例，loader 把 entry id、base URL 和 config 关联到 Fiber。[effect metadata](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L66-L69) [effect tree inspection](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L296-L346) [runtime event surface](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/events.ts#L169-L177) [runtime registry](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/registry.ts#L125-L170)

**可迁移经验：** 插件管理 UI 和诊断 API 不应另建一份推测状态，而应直接读取生命周期图。每个实例至少应暴露：instance id、package/version、parent/children、realm、provided/required services、state、state-since、pending transition、last error、owned effect 类型/标签/数量、加载来源与配置版本。这样才能检测“插件已 disabled 但 listener/worker 仍存在”的真实泄漏。

## 6. 失败语义必须成为公开契约

Cordis 的具体选择值得借鉴其“明确”，但不必照抄：配置使用 Standard Schema 同步校验，异步校验明确不支持；插件执行失败会被记录并把 Fiber 标记为 `FAILED`；卸载会并行清理 Fiber 顶层 effects，单个 disposer 异常被记录而不阻断其他清理；`await()` 最终会重新抛出插件初始化错误；并行事件等待所有 listener 后用 `AggregateError` 汇总失败。[config validation](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L14-L46) [load/unload error handling](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L415-L465) [parallel event failures](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/events.ts#L89-L99)

需要注意，Cordis 的 async generator effect 并非通用抢占式取消：epoch 变化后会在下一次 iterator await/yield 边界停止收集，已经执行的用户代码仍需自行响应取消；源码和测试都展示了 dispose 请求后，生成器可继续运行到下一个 yield 才回收已产出的 disposer。[async iterator epoch check](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/src/fiber.ts#L256-L268) [aborted async effect tests](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/core/tests/dispose.spec.ts#L123-L163)

**可迁移经验：** Cognia 需要为 activate、dispose、dependency loss、config update、shutdown、HMR rollback 分别规定超时、取消、错误传播和 degraded/fatal 策略；scope 应携带 `AbortSignal` / cancellation token。UI 不应把“dispose promise resolved”与“所有资源已确认终止”混为一谈，尤其是跨 Rust task、WASM、worker 和外部进程的资源。

## 7. 不宜直接照搬的部分

1. **透明 Proxy 与动态字符串服务访问。** Cordis 能在未 `inject` 时拒绝访问，并通过 proxy/shadow 追踪 caller，但该机制实现复杂；2026-08-06 至 2026-08-07 仍连续修复 callable-service shadow、direct caller tracking 和 wrapped Fiber state 等边界问题。[PR #37](https://github.com/cordiverse/cordis/pull/37) [PR #35](https://github.com/cordiverse/cordis/pull/35) [PR #40](https://github.com/cordiverse/cordis/pull/40) 对跨语言插件平台，显式 capability handle 和结构化 manifest 通常比动态属性代理更容易验证。
2. **Node 内部 loader 驱动 HMR。** Cordis 针对 Node 22/23 与 24+ 维护两套 internal ModuleLoader 接口，并直接操作内部 `loadCache` 与 CommonJS cache；这是 Cordis 的环境适配，不是可移植协议。[internal loader compatibility layer](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/loader/src/internal.ts#L1-L93) [cache implementation notes](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/packages/hmr/src/index.ts#L274-L309)
3. **不要把可逆性误当沙箱。** Koishi 官方明确承认，插件仍可通过全局变量或未封装的底层 API 绕过 Cordis，因此它目前不能在语言层面保证资源安全。[Koishi：语言层面资源安全的限制](https://koishi.chat/zh-CN/cookbook/design/disposable#%E7%95%85%E6%83%B3-%E5%9C%A8%E8%AF%AD%E8%A8%80%E5%B1%82%E9%9D%A2%E7%A1%AE%E4%BF%9D%E8%B5%84%E6%BA%90%E5%AE%89%E5%85%A8) 生命周期治理、权限控制、进程/WASM 隔离和数据访问策略必须分层设计。

## 8. 成熟度判断

- **理念与实战成熟，独立 API 仍在演进。** Koishi 官方称其插件体系基于 Cordis 的可逆性，并用于超过 3,000 个插件；但 Cordis README 同时明确警告 API 尚不稳定、文档和论文仍在准备中。[Koishi design document](https://koishi.chat/zh-CN/cookbook/design/disposable) [Cordis README](https://github.com/cordiverse/cordis/blob/fab126fce3b94a69d72015ee18882a406e47e63a/README.md#L5-L7)
- **当前发布仍是 RC。** npm registry 在 2026-08-10 发布的 latest 是 `4.0.0-rc.8`；2026-07-11 至 2026-08-09 的下载 API 返回 102,877 次下载。下载数说明存在实际消费，但包含 CI、缓存和间接依赖，不能视为独立生产用户数。[npm package metadata](https://registry.npmjs.org/cordis) [npm download point](https://api.npmjs.org/downloads/point/last-month/cordis)
- **维护活跃但复杂边界仍在修。** 仓库 2026-08-06 至 2026-08-13 有多项 core caller/shadow/state/disposal 修复和版本发布；这说明项目活跃，也说明透明上下文追踪与并发生命周期的正确性成本较高。[Cordis commit history](https://github.com/cordiverse/cordis/commits/main/) [PR #36: logger exporter disposal](https://github.com/cordiverse/cordis/pull/36)

因此，建议把 Cordis 当作**设计参照与测试预言机**，而不是当前直接替换 Cognia runtime 的依赖。最有价值的是把其 invariants 写进 Cognia 的架构契约和测试，再依据 Cognia 的 JS/WASM/Tauri 边界实现最小内核。

## 9. 建议的吸收顺序与验收标准

| 阶段 | 吸收内容                                                                               | 最小验收证据                                                                                                       |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P0   | `PluginInstance` 状态机、父子 scope、统一 effect ledger、幂等 dispose、LIFO 子资源回收 | 每类宿主 contribution 都有 `activate → dispose → snapshot equal` 测试；重复 dispose 无副作用；初始化中途失败无残留 |
| P0   | 取消与失败契约                                                                         | activate/dispose timeout、cancellation、cleanup aggregate、FAILED/degraded 状态有集成测试和 UI 可见性              |
| P1   | `provides / requires / optional` 运行时依赖图                                          | 任意加载顺序结果一致；provider replacement 会先停 consumer 再停 provider，并自动重启 consumer；循环依赖可诊断      |
| P1   | 生命周期图可观测性                                                                     | 可查询 parent/children、state、dependency、effect、source、last error；泄漏测试能指出 owner 和 effect label        |
| P2   | per-service realm、policy overlay、caller-owned capability                             | 两个 workspace/agent/plugin realm 可拥有同名服务且互不串扰；consumer 卸载会撤销通过 provider 创建的资源            |
| P3   | 配置 diff 与事务式 HMR                                                                 | 新包先校验/准备；swap 失败恢复旧实现；基础 runtime 改动触发完整重启；状态迁移有版本与回滚协议                      |

最终成功指标应沿用 Cordis/Koishi 的“路径无关”定义，而不是只看启停 API 是否返回成功。[Koishi：可逆的 Koishi](https://koishi.chat/zh-CN/cookbook/design/disposable#%E5%8F%AF%E9%80%86%E7%9A%84-koishi)

## Primary sources

- [cordiverse/cordis source at `fab126f`](https://github.com/cordiverse/cordis/tree/fab126fce3b94a69d72015ee18882a406e47e63a)
- [Koishi official design: 可逆的插件系统](https://koishi.chat/zh-CN/cookbook/design/disposable)
- [Koishi official guide: 服务与依赖](https://koishi.chat/zh-CN/guide/plugin/service)
- [npm registry metadata for `cordis`](https://registry.npmjs.org/cordis/latest)
- [npm downloads API for `cordis`](https://api.npmjs.org/downloads/point/last-month/cordis)
