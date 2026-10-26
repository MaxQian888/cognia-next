// Current CC Switch provider formats. App syntax changes belong here.

use crate::types::CcswitchProvider;

/// Read a non-empty string field off a JSON object, trying `keys` in order.
pub(crate) fn json_pick(obj: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| {
        obj.get(*k)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    })
}

/// Decode the current per-app settings_config shapes. No credential lookup or execution.
pub(crate) fn enrich_from_settings_config(p: &mut CcswitchProvider, v: &serde_json::Value) {
    if let Some(env) = v.get("env").filter(|e| e.is_object()) {
        if p.api_key.is_none() {
            p.api_key = json_pick(
                env,
                &[
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "OPENROUTER_API_KEY",
                ],
            );
        }
        if p.base_url.is_none() {
            p.base_url = json_pick(env, &["ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL"]);
        }
        if p.model.is_none() {
            p.model = json_pick(env, &["ANTHROPIC_MODEL", "GEMINI_MODEL"]);
        }
        // Per-tier alias → concrete model mappings + the background model. A
        // relay that fronts Kimi/GLM/etc. declares these so `claude` resolves
        // its opus/sonnet/haiku aliases; we surface them as the provider's
        // real, selectable model list.
        if p.opus_model.is_none() {
            p.opus_model = json_pick(env, &["ANTHROPIC_DEFAULT_OPUS_MODEL"]);
        }
        if p.sonnet_model.is_none() {
            p.sonnet_model = json_pick(env, &["ANTHROPIC_DEFAULT_SONNET_MODEL"]);
        }
        if p.haiku_model.is_none() {
            p.haiku_model = json_pick(env, &["ANTHROPIC_DEFAULT_HAIKU_MODEL"]);
        }
        if p.small_fast_model.is_none() {
            p.small_fast_model = json_pick(env, &["ANTHROPIC_SMALL_FAST_MODEL"]);
        }
        merge_custom_headers(p, env);
    }

    if let Some(auth) = v.get("auth").filter(|a| a.is_object()) {
        if p.api_key.is_none() {
            p.api_key = json_pick(auth, &["OPENAI_API_KEY"]);
        }
    }
    // Codex stores model/base_url in a config.toml string next to `auth`.
    if let Some(config) = v.get("config").and_then(serde_json::Value::as_str) {
        enrich_from_codex_toml(p, config);
    }

    if let Some(options) = v.get("options").filter(|o| o.is_object()) {
        if p.api_key.is_none() {
            p.api_key = json_pick(options, &["apiKey"]);
        }
        if p.base_url.is_none() {
            p.base_url = json_pick(options, &["baseURL", "baseUrl"]);
        }
    }
    match p.kind.as_deref() {
        Some("agy") => {
            p.model = v
                .pointer("/config/model/name")
                .and_then(|x| x.as_str())
                .map(String::from)
                .or(p.model.take());
        }
        Some("hermes") => {
            p.api_key = json_pick(v, &["api_key"]);
            p.base_url = json_pick(v, &["base_url"]);
            p.model = v
                .pointer("/models/0/id")
                .and_then(|x| x.as_str())
                .map(String::from);
        }
        Some("openclaw" | "pi") => {
            p.api_key = json_pick(v, &["apiKey"]);
            p.base_url = json_pick(v, &["baseUrl"]);
            p.model = v
                .get("models")
                .and_then(|x| x.as_array())
                .and_then(|x| x.first())
                .and_then(|x| json_pick(x, &["id"]));
            if p.base_url.is_none() {
                p.base_url = v
                    .get("models")
                    .and_then(|x| x.as_array())
                    .and_then(|models| {
                        models
                            .iter()
                            .find_map(|model| json_pick(model, &["baseUrl"]))
                    });
            }
        }
        Some("opencode" | "mcode") => {
            let settings = v.get("settings").or_else(|| v.get("options"));
            if let Some(settings) = settings {
                p.api_key = json_pick(settings, &["apiKey"]);
                p.base_url = json_pick(settings, &["baseURL"]);
            }
            p.models = v
                .get("models")
                .and_then(|x| x.as_object())
                .map(|models| {
                    models
                        .iter()
                        .map(|(alias, model)| {
                            json_pick(model, &["modelID"]).unwrap_or_else(|| alias.clone())
                        })
                        .collect()
                })
                .unwrap_or_default();
            p.model = p.models.first().cloned();
        }
        Some("grokbuild") => {
            if let Some(doc) = v
                .get("config")
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse::<toml_edit::DocumentMut>().ok())
            {
                let selected = doc
                    .get("models")
                    .and_then(|x| x.get("default"))
                    .and_then(|x| x.as_str());
                if let Some(entry) =
                    selected.and_then(|name| doc.get("model").and_then(|x| x.get(name)))
                {
                    let field = |name: &str| {
                        entry
                            .get(name)
                            .and_then(|x| x.as_str())
                            .map(str::trim)
                            .filter(|x| !x.is_empty())
                            .map(String::from)
                    };
                    p.api_key = field("api_key");
                    p.credential_env = field("env_key");
                    p.base_url = field("base_url");
                    p.model = field("model");
                }
            }
        }
        _ => {}
    }
}

/// Parse forwardable custom headers out of a claude `env` block. Two sources,
/// merged (existing entries win, names de-duplicated verbatim):
///   - `ANTHROPIC_CUSTOM_HEADERS`: newline-separated `Name: Value` pairs — the
///     exact shape `claude` accepts in `~/.claude/settings.json`. Only the
///     first `:` splits, so header values may themselves contain colons/commas.
///   - `ANTHROPIC_BETA`: comma-separated beta flags, folded into one
///     `anthropic-beta` header.
///
/// The dominant payload here is `anthropic-beta: context-1m-2025-08-07`, which
/// downstream turns into the 1M context-window capability.
fn merge_custom_headers(p: &mut CcswitchProvider, env: &serde_json::Value) {
    let mut headers = p.custom_headers.take().unwrap_or_default();

    if let Some(raw) = json_pick(env, &["ANTHROPIC_CUSTOM_HEADERS"]) {
        for line in raw.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim();
                let value = value.trim();
                if !name.is_empty() && !value.is_empty() {
                    headers
                        .entry(name.to_string())
                        .or_insert_with(|| value.to_string());
                }
            }
        }
    }

    if let Some(beta) = json_pick(env, &["ANTHROPIC_BETA"]) {
        headers
            .entry("anthropic-beta".to_string())
            .or_insert_with(|| beta);
    }

    if !headers.is_empty() {
        p.custom_headers = Some(headers);
    }
}

/// Pull `model` (top-level) and `base_url` (from the `[model_providers.<id>]`
/// table named by `model_provider`, falling back to the first entry) out of a
/// codex config.toml string.
fn enrich_from_codex_toml(p: &mut CcswitchProvider, raw: &str) {
    let Ok(doc) = raw.parse::<toml_edit::DocumentMut>() else {
        return;
    };
    let non_empty = |s: &str| {
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    };
    let active = doc.get("model_provider").and_then(|i| i.as_str());
    let selected = active.and_then(|id| {
        doc.get("model_providers")
            .and_then(|providers| providers.get(id))
    });
    let selected_str = |name: &str| {
        selected
            .and_then(|provider| provider.get(name))
            .and_then(|i| i.as_str())
            .and_then(non_empty)
    };
    let root_str = |name: &str| doc.get(name).and_then(|i| i.as_str()).and_then(non_empty);
    if p.model.is_none() {
        p.model = root_str("model");
    }
    if p.base_url.is_none() {
        p.base_url = selected_str("base_url").or_else(|| root_str("base_url"));
    }
    if p.api_key.is_none() {
        // Reserved official providers never source a token from a custom table.
        p.api_key = if active.is_some_and(|id| {
            !matches!(
                id,
                "amazon-bedrock" | "amazon-bedrock-runtime" | "openai" | "ollama" | "lmstudio"
            )
        }) {
            selected_str("experimental_bearer_token")
        } else {
            None
        }
        .or_else(|| root_str("experimental_bearer_token"));
    }
}

#[cfg(test)]
mod tests {

    use crate::db::list_providers;
    use rusqlite::Connection;

    fn current_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("schema-v21.sql")).unwrap();
        conn
    }

    fn provider(conn: &Connection, kind: &str, config: serde_json::Value) {
        conn.execute("INSERT INTO providers (id, app_type, name, settings_config) VALUES ('same', ?1, ?1, ?2)", rusqlite::params![kind, config.to_string()]).unwrap();
    }

    #[test]
    fn current_provider_formats_extract_credentials() {
        let conn = current_db();
        let cases = [
            (
                "claude",
                serde_json::json!({"env":{"ANTHROPIC_AUTH_TOKEN":"key","ANTHROPIC_BASE_URL":"https://api.test","ANTHROPIC_MODEL":"model"}}),
            ),
            (
                "claude-desktop",
                serde_json::json!({"env":{"ANTHROPIC_API_KEY":"key","ANTHROPIC_BASE_URL":"https://api.test","ANTHROPIC_MODEL":"model"}}),
            ),
            (
                "codex",
                serde_json::json!({"auth":{"OPENAI_API_KEY":"key"},"config":"model_provider = \"selected\"\nmodel = \"model\"\n[model_providers.selected]\nbase_url = \"https://api.test\""}),
            ),
            (
                "gemini",
                serde_json::json!({"env":{"GEMINI_API_KEY":"key","GOOGLE_GEMINI_BASE_URL":"https://api.test","GEMINI_MODEL":"model"}}),
            ),
            (
                "agy",
                serde_json::json!({"env":{"GEMINI_API_KEY":"key","GOOGLE_GEMINI_BASE_URL":"https://api.test"},"config":{"model":{"name":"model"}}}),
            ),
            (
                "opencode",
                serde_json::json!({"options":{"apiKey":"key","baseURL":"https://api.test"},"models":{"model":{}}}),
            ),
            (
                "mcode",
                serde_json::json!({"options":{"apiKey":"key","baseURL":"https://api.test"},"models":{"model":{}}}),
            ),
            (
                "openclaw",
                serde_json::json!({"apiKey":"key","baseUrl":"https://api.test","models":[{"id":"model"}]}),
            ),
            (
                "hermes",
                serde_json::json!({"api_key":"key","base_url":"https://api.test","models":[{"id":"model"}]}),
            ),
            (
                "pi",
                serde_json::json!({"apiKey":"key","baseUrl":"https://api.test","models":[{"id":"model"}]}),
            ),
            (
                "grokbuild",
                serde_json::json!({"config":"[models]\ndefault = \"custom\"\n[model.custom]\nmodel = \"model\"\nbase_url = \"https://api.test\"\napi_key = \"key\""}),
            ),
        ];
        for (kind, config) in cases {
            provider(&conn, kind, config);
        }
        for row in list_providers(&conn).unwrap() {
            assert_eq!(
                row.api_key.as_deref(),
                Some("key"),
                "{} key",
                row.kind.as_deref().unwrap()
            );
            assert_eq!(
                row.base_url.as_deref(),
                Some("https://api.test"),
                "{} URL",
                row.kind.as_deref().unwrap()
            );
            assert_eq!(
                row.model.as_deref(),
                Some("model"),
                "{} model",
                row.kind.as_deref().unwrap()
            );
        }
    }

    #[test]
    fn codex_does_not_choose_an_unselected_endpoint() {
        let conn = current_db();
        provider(
            &conn,
            "codex",
            serde_json::json!({"config":"model_provider = \"missing\"\n[model_providers.other]\nbase_url = \"https://wrong.test\""}),
        );
        assert!(list_providers(&conn).unwrap()[0].base_url.is_none());
    }

    #[test]
    fn current_metadata_and_tiers_are_preserved() {
        let conn = current_db();
        provider(
            &conn,
            "claude",
            serde_json::json!({"env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"opus-custom", "ANTHROPIC_DEFAULT_SONNET_MODEL":"sonnet-custom", "ANTHROPIC_DEFAULT_HAIKU_MODEL":"haiku-custom", "ANTHROPIC_CUSTOM_HEADERS":"X-Route: a:b\nanthropic-beta: context-1m-2025-08-07"}}),
        );
        conn.execute(
            "UPDATE providers SET meta = ?1",
            [r#"{"providerType":"github_copilot","usage_script":{"templateType":"token_plan"}}"#],
        )
        .unwrap();
        let rows = list_providers(&conn).unwrap();
        assert_eq!(rows[0].provider_type.as_deref(), Some("github_copilot"));
        assert_eq!(rows[0].opus_model.as_deref(), Some("opus-custom"));
        assert_eq!(rows[0].sonnet_model.as_deref(), Some("sonnet-custom"));
        assert_eq!(rows[0].haiku_model.as_deref(), Some("haiku-custom"));
        assert_eq!(rows[0].custom_headers.as_ref().unwrap()["X-Route"], "a:b");
        assert_eq!(
            rows[0].usage_script.as_ref().unwrap()["templateType"],
            "token_plan"
        );
    }

    #[test]
    fn codex_current_top_level_and_bearer_formats_match_selected_provider() {
        let conn = current_db();
        provider(
            &conn,
            "codex",
            serde_json::json!({"config":"base_url = \"https://top.test\"\nmodel_provider = \"selected\"\n[model_providers.selected]\nexperimental_bearer_token = \"selected-key\"\n[model_providers.other]\nexperimental_bearer_token = \"wrong-key\""}),
        );
        let rows = list_providers(&conn).unwrap();
        assert_eq!(rows[0].api_key.as_deref(), Some("selected-key"));
        assert_eq!(rows[0].base_url.as_deref(), Some("https://top.test"));
    }

    #[test]
    fn opencode_v2_pi_model_endpoints_and_environment_credentials_are_explicit() {
        let conn = current_db();
        provider(
            &conn,
            "opencode",
            serde_json::json!({"package":"@ai-sdk/anthropic", "settings":{"apiKey":"v2-key","baseURL":"https://v2.test"},"models":{"alias":{"modelID":"actual-model"}}}),
        );
        provider(
            &conn,
            "pi",
            serde_json::json!({"apiKey":"key", "models":[{"id":"first","baseUrl":" "},{"id":"second","baseUrl":"https://pi.test"}]}),
        );
        provider(
            &conn,
            "grokbuild",
            serde_json::json!({"config":"[models]\ndefault = \"custom\"\n[model.custom]\nmodel = \"grok\"\nbase_url = \"https://grok.test\"\nenv_key = \"PRIVATE_TEST_KEY\""}),
        );
        let rows = list_providers(&conn).unwrap();
        let v2 = rows
            .iter()
            .find(|p| p.kind.as_deref() == Some("opencode"))
            .unwrap();
        assert_eq!(v2.api_key.as_deref(), Some("v2-key"));
        assert_eq!(v2.base_url.as_deref(), Some("https://v2.test"));
        assert_eq!(v2.model.as_deref(), Some("actual-model"));
        let pi = rows
            .iter()
            .find(|p| p.kind.as_deref() == Some("pi"))
            .unwrap();
        assert_eq!(pi.base_url.as_deref(), Some("https://pi.test"));
        assert_eq!(pi.models, ["first", "second"]);
        let grok = rows
            .iter()
            .find(|p| p.kind.as_deref() == Some("grokbuild"))
            .unwrap();
        assert!(grok.api_key.is_none());
        assert_eq!(grok.credential_env.as_deref(), Some("PRIVATE_TEST_KEY"));
    }
}
