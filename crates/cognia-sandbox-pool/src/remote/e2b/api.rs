//! Compatibility surface for the code provider; shared transport lives in cognia-e2b.

pub(super) use cognia_e2b::*;
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;

pub(super) trait SpawnErrorExt {
    fn to_spawn_error(&self, doing: &str) -> SandboxSpawnError;
}
impl SpawnErrorExt for ApiError {
    /// The spawn outcome for a failed call: the account's credentials are an
    /// answer (refused), capacity and reachability are faults, any other
    /// refusal of the request is an answer about the request.
    fn to_spawn_error(&self, doing: &str) -> SandboxSpawnError {
        let message = format!("{doing}: {self}");
        match self {
            Self::Status {
                status: 401 | 403, ..
            } => SandboxSpawnError::refused("sandbox_provider_unauthorized", message),
            Self::Status { status: 429, .. } => {
                SandboxSpawnError::fault("sandbox_provider_capacity", message)
            }
            Self::Status {
                status: 500..=599, ..
            }
            | Self::Transport(_)
            | Self::Invalid(_) => SandboxSpawnError::fault("sandbox_provider_unreachable", message),
            Self::Status { .. } => SandboxSpawnError::refused("sandbox_provider_rejected", message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_server::FakeE2b;
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use url::Url;

    #[test]
    fn metadata_filters_survive_the_servers_three_unescapes() {
        let filter = BTreeMap::from([
            (
                "cognia.owner".to_string(),
                "cognia-external-agent".to_string(),
            ),
            ("odd key=&%".to_string(), "value with spaces+&=".to_string()),
        ]);
        let encoded = metadata_query(&filter);
        assert!(
            encoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~%".contains(&b)),
            "{encoded}"
        );
        // The server: framework unescape (done by the URL layer in the
        // fake), QueryUnescape of the whole value, split, unescape each.
        let decoded = super::super::test_server::parse_metadata_filter(&encoded).unwrap();
        assert_eq!(decoded, filter);
    }

    #[test]
    fn errors_map_to_spawn_outcomes() {
        let status = |status: u16| ApiError::Status {
            status,
            message: "m".into(),
        };
        for (error, kind_refused, code) in [
            (status(401), true, "sandbox_provider_unauthorized"),
            (status(403), true, "sandbox_provider_unauthorized"),
            (status(429), false, "sandbox_provider_capacity"),
            (status(500), false, "sandbox_provider_unreachable"),
            (status(503), false, "sandbox_provider_unreachable"),
            (
                ApiError::Transport("reset".into()),
                false,
                "sandbox_provider_unreachable",
            ),
            (
                ApiError::Invalid("junk".into()),
                false,
                "sandbox_provider_unreachable",
            ),
            (status(400), true, "sandbox_provider_rejected"),
            (status(404), true, "sandbox_provider_rejected"),
        ] {
            let spawn = error.to_spawn_error("creating");
            assert_eq!(spawn.code, code, "{error}");
            assert_eq!(
                spawn.kind
                    == cognia_external_agent::sandbox_routing_backend::SandboxErrorKind::Refused,
                kind_refused,
                "{error}"
            );
            assert!(spawn.message.starts_with("creating: "));
        }
        assert!(status(429).is_transient());
        assert!(status(502).is_transient());
        assert!(!status(400).is_transient());
    }

    #[test]
    fn debug_output_redacts_every_secret() {
        let client = ApiClient::new(Url::parse("https://api.e2b.app").unwrap(), "e2b_key".into());
        assert!(!format!("{client:?}").contains("e2b_key"));
        let created = CreatedSandbox {
            sandbox_id: "i1".into(),
            envd_access_token: Some("envd-secret".into()),
            domain: None,
            ..Default::default()
        };
        assert!(!format!("{created:?}").contains("envd-secret"));
        let upload = FileUpload {
            present: false,
            url: Some("https://s3.example.com/x?X-Amz-Signature=sig".into()),
            headers: None,
        };
        assert!(!format!("{upload:?}").contains("Signature"));
    }

    #[tokio::test]
    async fn every_call_carries_the_key_and_lists_follow_cursors() {
        let fake = FakeE2b::start().await;
        fake.set_page_size(2);
        let owner = BTreeMap::from([("cognia.owner".to_string(), "x".to_string())]);
        for _ in 0..5 {
            fake.add_sandbox("running", owner.clone());
        }
        fake.add_sandbox(
            "running",
            BTreeMap::from([("other".to_string(), "y".to_string())]),
        );
        let api = fake.api();
        let listed = api.list_sandboxes(&owner).await.unwrap();
        assert_eq!(listed.len(), 5);
        let pages = fake.requests_to("/v2/sandboxes");
        assert_eq!(pages.len(), 3);
        assert!(pages
            .iter()
            .all(|request| request.header("x-api-key") == Some(FakeE2b::API_KEY)));
        assert!(pages[1].query.as_deref().unwrap().contains("nextToken="));

        fake.fail_next("/v2/sandboxes", 401, "Invalid API key");
        let error = api.list_sandboxes(&owner).await.unwrap_err();
        assert_eq!(error.status(), Some(401));
        assert!(error.to_string().contains("Invalid API key"));
        assert!(!error.to_string().contains(FakeE2b::API_KEY));
    }

    #[tokio::test]
    async fn missing_sandboxes_are_none_not_errors() {
        let fake = FakeE2b::start().await;
        let api = fake.api();
        assert!(api.get_sandbox("nosuch").await.unwrap().is_none());
        assert!(!api.delete_sandbox("nosuch").await.unwrap());
        assert_eq!(
            api.pause_sandbox("nosuch").await.unwrap(),
            PauseOutcome::Gone
        );
        assert!(api.connect_sandbox("nosuch", 5).await.unwrap().is_none());

        let id = fake.add_sandbox("running", BTreeMap::new());
        let info = api.get_sandbox(&id).await.unwrap().unwrap();
        assert_eq!(info.state, "running");
        assert_eq!(
            info.envd_access_token.as_deref(),
            Some(fake.token(&id).as_str())
        );
        assert_eq!(api.pause_sandbox(&id).await.unwrap(), PauseOutcome::Paused);
        assert_eq!(
            fake.last_request(&format!("/sandboxes/{id}/pause")).json(),
            json!({ "memory": true })
        );
        assert_eq!(
            api.pause_sandbox(&id).await.unwrap(),
            PauseOutcome::Conflict
        );
        let resumed = api.connect_sandbox(&id, 90).await.unwrap().unwrap();
        assert_eq!(resumed.sandbox_id, id);
        assert_eq!(
            fake.last_request(&format!("/v2/sandboxes/{id}/connect"))
                .json(),
            json!({ "timeout": 90 })
        );
        assert!(api.delete_sandbox(&id).await.unwrap());
    }

    #[tokio::test]
    async fn uploads_send_an_exact_length_and_the_returned_headers() {
        let fake = FakeE2b::start().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.tar.gz");
        let bytes = vec![7u8; 300_000];
        std::fs::write(&path, &bytes).unwrap();
        let api = fake.api();
        let url = fake.url("/upload/hash1");
        let headers = BTreeMap::from([
            ("x-amz-meta-test".to_string(), "yes".to_string()),
            ("Content-Length".to_string(), "1".to_string()),
        ]);
        api.upload(url.as_str(), &headers, &path, bytes.len() as u64)
            .await
            .unwrap();
        let upload = fake.last_request("/upload/hash1");
        assert_eq!(upload.method, "PUT");
        assert_eq!(upload.header("content-length"), Some("300000"));
        assert_eq!(upload.header("transfer-encoding"), None);
        assert_eq!(upload.header("x-amz-meta-test"), Some("yes"));
        assert_eq!(
            upload.header("x-api-key"),
            None,
            "the key stays with E2B's API"
        );
        assert_eq!(upload.body.len(), 300_000);

        let error = api
            .upload(
                "https://user:pw@s3.example.com/x",
                &BTreeMap::new(),
                &path,
                1,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ApiError::Invalid(_)));
        let error = api
            .upload("http://s3.example.com/x", &BTreeMap::new(), &path, 1)
            .await
            .unwrap_err();
        assert!(
            matches!(error, ApiError::Invalid(_)),
            "plain http off loopback"
        );
    }
}
