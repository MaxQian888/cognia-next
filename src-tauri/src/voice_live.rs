//! Native handshake policy for China-region live voice providers.
//!
//! The renderer supplies only validated deployment metadata and a preallocated
//! socket handle. Credentials stay in the host keyring and this module permits
//! only fixed official endpoints and headers before delegating the connection
//! to the shared proxy-aware connector WebSocket client.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;

const QWEN_DEFAULT_MODEL: &str = "qwen-audio-3.0-realtime-plus";
const DOUBAO_ENDPOINT: &str = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
const DOUBAO_RESOURCE_ID: &str = "volc.speech.dialog";
const DOUBAO_APP_KEY: &str = "PlgvMymc7f3tQnJ6";
const BAIDU_DEFAULT_MODEL: &str = "audio-realtime-near";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceLiveDeployment {
    pub workspace_id: Option<String>,
    pub app_id: Option<String>,
    pub model: Option<String>,
    pub voice: Option<String>,
}

struct VoiceLiveRoute {
    url: String,
    headers: HashMap<String, String>,
}

fn validate_native_provider(provider: &str) -> Result<(), String> {
    match provider {
        "qwen" | "doubao" | "baidu" => Ok(()),
        _ => Err("unsupported native live voice provider".into()),
    }
}

fn validated_identifier<'a>(label: &str, value: &'a str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("invalid {label}"));
    }
    Ok(value)
}

fn required_metadata<'a>(label: &str, value: &'a Option<String>) -> Result<&'a str, String> {
    value
        .as_deref()
        .ok_or_else(|| format!("{label} is required"))
        .and_then(|value| validated_identifier(label, value))
}

fn build_voice_live_route(
    provider: &str,
    deployment: &VoiceLiveDeployment,
    credential: &str,
    connect_id: &str,
) -> Result<VoiceLiveRoute, String> {
    let credential = credential.trim();
    if credential.is_empty() {
        return Err(format!("{provider} credential is not configured"));
    }

    match provider {
        "qwen" => {
            let workspace_id = required_metadata("workspaceId", &deployment.workspace_id)?;
            let model = validated_identifier(
                "model",
                deployment.model.as_deref().unwrap_or(QWEN_DEFAULT_MODEL),
            )?;
            let mut url = url::Url::parse(&format!(
                "wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime"
            ))
            .map_err(|error| format!("invalid Qwen endpoint: {error}"))?;
            url.query_pairs_mut().append_pair("model", model);
            Ok(VoiceLiveRoute {
                url: url.into(),
                headers: HashMap::from([("Authorization".into(), format!("Bearer {credential}"))]),
            })
        }
        "doubao" => {
            let app_id = required_metadata("appId", &deployment.app_id)?;
            let connect_id = validated_identifier("handleId", connect_id)?;
            Ok(VoiceLiveRoute {
                url: DOUBAO_ENDPOINT.into(),
                headers: HashMap::from([
                    ("X-Api-App-ID".into(), app_id.into()),
                    ("X-Api-Access-Key".into(), credential.into()),
                    ("X-Api-Resource-Id".into(), DOUBAO_RESOURCE_ID.into()),
                    ("X-Api-App-Key".into(), DOUBAO_APP_KEY.into()),
                    ("X-Api-Connect-Id".into(), connect_id.into()),
                ]),
            })
        }
        "baidu" => {
            let model = validated_identifier(
                "model",
                deployment.model.as_deref().unwrap_or(BAIDU_DEFAULT_MODEL),
            )?;
            let mut url = url::Url::parse("wss://aip.baidubce.com/ws/2.0/speech/v1/realtime")
                .map_err(|error| format!("invalid Baidu endpoint: {error}"))?;
            url.query_pairs_mut().append_pair("model", model);
            Ok(VoiceLiveRoute {
                url: url.into(),
                headers: HashMap::from([("Authorization".into(), format!("Bearer {credential}"))]),
            })
        }
        _ => Err("unsupported native live voice provider".into()),
    }
}

#[tauri::command]
pub async fn voice_live_ws_open(
    app: tauri::AppHandle,
    provider: String,
    deployment: VoiceLiveDeployment,
    handle_id: String,
) -> Result<String, String> {
    validate_native_provider(&provider)?;
    uuid::Uuid::parse_str(&handle_id).map_err(|_| "handleId must be a UUID".to_string())?;
    let credential = crate::tts::keyring::get_provider_key(&provider)?
        .ok_or_else(|| format!("{provider} credential is not configured"))?;
    let route = build_voice_live_route(&provider, &deployment, &credential, &handle_id)?;
    let emitter = Arc::new(crate::connectors::axum_app::AppHandleEmitter(app));
    crate::connectors::ws_client::open_ws_with_handle(
        emitter,
        route.url,
        Some(route.headers),
        handle_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deployment() -> VoiceLiveDeployment {
        VoiceLiveDeployment {
            workspace_id: None,
            app_id: None,
            model: None,
            voice: None,
        }
    }

    #[test]
    fn qwen_uses_only_the_beijing_workspace_endpoint() {
        let route = build_voice_live_route(
            "qwen",
            &VoiceLiveDeployment {
                workspace_id: Some("workspace-1".into()),
                ..deployment()
            },
            "dashscope-secret",
            "00000000-0000-4000-8000-000000000001",
        )
        .unwrap();

        assert_eq!(
            route.url,
            "wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus"
        );
        assert_eq!(route.headers["Authorization"], "Bearer dashscope-secret");
    }

    #[test]
    fn doubao_uses_fixed_protocol_headers_and_only_the_access_key_secret() {
        let route = build_voice_live_route(
            "doubao",
            &VoiceLiveDeployment {
                app_id: Some("app-1".into()),
                ..deployment()
            },
            "access-secret",
            "00000000-0000-4000-8000-000000000002",
        )
        .unwrap();

        assert_eq!(route.url, DOUBAO_ENDPOINT);
        assert_eq!(route.headers["X-Api-App-ID"], "app-1");
        assert_eq!(route.headers["X-Api-Access-Key"], "access-secret");
        assert_eq!(route.headers["X-Api-Resource-Id"], DOUBAO_RESOURCE_ID);
        assert_eq!(route.headers["X-Api-App-Key"], DOUBAO_APP_KEY);
    }

    #[test]
    fn baidu_uses_bearer_auth_and_provider_default_model() {
        let route = build_voice_live_route(
            "baidu",
            &deployment(),
            "baidu-secret",
            "00000000-0000-4000-8000-000000000003",
        )
        .unwrap();

        assert_eq!(
            route.url,
            "wss://aip.baidubce.com/ws/2.0/speech/v1/realtime?model=audio-realtime-near"
        );
        assert_eq!(route.headers["Authorization"], "Bearer baidu-secret");
    }

    #[test]
    fn rejects_missing_secrets_metadata_and_unofficial_targets() {
        assert!(validate_native_provider("custom").is_err());
        assert!(build_voice_live_route("baidu", &deployment(), "", "id")
            .err()
            .unwrap()
            .contains("not configured"));
        assert!(
            build_voice_live_route("qwen", &deployment(), "secret", "id")
                .err()
                .unwrap()
                .contains("workspaceId")
        );
        assert!(
            build_voice_live_route("custom", &deployment(), "secret", "id")
                .err()
                .unwrap()
                .contains("unsupported")
        );
    }

    #[test]
    fn rejects_endpoint_injection_through_non_secret_fields() {
        let malicious = VoiceLiveDeployment {
            workspace_id: Some("evil.example.com/path".into()),
            model: Some("model?redirect=wss://evil.example".into()),
            ..deployment()
        };
        assert!(build_voice_live_route("qwen", &malicious, "secret", "id").is_err());
    }
}
