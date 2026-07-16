# 复用 Chrome / Chromium 登录态 → 注入内嵌浏览器（macOS 路径 A）

**日期**: 2026-07-16
**状态**: plan（未改任何代码，逐阶段交给实现 agent）
**目标 ADR**: 新建 **ADR-0073**（`docs/content/docs/en/adr/0073-chromium-cookie-import.md` + `zh` 页）
**涉及子系统**: `lib/browser/`、`components/browser/`、`src-tauri/src/browser/` —— 现有 ADR-0055（agent loop）、ADR-0072（recording）
**引擎前提**: 内嵌浏览器 macOS=WKWebView，Windows=WebView2，Linux=WebKitGTK（Tauri/wry，`src-tauri/src/browser/embedded.rs`），与 Chrome 的 profile **完全隔离**。

---

## 0. 这份文档解决什么

需求原话：「现有的机器人能否直接复用 Chrome 或其他浏览器中的各种信息和 Cookie」。

上一轮研究已排除两条路（记录在此避免有人重提）：

| 路径                       | 结论                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| B. CDP 驱动用户真实 Chrome | Chrome 136 起 `--remote-debugging-port` 对默认 profile 目录失效，必须配非默认 `--user-data-dir`，与"复用现有登录态"对冲 |
| Windows 直读 cookie 库     | Chrome 127+ 的 App-Bound Encryption（v20）需 SYSTEM/进程注入才能解，等同 infostealer 手法，红线不做                     |

**本方案只做路径 A，且仅在 macOS 完整落地**——因为 macOS 上 Chrome 至今（2026）仍是 v10 / Keychain "Safe Storage" 方案，无 app-bound，也无相关计划。Windows/Linux 明确降级为「不支持」，按 **Working Rule 7** 三轴标注 dormancy。

**产品形态**：内嵌浏览器打开某公网站点（未登录）→ 用户点「复用 Chrome 登录态」→ 我们读取该域名对应的 Chrome cookie、解密、注入内嵌 WKWebView → reload 即为已登录态。惠及 agent 读取需登录的页面、在登录态下录制流程、用户预览。

---

## 1. 已核实的技术事实（实现前必读，全部有据）

### 1.1 macOS Chrome cookie 加密（v10，2026 现状）

- master key 存 Keychain，条目 **service=`Chrome Safe Storage`、account=`Chrome`**，值是 base64 字符串，**直接**当口令用（不解 base64）。
- 派生：`key = PBKDF2-HMAC-SHA1(passphrase, salt="saltysalt", iterations=1003, dkLen=16)`（AES-128）。
- 加密：`AES-128-CBC`，**IV = 16 字节 `0x20`**，PKCS#5/7 填充。
- `encrypted_value` 以 ASCII `v10` 开头（3 字节）。
- **DB `meta.version` ≥ 24 时**：解密后的明文**前置 32 字节 = `SHA256(host_key)`**，必须剥掉再取真实值。
- `expires_utc` 单位是「1601-01-01 起的微秒」：`unix = expires_utc/1_000_000 - 11_644_473_600`；`== 0` 表示 session cookie。

### 1.2 Chromium 全家（macOS 上同一套，几乎零成本泛化）

| 浏览器   | Keychain service              | profile 根目录（`~/Library/Application Support/...`） |
| -------- | ----------------------------- | ----------------------------------------------------- |
| Chrome   | `Chrome Safe Storage`         | `Google/Chrome/<Profile>/Cookies`                     |
| Edge     | `Microsoft Edge Safe Storage` | `Microsoft Edge/<Profile>/Cookies`                    |
| Brave    | `Brave Safe Storage`          | `BraveSoftware/Brave-Browser/<Profile>/Cookies`       |
| Chromium | `Chromium Safe Storage`       | `Chromium/<Profile>/Cookies`                          |

account 字段均为浏览器主名（Chrome/Microsoft Edge/Brave/Chromium）。`<Profile>` 常见 `Default`、`Profile 1`…。Firefox 是另一套（NSS，无此加密），**列为 future，本方案不做**。

### 1.3 Tauri 拿到底层 WKWebView（无需 patch wry）

```rust
webview.with_webview(|pw| {
    #[cfg(target_os = "macos")] unsafe {
        let view: &objc2_web_kit::WKWebView = &*pw.inner().cast();
        // view.configuration().websiteDataStore().httpCookieStore()...
    }
})?;
```

`with_webview` 闭包在**主线程**执行（满足 `WKHTTPCookieStore` 主线程要求）。仓库现有 `src-tauri/src/fleet/island_window.rs:219-269` 已用 objc2 做 NSScreen FFI，范式现成；从 tokio worker 调用时用 `run_on_main_thread`。

### 1.4 现有代码事实（决定接入点）

- 内嵌 webview 目前**不**用 `with_webview`，只用 Tauri 安全 API（`app.get_webview(EMBED_LABEL)`，`embedded.rs`）。EMBED_LABEL = `"browser-embed"`。
- 命令注册在 `src-tauri/src/lib.rs` 的 `generate_handler!`（约 1041-1085 行，`browser::embedded::browser_embed_*` 一串）。
- `src-tauri/src/browser/mod.rs` 现有 `pub mod commands / embedded / overlay;`。
- 已在 `Cargo.toml`：`aes 0.9`、`cbc 0.2`、`hmac 0.13`、`sha1 0.11`、`sha2 0.11`、`base64 0.22`、`hex 0.4`、`objc2 0.6`、`objc2-app-kit 0.3`、`keyring 3 (apple-native)`、`core-foundation`。
- 命令全部 `#[cfg(desktop)]`（unstable 多 webview 仅桌面）。

**依赖增量**：`pbkdf2 = "0.13"`；`objc2-web-kit`、`objc2-foundation`（`#[cfg(macos)]`，pin 到与 Tauri 2.11 匹配的版本）；`rusqlite`（bundled，**先确认原生向量库是否已拉 `libsqlite3-sys` 可复用**，否则新增）。

---

## 2. 平台策略（"分平台处理"核心）

| 平台        | 策略                                                                              | 依据                                |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| **macOS**   | 完整路径 A：Keychain 授权 → 读 Cookies 库 → 解密 → 注入 WKWebView                 | Safe Storage 可授权读，无 app-bound |
| **Windows** | `CookieImportResult::Unsupported{reason}`，UI 灰显 + 文案引导（建议独立 profile） | app-bound v20 红线                  |
| **Linux**   | 同 Windows 降级（libsecret/kwallet/"peanuts" 可作后续）                           | 收敛首版范围                        |

**Working Rule 7 三轴**（缺一即 latent bug）：

1. **类型**：非 macOS 返回 `Unsupported`；
2. **UI**：按钮灰显并显示原因（i18n 文案）；
3. **测试**：pin 住「非 macOS ⇒ Unsupported」分支。

---

## 3. 架构与数据流

```
用户在内嵌浏览器打开 github.com（未登录）
   │ 点击「复用 Chrome 登录态」→ 首次弹我方 consent 对话框
   ▼
[TS] lib/browser/cookie-import.ts
   │  transport.call("browser_cookie_import", {browser, profile, domain:"github.com"})
   ▼
[Rust] browser::cookie_import::browser_cookie_import   ── 单命令内闭环 ──
   │  ① keychain_read("<X> Safe Storage")           → 触发 macOS 授权框
   │  ② copy Cookies sqlite(+wal,+shm)→temp，读 host_key 命中 eTLD+1 的行
   │  ③ 逐行解密 encrypted_value（v10 → AES-128-CBC → 剥 32B SHA256 前缀）
   │  ④ webview.with_webview → WKHTTPCookieStore.setCookie 注入
   ▼
   返回 CookieImportResult::Ok{ injected, names, domains }   ← 仅元数据
   │
   ▼  前端触发 embedNavigate/reload → 已登录
```

**铁律**：解密后的 cookie 值**全程留在 Rust 进程**，读→解密→注入在同一命令内闭环；**绝不跨 IPC 回 JS、绝不落 Dexie、绝不进日志**。JS 侧只拿到「注入几条、哪些 name、哪些 domain」等非敏感元数据。

---

## 4. Rust 模块设计

新增目录 `src-tauri/src/browser/cookie_import/`，在 `browser/mod.rs` 加 `pub mod cookie_import;`：

```
cookie_import/
├── mod.rs              # 公开命令 + 平台 dispatch + 类型 + 错误枚举 + trait 边界
├── chromium.rs         # 跨平台纯逻辑：sqlite 解析 / 解密 / 时间戳 / 域名过滤（100% 可单测）
├── keychain_macos.rs   # #[cfg(macos)] 读 "<X> Safe Storage" 口令
└── inject_macos.rs     # #[cfg(macos)] with_webview + objc2-web-kit 注入
```

### 4.1 类型（`mod.rs`）

```rust
pub enum ChromiumBrowser { Chrome, Edge, Brave, Chromium }
impl ChromiumBrowser {
    fn safe_storage_service(&self) -> &'static str; // "Chrome Safe Storage" ...
    fn keychain_account(&self) -> &'static str;     // "Chrome" ...
    fn profiles_root(&self) -> PathBuf;             // ~/Library/Application Support/...
}

// 仅存活于 Rust 进程内；手写脱敏 Debug（禁止打印 value）
pub struct ImportedCookie {
    host_key: String, name: String, value: String, path: String,
    expires_unix: Option<i64>, is_secure: bool, is_httponly: bool, samesite: SameSite,
}

#[serde(tag = "kind")]
pub enum CookieImportResult {
    Ok { injected: usize, names: Vec<String>, domains: Vec<String> },
    Unsupported { reason: String },   // 非 macOS
    PermissionDenied,                 // Keychain 拒绝
    NoProfile,
    NoMatchingCookies,
}
```

### 4.2 命令（注册进 `lib.rs` 的 `generate_handler!`，紧挨 `browser_embed_*`）

- `browser_cookie_import_available(browser) -> { supported: bool, profiles: Vec<String>, reason: Option<String> }`
  探测平台是否 macOS + profile 目录是否存在，**不触发 Keychain**，供 UI 决定按钮可用性。
- `browser_cookie_import(browser, profile, domain) -> CookieImportResult`
  主命令，读→解密→注入闭环。domain 取其 eTLD+1 做过滤。

### 4.3 可测性边界（关键）

把两个不可单测的副作用抽成 trait，让 `chromium.rs` 的编排逻辑用 fake 覆盖：

```rust
trait Keychain { fn read(&self, service: &str, account: &str) -> Result<String, ImportError>; }
trait CookieSink { fn inject(&self, cookies: &[ImportedCookie]) -> Result<usize, ImportError>; }
```

真实实现 `MacKeychain`（keyring/security-framework）、`WkWebviewSink`（objc2）极薄，走集成/手测；纯逻辑（解密、过滤、时间戳、结果编排）全部单测。

---

## 5. 解密与读取细节（`chromium.rs`，可直接实现）

```rust
// —— key ——
let pass = keychain.read(browser.safe_storage_service(), browser.keychain_account())?;
let mut key = [0u8; 16];
pbkdf2::pbkdf2_hmac::<Sha1>(pass.as_bytes(), b"saltysalt", 1003, &mut key);

// —— 读库（规避 Chrome 常驻锁）——
// 把 Cookies(+ -wal + -shm) 拷到 temp，用 URI `?mode=ro&immutable=1` 只读打开
// meta 表取 version 判断是否 >= 24（决定是否剥 SHA256 前缀）
// SELECT host_key,name,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite
//   FROM cookies WHERE <host_key 命中 eTLD+1>

// —— value ——
let ct = &enc[3..];                       // 去 "v10"
let iv = [0x20u8; 16];
let mut pt = aes128_cbc_decrypt(&key, &iv, ct)?;   // cbc + PKCS7 去填充
if db_version >= 24 { pt.drain(0..32); }  // 剥 SHA256(host_key)
let value = String::from_utf8(pt)?;

// —— 时间戳 ——
let expires_unix = if expires_utc == 0 { None }
                   else { Some(expires_utc / 1_000_000 - 11_644_473_600) };
```

**域名过滤**：目标 `github.com` 要命中 `host_key ∈ {github.com, .github.com, www.github.com, ...}`——即 host_key 去掉前导 `.` 后是目标 eTLD+1 的同域或子域。用 publicsuffix 逻辑或后缀匹配实现，避免误拉跨域 cookie。

**边界**：

- 空口令 / 无 `v10` 前缀 / 解密失败 / UTF-8 失败 → 跳过该行并计数，不整体失败。
- profile 不存在 → `NoProfile`；命中 0 行 → `NoMatchingCookies`。

---

## 6. 注入细节（`inject_macos.rs`）

```rust
webview.with_webview(move |pw| {
    #[cfg(target_os = "macos")] unsafe {
        let view: &WKWebView = &*pw.inner().cast();
        let store = view.configuration().websiteDataStore().httpCookieStore();
        for c in &cookies {
            // NSDictionary<NSHTTPCookiePropertyKey, _>:
            //   Name, Value, Domain(host_key), Path,
            //   Secure(if is_secure), HTTPOnly(if is_httponly),
            //   Expires(NSDate, 省略=session), SameSite(map)
            if let Some(cookie) = NSHTTPCookie::initWithProperties(&props) {
                store.setCookie_completionHandler(&cookie, None);
            }
        }
    }
})?;
```

**注意点**：

- WebKit 已知同步 bug（webkit.org #198553）：webview 刚建好即 setCookie 可能丢——本方案注入时机在 webview **已存活、导航目标域之前**；必要时先塞一个 dummy cookie 触发同步。
- 注入后由**前端**发 `browser_embed_navigate`/reload 让 cookie 生效（Rust 命令只负责注入，导航交回 TS 编排层，符合现有职责划分）。
- SameSite / Secure / HTTPOnly / Expires 逐字段映射，session cookie 省略 Expires。

---

## 7. 前端 / UI / i18n

- **`lib/browser/cookie-import.ts`**：`isChromeCookieImportAvailable(browser)`、`importChromeCookies({browser, profile, domain})`，类型 + result→文案映射；co-located `cookie-import.test.ts`。
- **UI 入口**：`components/browser/browser-preview-pane.tsx` 增一个「复用 Chrome 登录态」动作（下拉选浏览器/profile）。**首次使用弹我方 consent 对话框**：说明"将读取所选浏览器保存的登录 Cookie 并注入当前预览页，仅本机、不上传"，确认后才调命令（随后系统弹 Keychain 授权框）。
- **设置开关**：`components/settings/` 下新增 feature toggle（默认关）；关闭时 `available` 直接返回不支持、按钮短路。
- **i18n**：按钮、consent、各 result 文案、Windows/Linux unsupported 说明，全部进 `i18n/messages/{en,zh-CN}/browser.json`（走 split-source，`pnpm i18n:build` 后 `pnpm lint:i18n` 保 parity）。**无硬编码用户可见串**（Working Rule 4）。

---

## 8. 安全与合规

- Cookie 值**不过 IPC / 不落库 / 不进日志**；`ImportedCookie` 手写脱敏 `Debug`。
- **不经 PII gate**——非 LLM/embedding 调用，是纯本机 Chrome→WKWebView 搬运（PII gate 针对外发模型的文本，`packages/redact`）。
- 确保注入的 cookie 不经 `evaluate()` 泄给模型：`evaluate` 本就 trust-gated（仅 localhost 可用，`lib/browser/protocol.ts:resolveTrustTier`），公网站点上被禁，天然隔离。
- Keychain 授权是**用户显式同意**的 OS 级门；拒绝 → `PermissionDenied` → UI 提示。
- 只按目标域最小拉取，绝不 dump 整个 cookie jar。
- **不新建任何 keyring 条目**（遵守 secret-store single-master-key 约束，`src-tauri` secret_store），只读 Chrome 既有条目。

---

## 9. 测试计划（≥90% + co-located，Working Rule 3）

**Rust `#[cfg(test)]`（`chromium.rs` 纯逻辑全覆盖）**

- PBKDF2 已知答案：固定口令 → 比对预算 16B key。
- AES-128-CBC：测试内用已知 key/IV 加密已知明文得密文，再解密断言；覆盖 v10 前缀剥离 + `db_version>=24` 的 SHA256(32B) 前缀剥离两分支。
- 时间戳：1601µs → unix；`0` → session（None）。
- 域名过滤：精确域 / `.github.com` / `www.` 命中，跨域不命中。
- sqlite：测试内建临时库（建 `cookies` + `meta` 表、插行）→ 解析。
- 结果编排：`NoProfile` / `NoMatchingCookies` / 单行解密失败被跳过计数。
- 平台分支：非 macOS ⇒ `Unsupported`（cfg 或注入 platform flag）。
- Keychain + 注入：用 fake `Keychain` / `CookieSink` 测编排；真实 objc 路径薄、走手测。

**TS（`cookie-import.test.ts`）**：mock transport，断言命令名/参数、availability 门控、result→UI 文案、feature 开关短路。

**Rust 测试执行**：读 tee log 判断真实退出码（rtk 会掩盖 cargo 失败，见 memory `rust-toolchain-baseline-broken`）。

---

## 10. 交付物与门禁

- **ADR-0073**：`docs/content/docs/en/adr/0073-chromium-cookie-import.md`（+ zh 页），记录范围、平台矩阵、安全边界、dormancy 决策、已知假设（Chrome 若在 mac 上 app-bound 则失效）。用 `subsystem-docs` 技能。
- **Subsystem Map**：`CLAUDE.md` 加一行（Lives in / ADR 0073）。
- **changeset**：`pnpm changeset` 选 `cognia-next`、`minor`（用户可感知新能力）。
- **门禁**（提交前）：`pnpm typecheck` → `cargo test`（读 tee log）→ `pnpm i18n:build && pnpm lint:i18n` → `pnpm test:coverage:changed -- --strict` → **`preflight` 六审**。

---

## 11. 分阶段实施

```
P1 (Rust 纯逻辑核) ──► P2 (macOS Keychain+注入) ──► P3 (TS/UI/i18n) ──► P4 (dormancy+ADR+changeset+门禁)
   ↑ 无平台耦合，先 red-green            ↑ 需真机手测一次真登录复用
```

| 阶段   | 内容                                                               | 验证                                          |
| ------ | ------------------------------------------------------------------ | --------------------------------------------- |
| **P1** | `chromium.rs`：sqlite 解析 + 解密 + 过滤 + 时间戳 + trait 边界     | `cargo test` 全绿（已知答案向量）             |
| **P2** | `keychain_macos.rs` + `inject_macos.rs` + 2 命令注册               | 真机：Chrome 登录 github → 内嵌浏览器复用成功 |
| **P3** | `cookie-import.ts` + preview-pane 入口 + consent + 设置开关 + i18n | 前端测试 + `agent-browser`/手动驱动一次       |
| **P4** | Win/Linux dormancy 三轴 + ADR-0073 + changeset + 六审              | `preflight` + i18n parity                     |

- **可并行**：P1 与 P3 的类型/文案骨架无文件冲突，但注入依赖 P2。建议 P1→P2 串行（都在 Rust），P3 待命令签名定稿后接入。
- 工作量粗估：Rust ~2 天、前端/UI ~1 天、测试与文档 ~1 天，合计 **3–4 人日**。

---

## 12. 风险与边界（提前挑明）

- **Keychain 授权框可见、可被拒**——特性非 bug，UI 需讲清并优雅降级为 `PermissionDenied`。
- **Chrome 未来若在 macOS 上 app-bound**（目前无计划）→ 本路径失效，ADR 记为已知假设。
- **WAL 只读可能读到略旧 cookie**——登录态稳定，可忽略。
- 仅解决「内嵌 WKWebView 复用登录态」；**不涉及**驱动用户真实 Chrome（路径 B/C，已排除）。
- **Firefox 不在范围**（NSS 另一套），列 future。

---

## 附录：一次性事实核对来源

- Chrome cookie 加密格式（含 db≥24 的 SHA256 前缀）: https://gist.github.com/creachadair/937179894a24571ce9860e2475a2d2ec
- macOS 仍 Keychain / 无 app-bound: https://www.cyberark.com/resources/threat-research-blog/the-current-state-of-browser-cookies
- macOS 解密实操: https://dev.to/jacobgadek/reverse-engineering-chromes-cookie-encryption-to-authenticate-ai-agents-212i
- 跨平台解密参考实现: https://github.com/bertrandom/chrome-cookies-secure
- Tauri `with_webview` / `PlatformWebview::inner`: https://docs.rs/tauri/latest/x86_64-apple-ios/tauri/webview/struct.Webview.html
- wry macOS WKWebView: https://deepwiki.com/tauri-apps/wry/3.2-macosios-(wkwebview)
- Chrome 136 remote-debugging 变更（排除路径 B 的依据）: https://developer.chrome.com/blog/remote-debugging-port
