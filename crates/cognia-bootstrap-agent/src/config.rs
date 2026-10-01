//! Versioned standalone contract. Errors deliberately omit user input.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u8,
    pub task: String,
    pub model: Model,
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub context: Context,
    #[serde(default)]
    pub tools: ToolConfig,
    pub setup_command: Option<String>,
    #[serde(default)]
    pub checks: Vec<Check>,
    #[serde(default)]
    pub limits: Limits,
    #[serde(default)]
    pub reuse: Reuse,
    /// Names only: values are invocation-scoped and never persisted.
    #[serde(default)]
    pub secret_env: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub base_url: String,
    pub model: String,
    #[serde(default = "key_env")]
    pub api_key_env: String,
    #[serde(default = "request_timeout")]
    pub request_timeout_secs: u64,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub show_thinking: bool,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub seed: Option<i64>,
    pub reasoning_effort: Option<String>,
    pub thinking: Option<Value>,
    #[serde(default)]
    pub extra_body: BTreeMap<String, Value>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub headers_env: BTreeMap<String, String>,
    #[serde(default)]
    pub auth: Auth,
    pub api_key_header: Option<String>,
    pub endpoint_path: Option<String>,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Auth {
    #[default]
    Bearer,
    None,
    Header,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolProfile {
    #[default]
    Native,
    Dsh,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ToolConfig {
    pub shell: bool,
    pub editor: bool,
    pub profile: ToolProfile,
    pub shell_executable: String,
    pub shell_args: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub max_file_bytes: usize,
}
impl Default for ToolConfig {
    fn default() -> Self {
        Self {
            shell: true,
            editor: true,
            profile: ToolProfile::Native,
            shell_executable: "/bin/bash".into(),
            shell_args: vec!["--noprofile".into(), "--norc".into()],
            environment: BTreeMap::new(),
            max_file_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Context {
    pub context_window_tokens: usize,
    pub auto_compact: bool,
    pub compact_threshold_tokens: Option<usize>,
    pub compact_retain_tokens: Option<usize>,
    pub compact_max_tokens: u64,
    pub compact_retries: usize,
    pub max_overflow_retries: usize,
    pub prune_tool_results: bool,
    pub prune_threshold_bytes: usize,
    pub prune_head_bytes: usize,
    pub prune_tail_bytes: usize,
}
impl Default for Context {
    fn default() -> Self {
        Self {
            context_window_tokens: 1_000_000,
            auto_compact: true,
            compact_threshold_tokens: None,
            compact_retain_tokens: None,
            compact_max_tokens: 8192,
            compact_retries: 1,
            max_overflow_retries: 1,
            prune_tool_results: true,
            prune_threshold_bytes: 8192,
            prune_head_bytes: 4096,
            prune_tail_bytes: 1024,
        }
    }
}
impl Context {
    pub fn threshold_tokens(&self) -> usize {
        self.compact_threshold_tokens
            .unwrap_or(self.context_window_tokens * 80 / 100)
    }
    pub fn retain_tokens(&self) -> usize {
        self.compact_retain_tokens
            .unwrap_or(self.context_window_tokens * 16 / 100)
    }
}

fn key_env() -> String {
    "COGNIA_BOOTSTRAP_API_KEY".into()
}
fn request_timeout() -> u64 {
    60
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Check {
    pub name: String,
    pub command: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Limits {
    pub max_steps: usize,
    pub total_timeout_secs: u64,
    pub command_timeout_secs: u64,
    pub max_output_bytes: usize,
    pub max_context_bytes: usize,
    pub max_response_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_steps: 32,
            total_timeout_secs: 600,
            command_timeout_secs: 60,
            max_output_bytes: 16000,
            max_context_bytes: 128000,
            max_response_bytes: 1048576,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reuse {
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub outputs: Vec<String>,
}

pub fn relative_path(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

impl Config {
    pub fn parse(text: &str) -> Result<Self, &'static str> {
        if text.len() > 1024 * 1024 {
            return Err("config-too-large");
        }
        let value: Self = serde_json::from_str(text).map_err(|_| "invalid-config")?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || self.task.trim().is_empty()
            || self.task.len() > 32000
            || self.model.model.trim().is_empty()
            || self.model.model.len() > 256
            || self.model.model.chars().any(char::is_control)
        {
            return Err("invalid-config");
        }
        let env = &self.model.api_key_env;
        if env.is_empty()
            || env.len() > 128
            || !env
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
        {
            return Err("invalid-credential-env");
        }
        self.endpoint()?;
        if self
            .system_prompt
            .as_ref()
            .is_some_and(|v| v.trim().is_empty() || v.len() > 64 * 1024)
        {
            return Err("invalid-system-prompt");
        }
        let model = &self.model;
        if model.max_tokens.is_some_and(|n| n == 0 || n > 16_777_216)
            || model
                .temperature
                .is_some_and(|n| !n.is_finite() || !(0.0..=2.0).contains(&n))
            || model
                .top_p
                .is_some_and(|n| !n.is_finite() || !(0.0..=1.0).contains(&n))
            || model
                .reasoning_effort
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 128 || v.chars().any(char::is_control))
            || model
                .thinking
                .as_ref()
                .is_some_and(|v| !v.is_object() || unsafe_provider_value(v))
            || model.extra_body.len() > 64
            || model.extra_body.keys().any(|key| {
                matches!(
                    key.as_str(),
                    "model"
                        | "messages"
                        | "tools"
                        | "stream"
                        | "tool_choice"
                        | "max_tokens"
                        | "temperature"
                        | "top_p"
                        | "seed"
                        | "reasoning_effort"
                        | "thinking"
                        | "api_key"
                        | "apiKey"
                        | "authorization"
                        | "headers"
                        | "endpoint"
                        | "base_url"
                )
            })
            || model
                .extra_body
                .iter()
                .any(|(key, value)| unsafe_provider_key(key) || unsafe_provider_value(value))
            || serde_json::to_vec(&model.extra_body).map_or(true, |v| v.len() > 64 * 1024)
        {
            return Err("invalid-model-options");
        }
        if model.headers.len() + model.headers_env.len() > 64
            || model.headers.iter().any(|(name, value)| {
                !valid_header_name(name)
                    || sensitive_name(name)
                    || value.len() > 8192
                    || reqwest::header::HeaderValue::from_str(value).is_err()
            })
            || model.headers_env.iter().any(|(name, env)| {
                !valid_header_name(name)
                    || !valid_env_name(env)
                    || model
                        .headers
                        .keys()
                        .any(|other| other.eq_ignore_ascii_case(name))
            })
            || model
                .headers
                .keys()
                .chain(model.headers_env.keys())
                .any(|name| {
                    matches!(
                        name.to_ascii_lowercase().as_str(),
                        "host"
                            | "content-length"
                            | "transfer-encoding"
                            | "content-type"
                            | "connection"
                            | "proxy-authorization"
                    )
                })
            || model
                .headers
                .keys()
                .chain(model.headers_env.keys())
                .map(|name| name.to_ascii_lowercase())
                .collect::<HashSet<_>>()
                .len()
                != model.headers.len() + model.headers_env.len()
            || (model.auth == Auth::Header
                && model.api_key_header.as_ref().is_none_or(|name| {
                    !valid_header_name(name)
                        || matches!(
                            name.to_ascii_lowercase().as_str(),
                            "host"
                                | "content-length"
                                | "transfer-encoding"
                                | "content-type"
                                | "connection"
                                | "proxy-authorization"
                        )
                }))
            || (model.auth != Auth::None
                && model
                    .headers
                    .keys()
                    .chain(model.headers_env.keys())
                    .any(|name| {
                        name.eq_ignore_ascii_case(
                            model
                                .api_key_header
                                .as_deref()
                                .filter(|_| model.auth == Auth::Header)
                                .unwrap_or("authorization"),
                        )
                    }))
        {
            return Err("invalid-model-headers");
        }
        let context = &self.context;
        if !(128..=16_777_216).contains(&context.context_window_tokens)
            || context.threshold_tokens() == 0
            || context.threshold_tokens() > context.context_window_tokens
            || context.retain_tokens() >= context.threshold_tokens()
            || !(1..=1_048_576).contains(&context.compact_max_tokens)
            || context.compact_retries > 10
            || context.max_overflow_retries > 10
            || !(256..=8_388_608).contains(&context.prune_threshold_bytes)
            || context
                .prune_head_bytes
                .checked_add(context.prune_tail_bytes)
                .is_none_or(|n| n >= context.prune_threshold_bytes)
        {
            return Err("invalid-context-options");
        }
        let tools = &self.tools;
        if tools.shell_executable.is_empty()
            || tools.shell_executable.len() > 4096
            || tools.shell_executable.chars().any(char::is_control)
            || tools.shell_args.len() > 32
            || tools
                .shell_args
                .iter()
                .any(|arg| arg.len() > 4096 || arg.contains('\0'))
            || tools.environment.len() > 128
            || tools.environment.iter().any(|(name, value)| {
                !valid_env_name(name)
                    || unsafe_environment(name)
                    || value.contains('\0')
                    || value.starts_with("() {")
                    || value.len() > 8192
                    || self.credential_env_names().contains(name)
                    || name == &self.model.api_key_env
                    || self.secret_env.contains(name)
            })
            || !(1024..=16 * 1024 * 1024).contains(&tools.max_file_bytes)
        {
            return Err("invalid-tool-options");
        }
        if self.secret_env.len() > 128
            || self.secret_env.iter().any(|s| !valid_env_name(s))
            || self.secret_env.iter().collect::<HashSet<_>>().len() != self.secret_env.len()
        {
            return Err("invalid-secret-env");
        }
        let l = &self.limits;
        if !(1..=256).contains(&l.max_steps)
            || !(1..=86400).contains(&l.total_timeout_secs)
            || !(1..=3600).contains(&l.command_timeout_secs)
            || !(1..=600).contains(&self.model.request_timeout_secs)
            || !(256..=1048576).contains(&l.max_output_bytes)
            || !(4096..=8388608).contains(&l.max_context_bytes)
            || !(1024..=8388608).contains(&l.max_response_bytes)
        {
            return Err("invalid-limits");
        }
        let mut names = HashSet::new();
        if self.checks.len() > 64 {
            return Err("invalid-checks");
        }
        for check in &self.checks {
            if check.name.is_empty()
                || check.name.len() > 128
                || !check
                    .name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_- .".contains(&b))
                || check.command.trim().is_empty()
                || check.command.len() > 32000
                || !names.insert(&check.name)
            {
                return Err("invalid-checks");
            }
        }
        if self
            .setup_command
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.len() > 32000)
        {
            return Err("invalid-setup");
        }
        for paths in [&self.reuse.inputs, &self.reuse.outputs] {
            if paths.len() > 128
                || paths.iter().any(|p| !relative_path(p))
                || paths.iter().collect::<HashSet<_>>().len() != paths.len()
            {
                return Err("invalid-reuse-paths");
            }
        }
        Ok(())
    }
    pub fn credential_env_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.model.headers_env.values().cloned().collect();
        if self.model.auth != Auth::None {
            names.push(self.model.api_key_env.clone());
        }
        names.sort();
        names.dedup();
        names
    }
    pub fn endpoint(&self) -> Result<url::Url, &'static str> {
        let mut url = url::Url::parse(&self.model.base_url).map_err(|_| "invalid-model-url")?;
        let local = url.host_str().is_some_and(|h| {
            h == "localhost"
                || h.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|i| i.is_loopback())
        });
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || (url.scheme() != "https" && !(url.scheme() == "http" && local))
        {
            return Err("invalid-model-url");
        }
        let suffix = self
            .model
            .endpoint_path
            .as_deref()
            .unwrap_or("chat/completions")
            .trim_start_matches('/');
        if suffix.is_empty()
            || suffix.len() > 2048
            || suffix.chars().any(char::is_control)
            || suffix.contains(['?', '#', '%', '\\'])
            || suffix
                .split('/')
                .any(|part| part == ".." || part == "." || part.is_empty())
        {
            return Err("invalid-model-endpoint");
        }
        let base_path = url.path().trim_end_matches('/');
        let path = if self.model.endpoint_path.is_none() && base_path.ends_with("/chat/completions")
        {
            base_path.to_owned()
        } else {
            format!("{}/{}", base_path, suffix)
        };
        url.set_path(&path);
        Ok(url)
    }
}

fn unsafe_provider_key(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "api_key"
            | "apikey"
            | "authorization"
            | "password"
            | "access_token"
            | "api_token"
            | "token"
            | "secret"
            | "credentials"
            | "cookie"
    )
}
fn unsafe_provider_value(value: &Value) -> bool {
    unsafe_provider_encoded(value, 0)
}
fn unsafe_provider_encoded(value: &Value, depth: usize) -> bool {
    match value {
        Value::Object(values) => values.iter().any(|(name, value)| {
            unsafe_provider_key(name) || unsafe_provider_encoded(value, depth)
        }),
        Value::Array(values) => values
            .iter()
            .any(|value| unsafe_provider_encoded(value, depth)),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .is_ok_and(|nested| depth >= 8 || unsafe_provider_encoded(&nested, depth + 1)),
        _ => false,
    }
}
fn valid_header_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && reqwest::header::HeaderName::from_bytes(value.as_bytes()).is_ok()
}
fn sensitive_name(value: &str) -> bool {
    let name = value.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "key",
        "token",
        "secret",
        "password",
        "credential",
    ]
    .iter()
    .any(|part| name.contains(part))
}
fn unsafe_environment(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    sensitive_name(value)
        || upper.starts_with("BASH_FUNC_")
        || [
            "BASH_ENV",
            "ENV",
            "SHELLOPTS",
            "BASHOPTS",
            "CDPATH",
            "GLOBIGNORE",
            "NODE_OPTIONS",
            "NODE_PATH",
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "PYTHONHOME",
            "PERL5OPT",
            "PERL5LIB",
            "RUBYOPT",
            "RUBYLIB",
            "LD_PRELOAD",
            "LD_AUDIT",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "DYLD_FRAMEWORK_PATH",
            "SSH_AUTH_SOCK",
            "SSH_AGENT_PID",
            "GIT_ASKPASS",
            "SSH_ASKPASS",
            "AWS_CONFIG_FILE",
            "AWS_SHARED_CREDENTIALS_FILE",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "DATABASE_URL",
            "REDIS_URL",
        ]
        .contains(&upper.as_str())
}
fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_credentials_in_thinking_and_json_encoded_provider_options() {
        for extension in [
            serde_json::json!({"thinking":{"type":"enabled","credentials":{"api_key":"short-private"}}}),
            serde_json::json!({"extraBody":{"provider_options":"{\"credentials\":{\"api_key\":\"short-private\"}}"}}),
            serde_json::json!({"extraBody":{"provider_options":[{"Cookie":"short-private"}]}}),
        ] {
            let mut value = serde_json::json!({"version":1,"task":"prepare","model":{"baseUrl":"https://example.org/v1","model":"local"}});
            for (name, item) in extension.as_object().unwrap() {
                value["model"][name] = item.clone();
            }
            assert!(Config::parse(&value.to_string()).is_err(), "{extension}");
        }
        let mut encoded = serde_json::json!({"format":"engineering"});
        for _ in 0..10 {
            encoded = Value::String(encoded.to_string());
        }
        assert!(unsafe_provider_value(&encoded));
        assert!(!unsafe_provider_value(
            &serde_json::json!({"format":"{\"style\":\"engineering\"}"})
        ));
    }
    fn config() -> Config {
        Config::parse(r#"{"version":1,"task":"prepare","model":{"baseUrl":"https://example.org/v1","model":"local"}}"#).unwrap()
    }
    #[test]
    fn custom_options_and_credentials() {
        let config = Config::parse(r#"{"version":1,"task":"prepare","systemPrompt":"Work carefully.","model":{"baseUrl":"https://example.org/v2","endpointPath":"custom/completions","model":"custom-model","auth":"header","apiKeyHeader":"x-api-key","headersEnv":{"x-session-token":"CUSTOM_SESSION"},"headers":{"x-project":"test"},"stream":true,"showThinking":true,"maxTokens":32768,"temperature":0.5,"topP":0.8,"reasoningEffort":"max","thinking":{"type":"enabled"},"extraBody":{"parallel_tool_calls":false}},"context":{"contextWindowTokens":10000,"compactThresholdTokens":8000,"compactRetainTokens":2000},"tools":{"profile":"dsh","environment":{"PROJECT_MODE":"test"}}}"#).unwrap();
        assert_eq!(config.endpoint().unwrap().path(), "/v2/custom/completions");
        assert_eq!(
            config.credential_env_names(),
            vec!["COGNIA_BOOTSTRAP_API_KEY", "CUSTOM_SESSION"]
        );
        assert_eq!(config.context.threshold_tokens(), 8000);
        assert_eq!(config.tools.profile, ToolProfile::Dsh);
    }
    #[test]
    fn rejects_unsafe_options_and_overflow_without_panicking() {
        for extra in [
            json_for_test("extraBody", serde_json::json!({"messages":[]})),
            json_for_test("headers", serde_json::json!({"Authorization":"secret"})),
            json_for_test("headers", serde_json::json!({"Host":"other.example"})),
            json_for_test("endpointPath", serde_json::json!("../other")),
            json_for_test("temperature", serde_json::json!(3)),
        ] {
            assert!(Config::parse(&extra).is_err());
        }
        let mut config = config();
        config.context.prune_head_bytes = usize::MAX;
        config.context.prune_tail_bytes = 10;
        assert_eq!(config.validate(), Err("invalid-context-options"));
        config = self::config();
        config
            .tools
            .environment
            .insert("BASH_ENV".into(), "script".into());
        assert_eq!(config.validate(), Err("invalid-tool-options"));
    }
    fn json_for_test(name: &str, value: Value) -> String {
        let mut config = serde_json::to_value(config()).unwrap();
        config["model"][name] = value;
        config.to_string()
    }
    #[test]
    fn accepts_preassembled_endpoint_and_authless_local_model() {
        let mut config = config();
        config.model.base_url = "https://example.org/v1/chat/completions/".into();
        config.model.auth = Auth::None;
        assert_eq!(config.endpoint().unwrap().path(), "/v1/chat/completions");
        assert!(config.credential_env_names().is_empty());
        config.model.api_key_env = "LOCAL_AUTH".into();
        config
            .tools
            .environment
            .insert("LOCAL_AUTH".into(), "inline".into());
        assert_eq!(config.validate(), Err("invalid-tool-options"));
    }
    #[test]
    fn defaults_and_endpoint() {
        let c = config();
        assert_eq!(c.limits.max_steps, 32);
        assert_eq!(c.endpoint().unwrap().path(), "/v1/chat/completions");
    }
    #[test]
    fn rejects_unknown_fields_and_unsafe_urls() {
        assert!(Config::parse(
            r#"{"version":1,"task":"x","model":{"baseUrl":"https://a","model":"m"},"apiKey":"bad"}"#
        )
        .is_err());
        for u in [
            "http://example.org",
            "https://u:p@example.org",
            "https://example.org/?key=x",
            "https://example.org/#x",
        ] {
            let mut c = config();
            c.model.base_url = u.into();
            assert!(c.validate().is_err());
        }
        for u in ["http://127.0.0.1:1234/v1", "http://[::1]:1234/v1"] {
            let mut c = config();
            c.model.base_url = u.into();
            assert!(c.validate().is_ok());
        }
    }
    #[test]
    fn rejects_duplicate_checks_and_parent_paths() {
        let mut c = config();
        c.checks = vec![
            Check {
                name: "x".into(),
                command: "true".into()
            };
            2
        ];
        assert!(c.validate().is_err());
        assert!(!relative_path("a/../b"));
        assert!(!relative_path("/a"));
    }
}
