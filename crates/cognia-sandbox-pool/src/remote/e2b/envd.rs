//! Shared envd transport; these integration tests retain the code-sandbox contract.
#[allow(unused_imports)]
pub(super) use cognia_e2b::envd::*;

#[cfg(test)]
mod tests {
    use super::super::connect::ConnectError;
    use super::super::test_server::{FakeE2b, ProcessScript, ScriptFrame};
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[tokio::test]
    async fn a_started_process_streams_fragmented_events_as_root() {
        let fake = FakeE2b::start().await;
        let sandbox = fake.add_sandbox("running", BTreeMap::new());
        fake.script(
            "/bin/echo",
            ProcessScript::Fixed {
                frames: vec![
                    ScriptFrame::Keepalive,
                    ScriptFrame::Stdout(b"hello ".to_vec()),
                    ScriptFrame::Stderr(b"warn".to_vec()),
                    ScriptFrame::Stdout(b"world".to_vec()),
                    ScriptFrame::End {
                        code: 0,
                        status: "exit status 0".into(),
                    },
                ],
                chunk: 1,
            },
        );
        let endpoint = fake.envd_endpoint(&sandbox);
        let spec = StartSpec {
            cmd: "/bin/echo".into(),
            args: vec!["hello".into()],
            envs: BTreeMap::from([("A".to_string(), "1".to_string())]),
            cwd: Some("/workspace".into()),
            stdin: false,
        };
        let mut stream = start(&endpoint, &spec).await.unwrap();
        let mut events = Vec::new();
        while let Some(event) = stream.next_event().await.unwrap() {
            events.push(event);
        }
        assert!(matches!(events[0], ProcessEvent::Start { .. }));
        assert_eq!(events[1], ProcessEvent::Keepalive);
        assert_eq!(events[2], ProcessEvent::Stdout(b"hello ".to_vec()));
        assert_eq!(events[3], ProcessEvent::Stderr(b"warn".to_vec()));
        assert_eq!(events[4], ProcessEvent::Stdout(b"world".to_vec()));
        assert!(matches!(&events[5], ProcessEvent::End(end) if end.code() == Some(0)));

        let request = fake.last_request("/process.Process/Start");
        assert_eq!(request.header("authorization"), Some("Basic cm9vdDo="));
        assert_eq!(
            request.header("x-access-token"),
            Some(fake.token(&sandbox).as_str())
        );
        assert_eq!(request.header("e2b-sandbox-id"), Some(sandbox.as_str()));
        assert_eq!(request.header("keepalive-ping-interval"), Some("50"));
        assert_eq!(request.header("connect-timeout-ms"), None);
        assert_eq!(
            request.header("content-type"),
            Some("application/connect+json")
        );
        let body = request.envelope_json();
        assert_eq!(
            body,
            json!({
                "process": {
                    "cmd": "/bin/echo",
                    "args": ["hello"],
                    "envs": { "A": "1" },
                    "cwd": "/workspace",
                },
                "stdin": false,
            })
        );
    }

    #[tokio::test]
    async fn refusals_and_broken_streams_are_errors() {
        let fake = FakeE2b::start().await;
        let sandbox = fake.add_sandbox("running", BTreeMap::new());
        let spec = |cmd: &str| StartSpec {
            cmd: cmd.into(),
            args: Vec::new(),
            envs: BTreeMap::new(),
            cwd: None,
            stdin: true,
        };

        let mut wrong = fake.envd_endpoint(&sandbox);
        wrong.access_token = Some("not-the-token".into());
        let error = start(&wrong, &spec("/bin/true")).await.err().unwrap();
        assert!(matches!(error, EnvdError::Unauthorized(_)), "{error}");

        fake.script(
            "/bad/cwd",
            ProcessScript::Fixed {
                frames: vec![ScriptFrame::EndStreamError {
                    code: "invalid_argument".into(),
                    message: "cwd '/nope' does not exist".into(),
                }],
                chunk: 3,
            },
        );
        let endpoint = fake.envd_endpoint(&sandbox);
        let mut stream = start(&endpoint, &spec("/bad/cwd")).await.unwrap();
        let error = stream.next_event().await.unwrap_err();
        assert_eq!(
            error,
            EnvdError::Rpc(ConnectError {
                code: "invalid_argument".into(),
                message: "cwd '/nope' does not exist".into(),
            })
        );

        fake.script(
            "/cut",
            ProcessScript::Fixed {
                frames: vec![ScriptFrame::Stdout(b"partial".to_vec()), ScriptFrame::Cut],
                chunk: 64,
            },
        );
        let mut stream = start(&endpoint, &spec("/cut")).await.unwrap();
        assert!(matches!(
            stream.next_event().await.unwrap(),
            Some(ProcessEvent::Start { .. })
        ));
        assert_eq!(
            stream.next_event().await.unwrap(),
            Some(ProcessEvent::Stdout(b"partial".to_vec()))
        );
        assert!(matches!(
            stream.next_event().await,
            Err(EnvdError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn input_and_close_reach_the_process_by_pid() {
        let fake = FakeE2b::start().await;
        let sandbox = fake.add_sandbox("running", BTreeMap::new());
        fake.script("/bin/cat", ProcessScript::Echo);
        let endpoint = fake.envd_endpoint(&sandbox);
        let mut stream = start(
            &endpoint,
            &StartSpec {
                cmd: "/bin/cat".into(),
                args: Vec::new(),
                envs: BTreeMap::new(),
                cwd: None,
                stdin: true,
            },
        )
        .await
        .unwrap();
        let Some(ProcessEvent::Start { pid }) = stream.next_event().await.unwrap() else {
            panic!("no start event");
        };
        let input = ProcessInput::new(endpoint.clone(), pid).unwrap();
        input.send(b"ping").await.unwrap();
        assert_eq!(
            stream.next_event().await.unwrap(),
            Some(ProcessEvent::Stdout(b"ping".to_vec()))
        );
        input.close().await.unwrap();
        assert!(matches!(
            stream.next_event().await.unwrap(),
            Some(ProcessEvent::End(end)) if end.code() == Some(0)
        ));
        let request = fake.last_request("/process.Process/SendInput");
        assert_eq!(request.header("authorization"), Some("Basic cm9vdDo="));
        assert_eq!(request.header("connect-protocol-version"), Some("1"));
        assert_eq!(
            request.json(),
            json!({ "process": { "pid": pid }, "input": { "stdin": "cGluZw==" } })
        );

        let error = ProcessInput::new(endpoint, pid + 1000)
            .unwrap()
            .send(b"x")
            .await
            .unwrap_err();
        assert!(
            matches!(&error, EnvdError::Rpc(rpc) if rpc.code == "not_found"),
            "{error}"
        );
    }
}
