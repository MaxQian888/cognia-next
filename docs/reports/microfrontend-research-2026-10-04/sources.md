# 微前端技术研究与适用边界 — 2026-10-04

研究目标是降低 Cognia 模块耦合、改善开发和维护，而非预设必须独立部署。本文记录一手资料和由其推导的方案判断；不是迁移完成证明，也没有运行任何微前端兼容性实验。新建日期化研究记录，是为了把外部技术状态与现有实现报告分开保存。各网页均于 2026-10-04 查阅；滚动更新的文档不能替代锁定版本后的实际验证。

## 先区分要解决的问题

| 概念                      | 实际解决的问题                             | 不自动提供的能力                     |
| ------------------------- | ------------------------------------------ | ------------------------------------ |
| 领域模块化                | 按业务职责组织代码，约束依赖方向与公开 API | 独立部署、运行时安全隔离             |
| workspace package         | 显式依赖、独立入口、局部检查和复用         | 自动消除循环依赖、阻止所有深层导入   |
| 路由分包 / dynamic import | 延迟下载和执行特定功能                     | 业务解耦、独立发布                   |
| 微前端                    | 独立构建/部署的前端单元在产品中组合        | 良好的领域边界、默认更快、默认更安全 |
| 插件架构                  | 通过宿主协议接入可选扩展                   | 每个核心业务都适合插件化             |

single-spa 把独立构建和部署作为微前端的重要特征，并区分 route application、无路由 parcel 和 utility module。这里采纳其职责分类；不把“必须分仓库”作为通用定义。多个应用可以保留在同一 monorepo。[single-spa 概念文档](https://single-spa.js.org/docs/microfrontends-concept/)

**研究判断：**如果相邻模块仍直接读写同一个复杂 store、依赖对方内部状态或共同控制 DOM，将它们包装成 remote，只是把编译期耦合转为运行时耦合。对当前目标，应该先修依赖图和数据所有权，再决定有没有必要增加部署边界。

## 方案核查

### Module Federation：区分 Next 插件与通用 runtime

官方 Next.js 集成页面明确写着 `App Router Not Supported`，支持列表是 Next `^15 || ^14 || ^13 || ^12`、Pages Router 和 SSR，并提示 Next.js 支持将结束。维护者公告说明仅继续小型修复、没有核心团队新功能开发，预计 2026 年中至年底终止；Next 16 若发生不易修复的兼容问题将不获支持。不能把“预计终止”改写成“已证实完全停止维护”。[Next.js 集成](https://module-federation.io/integrations/framework/nextjs/)、[维护者公告 #3153](https://github.com/module-federation/core/issues/3153)

通用 Module Federation runtime 可以不依赖构建插件，通过 `createInstance` 和 `loadRemote` 注册、加载远端模块；纯 runtime 模式需要显式提供共享依赖版本和实例，不能等同于构建插件的自动共享与类型提示。[Runtime Access](https://module-federation.io/guide/runtime/)

**对 Cognia 的推论：**不应把 `nextjs-mf` 当成 Next 16 App Router 的现成升级路径。但“在 client-only 边界挂载一个独立构建的 React island”仍是可实验方向；静态导出本身不禁止浏览器加载 JavaScript。实验必须核验 React 单实例、宿主上下文、资源路径、CSP、离线包、卸载和错误恢复。没有这些证据，不能声称方案已经兼容 Cognia，也不能声称技术上绝对不可能。

### single-spa：应用生命周期编排，不负责自动解耦

single-spa 的推荐方案明确建议：如果两个微前端频繁交换 UI state，应考虑合并；共享全局 store 会引入状态结构及行为兼容约束，不利于独立发布。它可以与 Module Federation 配合，前者负责挂载/卸载和路由编排，后者处理模块加载及依赖共享。其推荐文档仍包含较旧的 bundler 对照，不能据此声称当下 Module Federation 仅支持 Webpack。[Recommended Setup](https://single-spa.js.org/docs/recommended-setup/)

**对 Cognia 的推论：**适合有清楚路由和生命周期边界、需要技术栈渐进替换的应用域。若只是降低当前 React 工作台的维护成本，引入第二套路由/生命周期编排之前，应先证明 Next 路由加本地模块无法满足需求。

### qiankun：适合接入独立旧应用，但仍要求合理边界

qiankun 基于 single-spa，增加 HTML entry、资源加载和隔离机制。API 文档提供 `registerMicroApps` 与 `loadMicroApp`；`strictStyleIsolation` 使用 Shadow DOM，实验性 CSS 隔离通过选择器改写实现，但不改写 `@keyframes`、`@font-face`、`@import`、`@page`。文档也建议频繁通信的业务单元合并。[qiankun 简介](https://qiankun.umijs.org/guide/)、[qiankun API](https://qiankun.umijs.org/api/)

**对 Cognia 的推论：**如果未来要整合独立 Vue/React 旧应用，值得评估；目前不能仅凭“有 JS sandbox”就把它当作不可信插件的安全边界。Shadow DOM 下的弹层 portal、主题、全局样式和宿主交互也要实际测试。当前没有验证 qiankun 对 Cognia React 19、Next 16 App Router、Tauri CSP 组合的支持。

### Next.js Multi-Zones：站点级拆分

官方方案把不同路径交给不同应用，允许独立开发部署；zone 内软导航，跨 zone 是卸载当前页面资源的硬导航，跨区链接使用 `a`。官方建议经常一起访问的页面放同一个 zone，并用 HTTP proxy 或 Next rewrites 分发路径、区分资源前缀。[Multi-Zones](https://nextjs.org/docs/app/guides/multi-zones)

静态导出支持构建时生成页面，但不提供 Next 运行时 rewrites、Proxy、Server Actions 等服务端功能。[Static Exports](https://nextjs.org/docs/app/guides/static-exports)

**对 Cognia 的推论：**适用于 Web 文档、官网、后台等相对独立的页面群。它不是在一个持久工作台内组合多个功能面板的替代品。云端可以另设代理；桌面静态包若走类似路线，要自行解决资源组织与导航，并接受跨应用状态恢复成本。不能把“不支持 Next rewrites”推成“所有静态多应用组合均不可能”。

### iframe 与 Web Components：不同层次的隔离

iframe 提供独立浏览上下文，可配合跨源策略、sandbox 和消息协议隔离内容；同源内容同时获得 `allow-scripts` 与 `allow-same-origin` 时可能移除 sandbox。跨源父子通信可以使用 `postMessage`。[MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)

Shadow DOM 提供 DOM 和样式封装，但 `closed` 不是强安全机制。Web Components 也不自动给予独立部署、版本治理或原生权限隔离。[MDN Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)

**对 Cognia 的推论：**iframe 更适合第三方视图、预览或不可信内容，代价是焦点、快捷键、弹层、尺寸和通信协议；Web Components 更适合可信、跨框架的有限 UI 单元。浏览器隔离和原生 bridge 权限是两道不同边界，不能混为一谈。

## Tauri 与 Capacitor 的约束

Tauri 官方 Next 指南要求静态导出并将 `out` 设为 `frontendDist`；该指南明确以 Next 14.2.3 为准确范围，不能拿它当作 Next 16 全兼容认证。[Tauri Next.js](https://v2.tauri.app/start/frontend/nextjs/)

Tauri capability 按 window/webview 分配原生权限，默认原生 API 面向打包代码，远端来源可以显式配置；文档特别提示 Linux 和 Android 无法区分 iframe 与窗口自身发起的请求。远端网页权限规则也不能被误解为“加载到宿主同一 JS realm 的 remote 脚本自动受到单独权限隔离”。[Tauri Capabilities](https://v2.tauri.app/security/capabilities/)

Capacitor 配置文档把 `server.url` 定位为 live reload，并注明不用于生产；`allowNavigation` 也标有同样说明。这限制的是这些配置的推荐用途，不能扩大成“生产环境任何远端资源加载都不允许”。[Capacitor Configuration](https://capacitorjs.com/docs/config)

**设计推论：**对离线优先的桌面/移动应用，运行时远端模块至少需要明确的本地可用版本、资源清单、协议兼容性、失败回退和更新一致性。把全部微应用跟宿主一起打包在技术上可以保留离线能力，但也弱化了独立部署收益。若当前目的只是模块解耦，这些额外机制通常不应成为第一步。

## 对当前目标更直接的技术手段

1. **公开入口与依赖方向。**沿现有 workspace/package 体系明确领域入口、平台接口和宿主组合层；不要让基础包反向导入业务 UI，也不要让两个业务域直接访问对方内部 store。
2. **可执行的边界。**现有 ESLint 的 `no-restricted-imports` 支持禁止路径/模式，但官方说明它仅覆盖静态 import；dynamic import、别名、相对路径、re-export 等绕行必须纳入实际检查范围。[ESLint 规则](https://eslint.org/docs/latest/rules/no-restricted-imports)
3. **先约束，再考虑工具升级。**Nx 能按 scope/type 标签约束跨项目依赖，说明架构规则可以机器化；这不意味着 Cognia 必须引入 Nx。先复用仓库已有边界工具更符合最小迁移原则。[Nx Module Boundaries](https://nx.dev/docs/features/enforce-module-boundaries)
4. **构建分层与类型检查。**TypeScript Project References 可以组织多个项目并利用声明产物和增量构建。是否适用于当前 Next 构建、源码包及生成文件，需要试点；不能预先承诺类型检查提速比例。[TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references)

建议把验收目标写成行为：修改一个领域内部实现时，消费者无需改动；内部文件不能从外部导入；关键逻辑能在不启动完整应用的情况下测试；平台差异通过接口进入；切换页面不丢失会话/任务生命周期。首屏和构建性能另做基准，不用“拆了几个微应用”替代这些结果。

## 决策与尚未验证的内容

当前优先级下，推荐先推进**模块化单体 + 领域契约 + 宿主组合层 + 必要的按需加载**，沿用已有插件扩展边界。微前端保留为未来独立团队交付、独立旧应用迁移或隔离第三方视图的针对性手段。

这一推荐是基于目标和官方约束的架构判断，不是性能实验结论。尚未验证：任一方案在 Cognia 的真实浏览器/桌面/移动运行；具体 remote 构建器和依赖组合；离线更新与回滚；真实开发耗时收益；所有候选模块的数据所有权与拆分成本。实施前应选一个低耦合领域做有限试点，再以实际改动范围、检查时间、运行行为和回退成本决定扩展。

## Sources

以上每节已就近列出直接来源。材料优先级为维护者文档、维护者公告与 Web 平台参考；没有把论坛回答、营销案例数量或未执行示例作为 Cognia 可用性证明。
