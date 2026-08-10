//! Node helper process boundary for MCP OAuth flows.

use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

use super::{AuthResultOut, McpAuthEntry};

const HELPER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Deserialize)]
pub(super) struct HelperOutput {
    pub(super) result: AuthResultOut,
    #[serde(default)]
    pub(super) entry: Option<McpAuthEntry>,
    #[serde(rename = "authorizationUrl", default)]
    pub(super) authorization_url: Option<String>,
}

pub(super) async fn run_helper_input(
    input: &Value,
    helper_path: &str,
    mode: &str,
) -> Result<HelperOutput, String> {
    run_helper_input_with_timeout(input, helper_path, mode, HELPER_TIMEOUT).await
}

async fn run_helper_input_with_timeout(
    input: &Value,
    helper_path: &str,
    mode: &str,
    timeout: Duration,
) -> Result<HelperOutput, String> {
    tokio::time::timeout(timeout, run_helper_process(input, helper_path, mode))
        .await
        .map_err(|_| format!("oauth helper timed out after {}ms", timeout.as_millis()))?
}

async fn run_helper_process(
    input: &Value,
    helper_path: &str,
    mode: &str,
) -> Result<HelperOutput, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command;

    let mut child = Command::new("node")
        .arg(helper_path)
        .arg(mode)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn oauth helper failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let line = format!("{input}\n");
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write to helper failed: {e}"))?;
        stdin.flush().await.ok();
        drop(stdin);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "helper stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut last_json: Option<HelperOutput> = None;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    if let Ok(parsed) = serde_json::from_str::<HelperOutput>(trimmed) {
                        last_json = Some(parsed);
                    }
                }
            }
            Err(e) => return Err(format!("read from helper failed: {e}")),
        }
    }
    let _ = child.wait().await;

    Ok(last_json.unwrap_or_else(|| HelperOutput {
        result: AuthResultOut {
            ok: false,
            status: "error".into(),
            message: "oauth helper produced no result".into(),
        },
        entry: None,
        authorization_url: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_output_parses_result_entry_and_authorization_url() {
        let out: HelperOutput = serde_json::from_str(
            r#"{"result":{"ok":true,"status":"pending","message":"open"},"entry":{"tokens":{"access_token":"z"}},"authorizationUrl":"https://issuer.example/authorize"}"#,
        )
        .unwrap();
        assert!(out.result.ok);
        assert_eq!(out.entry.unwrap().access_token(), Some("z".to_string()));
        assert_eq!(
            out.authorization_url.as_deref(),
            Some("https://issuer.example/authorize")
        );
    }

    #[tokio::test]
    async fn helper_process_is_killed_when_the_exchange_times_out() {
        let path = std::env::temp_dir().join(format!(
            "cognia-mcp-oauth-timeout-{}.mjs",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            "process.stdin.resume(); setInterval(() => {}, 1000)\n",
        )
        .unwrap();

        let result = run_helper_input_with_timeout(
            &serde_json::json!({}),
            path.to_str().unwrap(),
            "authenticate",
            Duration::from_millis(100),
        )
        .await;

        let _ = std::fs::remove_file(path);
        assert!(result.is_err());
        let error = result.err().unwrap();
        assert!(error.contains("oauth helper timed out"));
    }
}
