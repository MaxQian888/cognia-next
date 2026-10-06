# Cognia 移动端鸿蒙支持研究

核查日期：2026-10-04。范围：当前官方平台资料、适配项目维护者的源码/README、npm 发布元数据。本次没有安装适配器，没有构建或运行 HarmonyOS 应用。

> **2026-10-04 后续实现更新**：下文保留最初研究时的证据。随后已在当前工作区补充 Android APK 的 Huawei HMS 远程推送链路：原生注册、通知与点击事件、token 刷新及断线重报、主机 OAuth/发送/凭据恢复、设置页和协议注册。接入说明见 [Huawei Push Kit](../../mobile/HUAWEI_PUSH.md) 与 [主机推送配置](../../mobile/docs/phase-b-push-setup.md)。该实现仍需配置 AppGallery Connect 应用、签名指纹与主机凭据，并完成华为真机投递验收；不代表原生 HarmonyOS HAP 或卓易通环境已获支持。

**结论：Cognia 当前没有原生鸿蒙支持；已有 Android APK 和 Web 路线可作为兼容验证起点。无 GMS 扫码和定位已有降级实现，Huawei 远程推送、鸿蒙宿主/原生插件及打包发布仍有缺口。HarmonyOS 5+ 的 APK 兼容服务提供了额外试用路径，但尚无 Cognia 真机验证。**

## 平台支持结论

| 路径                                   | 当前证据                                                                                                 | 对 Cognia 的含义                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| HarmonyOS 4.x 等兼容 Android 的旧系统  | 华为的 APK 安装故障文档明确适用于 HarmonyOS 5.0 以下和 EMUI。                                            | 可沿用 Android APK 进行逐机型验证；不代表已经通过鸿蒙真机测试。                                               |
| HarmonyOS 5 及以上通过兼容环境运行 APK | 华为当前说明支持通过应用市场、分享或网页取得 APK，由卓易通等提供兼容服务；能否安装取决于卓易通实际支持。 | **不能再笼统说“鸿蒙 NEXT 完全装不了 APK”**。但 Cognia 的安装、WebView、插件和后台行为尚无验证，不能承诺兼容。 |
| HarmonyOS 原生应用                     | 华为提供 DevEco Studio、ArkTS、ArkUI 和 ArkWeb；原生应用需要对应工程、桥接和打包。                       | Cognia 的 Android 包不能直接等同于原生鸿蒙包，需要新增宿主及原生能力适配。                                    |
| Web 页面                               | ArkWeb 官方支持嵌入网页；本地资源、跨域、存储和 UA 兼容有单独约束。                                      | 现有 Web UI 有复用基础，但页面加载成功不等于原生功能、PWA 安装、推送和后台功能全部可用。                      |

依据：[华为旧版 APK 安装说明](https://consumer.huawei.com/cn/support/content/zh-cn00445299/)、[HarmonyOS 5 及以上应用下载安装说明](https://consumer.huawei.com/cn/support/content/zh-cn16061787/)、[华为应用开发平台](https://developer.huawei.com/consumer/cn/app/planning)、[ArkWeb 白屏与本地资源排查](https://developer.huawei.com/consumer/cn/doc/doccenter-dev-faq/faqs-arkweb-174)。

Capacitor 当前官方支持目标仍是 Android、iOS、Web。上游 HarmonyOS 和 HarmonyOS NEXT 请求在本次 GitHub API 查询中均为 `closed` / `not_planned`；这说明当前没有第一方鸿蒙支持承诺，并不证明未来永远不支持。[官方环境说明](https://capacitorjs.com/docs/getting-started/environment-setup)、[请求 #7173](https://github.com/ionic-team/capacitor/issues/7173)、[请求 #7818](https://github.com/ionic-team/capacitor/issues/7818)。

## 第三方适配器现状

以下是本次直接读取 npm registry 的 `latest`、发布时间和依赖字段的结果；版本兼容声明属于维护者声明，不是 Cognia 实测。

| 项目                                                | 当前版本与发布日期（UTC） | 范围与限制                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPF-Ionic `@capacitor-ohos/ohos`                    | `8.0.2`，2026-07-23       | peer 为 `@capacitor/core ^8.0.0`。发布包 README 表明基于 Capacitor Android 8.0.0，面向 OpenHarmony 5.0+；包含 C/C++、ArkTS、自有网络处理和 OpenSSL 依赖。                    |
| CPF-Ionic `hionic`                                  | `2.1.16`，2026-07-23      | CLI 依赖仍是 `@capacitor/cli`、`@capacitor/core ^3.9.0`，与上述平台的 Capacitor 8 声明需要隔离验证；发布包 README 中 `open`、`buildapp` 标注 Windows only。                  |
| Eclipse Oniro `@oniroproject/capacitor-openharmony` | `0.1.2`，2026-03-31       | 声明支持 Capacitor 6/7/8；ArkUI Web 加桥接。仓库阶段记录仍包含 MVP、占位 Device ID、App 监听器 stub 及缺失插件描述；不能视为功能齐全的移动运行时。                           |
| `capacitor-harmony`                                 | `0.1.2`，2026-09-13       | 声明支持 Capacitor 6/7/8；ArkWeb 加可选嵌入式 Node.js，README 列出 15 个内置插件并明确不是完整 Capacitor 实现。模板声明编译 API 21，最低兼容 API 12+；尚无 Cognia 接入证据。 |

版本与实现来源：[CPF 平台元数据](https://registry.npmjs.org/@capacitor-ohos%2Fohos)、[hionic 元数据](https://registry.npmjs.org/hionic)、[CPF 平台源码](https://gitcode.com/CPF-Ionic/openHarmony-capacitor)、[CPF CLI 源码](https://gitcode.com/CPF-Ionic/capacitor-cli)、[Oniro 元数据](https://registry.npmjs.org/@oniroproject%2Fcapacitor-openharmony)、[Oniro 阶段记录](https://github.com/eclipse-oniro4openharmony/capacitor-openharmony/blob/main/docs/phase4_status.md)、[capacitor-harmony 元数据](https://registry.npmjs.org/capacitor-harmony)、[capacitor-harmony README](https://github.com/zxdong262/capacitor-harmony)。

CPF、Oniro 的上述 npm 版本与仓库内 2026-07-27 报告相同；本次新增发现的是 2026-09-13 发布的 `capacitor-harmony`。本次 GitCode 页面获取失败，CPF 的实现说明来自相同发布版本 tarball 内的 README；没有据此认定 GitCode 最新分支没有后续修改。Oniro GitHub 仓库本次返回未归档、`pushed_at` 为 2026-03-31；阶段文档属于维护者记录，本次没有逐项复跑或将其视为商业 HarmonyOS 设备的支持证明。

## 原生落地边界

ArkWeb 提供 Web 宿主并支持通过 JavaScript 代理调用应用侧方法，因此复用 Cognia Web UI 在架构上可行。华为官方性能文档明确讨论 `javaScriptProxy` / `registerJavaScriptProxy`；具体桥接协议、Capacitor 插件注册、生命周期和权限仍要实现及验证。[ArkWeb 官方最佳实践](https://developer.huawei.com/consumer/cn/doc/best-practices/bpta-web-frame-rate-performance-analysis)。

原生交付应单独核查 HAP、App Pack、签名和安装流程。OpenHarmony 官方文档说明 HAP 是安装运行基本单位，签名后的 App Pack 用于分发；OpenHarmony 示例或模拟器成功不构成 Huawei 商业 HarmonyOS SDK、真机及应用市场验收证据。[OpenHarmony HAP 文档](https://github.com/openharmony/docs/blob/master/en/application-dev/quick-start/hap-package.md)。

建议保持 Android 和 Web 为当前可验证路径；若要原生鸿蒙发布，先在独立试验工程中比较候选适配器，跑通现有静态页面、桥接、凭据存储、配对与文本通信，再确定插件补齐范围。不要仅凭 npm 包名称、版本声明或演示页面宣布生产支持，也不要在没有目标设备和依赖清单验证时估算完整移植工期。

## Cognia 当前代码核查

核查日期：2026-10-04。仓库基线 HEAD 为 `9f8d27dbc`，结论针对当时的工作区（含已有未提交修改），不是已发布版本的验收结论。本次只增加研究文档，没有修改运行时代码或构建配置。

| 检查项         | 当前事实                                                                                                                                                                                                                                                                                                    | 对鸿蒙支持的含义                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 移动端架构     | [mobile/package.json](../../mobile/package.json) 使用 Capacitor；本地安装的 core/android 为 8.5.2；[mobile/README.md](../../mobile/README.md) 明确 Android/iOS 复用 Next.js 静态导出                                                                                                                        | 可复用前端，但 Android Java / iOS Swift 插件不因复用前端而成为 ArkTS 插件                                                                                                                            |
| 构建与发布     | 现有原生工程是 `mobile/android`、`mobile/ios`；[release.yml](../../.github/workflows/release.yml) 有 Android APK 和 iOS 发布任务                                                                                                                                                                            | 检索范围内未发现 HarmonyOS/ArkTS/Hvigor 目标、HAP 打包或鸿蒙发布任务                                                                                                                                 |
| Android 基线   | [variables.gradle](../../mobile/android/variables.gradle) 为 minSdk 24、compileSdk/targetSdk 36                                                                                                                                                                                                             | 旧鸿蒙 APK 路线仍需核查实际 Android API、WebView 和机型，不能只按 HarmonyOS 大版本保证兼容                                                                                                           |
| 无 GMS 扫码    | [barcode.ts](../../lib/capacitor/barcode.ts) 在 Android 检测不到 Google Play Services 或 Google 扫码模块失败时，转用随包模型的 `startScan` 路径；[CogniaDeviceServicesPlugin.java](../../mobile/android/app/src/main/java/com/cognia/mobile/CogniaDeviceServicesPlugin.java) 只检测服务，不弹安装提示       | 已有针对无 GMS 环境的实现基础，不应写成“华为设备无法扫码”；真实相机/权限/模型运行仍需真机验证                                                                                                        |
| 无 GMS 定位    | [geolocation.ts](../../lib/capacitor/geolocation.ts) 显式传入 `enableLocationFallback: true`；本地插件版本 8.2.2                                                                                                                                                                                            | 可回退 Android LocationManager；这是 Android 路线能力，不是鸿蒙原生定位适配。[官方 API 说明](https://capacitorjs.com/docs/apis/geolocation)                                                          |
| 远程推送       | [push-notifications.ts](../../lib/push/push-notifications.ts) 只识别 ios/android，并映射 apns/fcm；本次未发现 Huawei 推送通道                                                                                                                                                                               | 无 GMS 华为设备的后台远程通知存在明确缺口。FCM 有 Google 环境要求；前台连接与本地通知不能当作远程推送替代验收。[Firebase 要求](https://firebase.google.com/docs/cloud-messaging/android/get-started) |
| 平台识别       | [detect.ts](../../lib/platform/detect.ts) 以 `Capacitor.isNativePlatform()` 识别 mobile                                                                                                                                                                                                                     | ArkWeb 壳若没有兼容桥，会落到 web；不一定要增加新的顶层 Platform，但必须正确识别运行环境                                                                                                             |
| 插件注册       | [register-plugins.ts](../../lib/capacitor/register-plugins.ts) 依赖 `PluginHeaders` 和 core 的 `registerPlugin`；[_shared.ts](../../lib/capacitor/_shared.ts) 优先读取 `Capacitor.Plugins`                                                                                                                  | 必须逐项验证第三方桥与当前 8.5.2 注册机制、方法和事件语义，不能只确认网页能打开                                                                                                                      |
| 能力与平台分支 | [capabilities.ts](../../lib/platform/capabilities.ts) 为 mobile 声明 camera、barcode、voice、share、push、biometric 等；[navigation-bar.ts](../../lib/capacitor/navigation-bar.ts)、[screen-orientation.ts](../../lib/capacitor/screen-orientation.ts)、push 有 Android/iOS 限定                            | 接入新壳时必须按实际实现上报能力，避免尚未实现的功能显示为可用；需审计平台字符串分支                                                                                                                 |
| 凭据与连接     | [credential-book/stores.ts](../../lib/companion/credential-book/stores.ts) 通过 SecureStoragePlugin 保存设备私钥；[transport-instance.ts](../../lib/tauri/transport-instance.ts) 复用 CompanionTransport；[capacitor-http.ts](../../lib/connectivity/capacitor-http.ts) 明确自定义 TLS 扩展需要原生能力证明 | 可以复用配对协议与业务层，但鸿蒙安全存储、HTTP/WS、证书验证必须适配和实测，不能降级明文保存或忽略 TLS 错误                                                                                           |
| 局域网发现     | [mdns-discovery.ts](../../lib/connectivity/mdns-discovery.ts) 使用 capacitor-zeroconf                                                                                                                                                                                                                       | 当前 Android/iOS 原生实现不等于鸿蒙 mDNS 已实现；第一轮原型可手动输入地址，但正式功能仍需补齐                                                                                                        |

对 `lib/`、`components/`、`hooks/`、`src-tauri/`、`mobile/`、英文 ADR、工作流和构建脚本的 HarmonyOS/OpenHarmony/ArkWeb/ArkTS/OHOS 关键词检索未发现专用实现。这个结果与工程清单、依赖和发布流程相互印证；不是对所有未跟踪/忽略产物的穷尽证明。

## 建议路线与验收

1. **现有 APK 兼容验证**：在保留 Android 兼容性的旧鸿蒙真机，以及 HarmonyOS 5+ 的卓易通环境各验证一次。记录机型、OS build、兼容服务版本、APK hash。验证安装、离线冷启动、登录/配对、流式对话、相机/扫码、文件、键盘返回、锁屏恢复、网络切换；远程推送独立验收。不要将兼容容器成功写成原生鸿蒙支持。
2. **浏览器过渡入口**：使用现有 Web/Companion 路线，优先验证浏览器中的登录、配对、流式消息、上传和重连。HTTPS、CORS、WebSocket/WebRTC、IndexedDB、麦克风权限、PWA 安装/后台行为均按目标浏览器验证；目前没有本次真机证据，不能承诺原生能力一致。
3. **原生鸿蒙可行性原型**：比较第三方 Capacitor port 与直接 ArkTS + ArkWeb 薄壳。先完成“移动构建静态资源 → 真机启动 → 安全保存配对私钥 → 连接主机 → 流式对话 → 重启恢复”。这能测试决定路线的桥接、存储和网络风险。随后才扩展扫码、相册、录音、分享、生物识别、mDNS、推送与系统 UI。
4. **正式支持门槛**：明确目标商业 HarmonyOS SDK/机型；完成原生插件矩阵、拒绝权限与异常路径、签名打包、升级数据保留、AppGallery 流程和真实设备回归。OpenHarmony 示例成功不能直接充当商业 HarmonyOS 发布证据。

建议先做 APK/浏览器实测，再决定是否投入原生 port。当前证据足以判断“缺什么”和制定原型，尚不足以给出可靠工期或功能复用百分比。

## 本次验证记录

执行现有定向测试：

```bash
rtk pnpm exec jest --runInBand --runTestsByPath lib/capacitor/google-play-services.test.ts lib/capacitor/barcode.test.ts lib/capacitor/geolocation.test.ts lib/push/push-notifications.test.ts lib/platform/detect.test.ts
```

结果：

```text
Test Suites: 5 passed, 5 total
Tests:       104 passed, 104 total
Snapshots:   0 total
```

这些测试验证现有 TypeScript 逻辑与模拟插件分支，不证明华为真机、卓易通、ArkWeb、HAP、实际推送投递或应用市场审核通过。本次未构建或安装鸿蒙应用，未运行鸿蒙设备 E2E。

已有 [2026-07-27 研究](./capacitor-harmonyos-openharmony-support-2026-07-27.md) 保留作历史资料。使用时以本次核查的现行官方安装说明、当前工作区实现和重新核实的依赖状态为准；旧文档中的构建命令与插件覆盖数量不应直接当作当前事实。

## Sources

正文在相应结论旁链接了当前代码、Huawei Consumer Support / Developer、Ionic Capacitor、Firebase、OpenHarmony 以及适配器维护者源码与 npm registry。在线来源访问日期为 2026-10-04；动态页面与 latest 标签可能变化，正式接入时应固定源码和版本。
