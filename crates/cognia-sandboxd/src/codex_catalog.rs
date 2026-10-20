//! Assemble task-owned Codex catalogs without carrying prompts in the payload.
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::OnceLock};

const INVALID: &str = "Invalid gateway task configuration";
const VENDORED: &str =
    include_str!("../../../cli/src/runtime/external/codex-catalog/codex-catalog.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexCatalogRequest {
    models: Vec<CodexCatalogRequestModel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexCatalogRequestModel {
    slug: String,
    #[serde(default, deserialize_with = "present_option")]
    context_window: Option<u64>,
    #[serde(default, deserialize_with = "present_option")]
    auto_compact_token_limit: Option<u64>,
    input_modalities: Vec<String>,
    #[serde(default, deserialize_with = "present_option")]
    reasoning_efforts: Option<Vec<String>>,
}

// Missing optional keys are allowed; explicitly null values are not requests.
pub(crate) fn present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl CodexCatalogRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let mut slugs = HashSet::new();
        if self.models.is_empty() || self.models.len() > 32 {
            return Err(INVALID.into());
        }
        for model in &self.models {
            let length = model.slug.chars().count();
            if !(1..=256).contains(&length)
                || model.slug.chars().any(char::is_control)
                || !slugs.insert(&model.slug)
                || [model.context_window, model.auto_compact_token_limit]
                    .into_iter()
                    .flatten()
                    .any(|n| !(1..=10_000_000).contains(&n))
                || model.input_modalities.is_empty()
                || model
                    .input_modalities
                    .iter()
                    .any(|m| m != "text" && m != "image")
                || model.reasoning_efforts.as_ref().is_some_and(|efforts| {
                    efforts.len() > 16
                        || efforts.iter().any(|effort| {
                            !(1..=32).contains(&effort.len())
                                || !effort.as_bytes()[0].is_ascii_lowercase()
                                || !effort.bytes().all(|b| {
                                    b.is_ascii_lowercase()
                                        || b.is_ascii_digit()
                                        || b == b'_'
                                        || b == b'-'
                                })
                        })
                })
            {
                return Err(INVALID.into());
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VendoredCatalog {
    fallback_instructions: String,
    models: Vec<Value>,
}

fn fallback_model(slug: &str, instructions: &str) -> Value {
    json!({
        "slug": slug, "display_name": slug, "description": null, "default_reasoning_level": null,
        "supported_reasoning_levels": [], "shell_type": "unified_exec", "visibility": "none",
        "supported_in_api": true, "priority": 99, "additional_speed_tiers": [], "service_tiers": [],
        "model_messages": { "instructions_template": instructions },
        "include_skills_usage_instructions": false, "include_plugin_usage_instructions": false,
        "include_apps_usage_instructions": false, "supports_reasoning_summary_parameter": true,
        "default_reasoning_summary": "auto", "support_verbosity": false, "apply_patch_tool_type": null,
        "web_search_tool_type": "text", "truncation_policy": { "mode": "bytes", "limit": 10000 },
        "supports_image_detail_original": false, "context_window": 272000, "max_context_window": 272000,
        "auto_compact_token_limit": null, "effective_context_window_percent": 95,
        "experimental_supported_tools": [], "input_modalities": ["text", "image"],
        "supports_search_tool": false, "supports_experimental_context": false, "use_responses_lite": false,
        "supports_reasoning_effort_updates": false, "node_repl_auto_review_required": false,
        "node_repl_disabled": false, "multi_agent_version": null, "multi_agent_reasoning_effort": null
    })
}

pub(crate) fn build_codex_model_catalog(request: &CodexCatalogRequest) -> Result<String, String> {
    request.validate()?;
    static CATALOG: OnceLock<Result<VendoredCatalog, String>> = OnceLock::new();
    let vendored = CATALOG
        .get_or_init(|| serde_json::from_str(VENDORED).map_err(|_| INVALID.to_string()))
        .as_ref()
        .map_err(Clone::clone)?;
    let models: Vec<Value> = request
        .models
        .iter()
        .map(|entry| {
            let bundled = vendored
                .models
                .iter()
                .find(|m| m["slug"].as_str() == Some(&entry.slug));
            let mut model = bundled
                .cloned()
                .unwrap_or_else(|| fallback_model(&entry.slug, &vendored.fallback_instructions));
            if let Some(window) = entry.context_window {
                model["context_window"] = json!(window);
                if bundled.is_none()
                    || model["max_context_window"]
                        .as_u64()
                        .is_some_and(|n| n < window)
                {
                    model["max_context_window"] = json!(window);
                }
            }
            if let Some(limit) = entry.auto_compact_token_limit {
                model["auto_compact_token_limit"] = json!(limit);
            }
            let level = |effort: &String| {
                let description = vendored
                    .models
                    .iter()
                    .filter_map(|m| m["supported_reasoning_levels"].as_array())
                    .flatten()
                    .find(|level| level["effort"].as_str() == Some(effort))
                    .and_then(|level| level["description"].as_str())
                    .unwrap_or(effort);
                json!({"effort": effort, "description": description})
            };
            let efforts = entry.reasoning_efforts.iter().flatten();
            if bundled.is_none() {
                model["input_modalities"] = json!(entry.input_modalities);
                model["supported_reasoning_levels"] = json!(efforts.map(level).collect::<Vec<_>>());
            } else if let Some(own) = model["supported_reasoning_levels"].as_array_mut() {
                // Codex validates a child's effort against these levels; keep the
                // bundled ones and add what the routed provider accepts.
                let known: HashSet<String> = own
                    .iter()
                    .filter_map(|l| l["effort"].as_str().map(str::to_owned))
                    .collect();
                own.extend(efforts.filter(|effort| !known.contains(*effort)).map(level));
            }
            model
        })
        .collect();
    serde_json::to_string_pretty(&json!({ "models": models }))
        .map(|output| output + "\n")
        .map_err(|_| INVALID.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(value: Value) -> Result<String, String> {
        let request = serde_json::from_value(value).map_err(|_| INVALID.to_string())?;
        build_codex_model_catalog(&request)
    }

    #[test]
    fn codex_catalog_accepts_request_bounds() {
        let models: Vec<_> = (0..32)
            .map(|i| {
                json!({
                    "slug": "😀".repeat(254) + &i.to_string(),
                    "contextWindow": 10_000_000, "autoCompactTokenLimit": 1,
                    "inputModalities": ["text"],
                    "reasoningEfforts": (0..16).map(|n| format!("effort_{n}")).collect::<Vec<_>>()
                })
            })
            .collect();
        let output: Value =
            serde_json::from_str(&build(json!({"models":models})).unwrap()).unwrap();
        assert_eq!(output["models"].as_array().unwrap().len(), 32);
        assert_eq!(output["models"][31]["max_context_window"], 10_000_000);
        assert_eq!(output["models"][31]["auto_compact_token_limit"], 1);
        assert_eq!(
            output["models"][31]["supported_reasoning_levels"]
                .as_array()
                .unwrap()
                .len(),
            16
        );
    }

    #[test]
    fn codex_catalog_matches_shared_golden_values() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../cli/src/runtime/external/codex-catalog/fixtures/catalog.json"
        ))
        .unwrap();
        let output = build(fixture["request"].clone()).unwrap();
        // serde_json without preserve_order sorts keys; keep the shared semantic golden.
        let actual: Value = serde_json::from_str(&output).unwrap();
        let expected: Value =
            serde_json::from_str(fixture["expectedOutput"].as_str().unwrap()).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(
            output,
            serde_json::to_string_pretty(&actual).unwrap() + "\n"
        );
    }

    #[test]
    fn codex_catalog_rejects_invalid_requests() {
        let model = json!({"slug":"custom","inputModalities":["text"]});
        let mut invalid = vec![
            Value::Null,
            json!({}),
            json!({"models":[]}),
            json!({"models":vec![model.clone(); 33]}),
            json!({"models":[model.clone(),model.clone()]}),
            json!({"models":[model.clone()],"extra":true}),
        ];
        for (key, values) in [
            (
                "slug",
                vec![
                    json!(""),
                    json!("x".repeat(257)),
                    json!("a\nb"),
                    json!("a\u{7f}b"),
                    json!("a\u{85}b"),
                ],
            ),
            (
                "inputModalities",
                vec![json!([]), json!(["audio"]), Value::Null, json!("text")],
            ),
            (
                "reasoningEfforts",
                vec![
                    json!(["High"]),
                    json!(["a".repeat(33)]),
                    json!(["a b"]),
                    json!(vec!["low"; 17]),
                    Value::Null,
                ],
            ),
            (
                "contextWindow",
                vec![
                    json!(0),
                    json!(-1),
                    json!(1.5),
                    json!(10000001),
                    Value::Null,
                    json!("10"),
                ],
            ),
            (
                "autoCompactTokenLimit",
                vec![
                    json!(0),
                    json!(-1),
                    json!(1.5),
                    json!(10000001),
                    Value::Null,
                    json!("10"),
                ],
            ),
            ("extra", vec![json!(true)]),
        ] {
            for value in values {
                let mut entry = model.clone();
                entry[key] = value;
                invalid.push(json!({"models":[entry]}));
            }
        }
        for value in invalid {
            assert_eq!(build(value.clone()).unwrap_err(), INVALID, "{value}");
        }
    }

    #[test]
    fn codex_catalog_keeps_bundled_metadata_and_overrides_fallbacks() {
        let vendored: VendoredCatalog = serde_json::from_str(VENDORED).unwrap();
        let bundled = vendored
            .models
            .iter()
            .find(|m| m["slug"] == "gpt-6-luna")
            .unwrap();
        for window in [100000, 1000000] {
            let output: Value = serde_json::from_str(&build(json!({"models":[{
                "slug":"gpt-6-luna", "contextWindow": window, "autoCompactTokenLimit": 1234,
                "inputModalities":["text"], "reasoningEfforts":["unlisted"]
            }, {"slug":"GPT-6-LUNA","contextWindow":64000,"inputModalities":["text"],"reasoningEfforts":["low","unlisted"]}]})).unwrap()).unwrap();
            let mut expected = bundled.clone();
            expected["context_window"] = json!(window);
            expected["auto_compact_token_limit"] = json!(1234);
            if window > expected["max_context_window"].as_u64().unwrap() {
                expected["max_context_window"] = json!(window);
            }
            expected["supported_reasoning_levels"]
                .as_array_mut()
                .unwrap()
                .push(json!({"effort": "unlisted", "description": "unlisted"}));
            assert_eq!(output["models"][0], expected);
            let custom = &output["models"][1];
            assert_eq!(custom["max_context_window"], 64000);
            assert_eq!(custom["input_modalities"], json!(["text"]));
            assert_eq!(
                custom["supported_reasoning_levels"][1],
                json!({"effort":"unlisted","description":"unlisted"})
            );
            assert_eq!(
                custom["model_messages"]["instructions_template"],
                vendored.fallback_instructions
            );
        }
    }
    #[test]
    fn codex_catalog_adds_routed_efforts_after_a_bundled_entrys_own() {
        let output = build(json!({"models": [{
            "slug": "gpt-5.5", "inputModalities": ["text"], "reasoningEfforts": ["minimal", "high"]
        }]}))
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        let efforts: Vec<_> = parsed["models"][0]["supported_reasoning_levels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|level| level["effort"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(efforts, ["low", "medium", "high", "xhigh", "minimal"]);
    }
}
