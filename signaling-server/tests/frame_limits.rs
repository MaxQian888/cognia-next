//! Abuse-protection integration tests: the per-connection rate limiter and
//! the per-frame size cap (ADR-0021 §"Rate limiting & frame caps").

use cognia_signaling_server::{
    proto::{ClientFrame, ServerFrame},
    serve_for_test,
};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    tungstenite::protocol::Message as TgMessage, MaybeTlsStream, WebSocketStream,
};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(addr: std::net::SocketAddr) -> WsClient {
    let url = format!("ws://{}/v1/signaling", addr);
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws
}

async fn send(client: &mut WsClient, frame: ClientFrame) {
    let text = serde_json::to_string(&frame).unwrap();
    client.send(TgMessage::Text(text)).await.unwrap();
}

async fn recv(client: &mut WsClient) -> ServerFrame {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(2), client.next())
            .await
            .expect("ws recv timed out")
            .expect("ws recv stream closed")
            .expect("ws recv error");
        if let TgMessage::Text(text) = msg {
            return serde_json::from_str(text.as_str()).expect("server frame parse");
        }
    }
}

#[tokio::test]
async fn oversized_frame_is_rejected_but_connection_survives() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;

    // ~9 KiB sits above the 8 KiB soft cap but below the 64 KiB hard cap, so
    // the server replies with a graceful error instead of closing the socket.
    let big = "x".repeat(9 * 1024);
    client.send(TgMessage::Text(big)).await.unwrap();
    match recv(&mut client).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "frame_too_large"),
        other => panic!("expected frame_too_large, got {other:?}"),
    }

    // The connection is still usable after the rejection.
    send(&mut client, ClientFrame::Ping).await;
    assert!(matches!(recv(&mut client).await, ServerFrame::Pong));
}

#[tokio::test]
async fn rate_limit_burst_triggers_error() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;

    // Token bucket: capacity 20, refill 10/s. Fire 40 pings back-to-back so
    // the bucket is guaranteed to drain before it can refill meaningfully.
    for _ in 0..40 {
        send(&mut client, ClientFrame::Ping).await;
    }

    // We must eventually see a `rate_limited` error among the replies; the
    // server sends it and then closes the socket.
    let mut saw_rate_limited = false;
    for _ in 0..40 {
        match recv(&mut client).await {
            ServerFrame::Pong => continue,
            ServerFrame::Error { code, .. } => {
                assert_eq!(code, "rate_limited");
                saw_rate_limited = true;
                break;
            }
            other => panic!("unexpected frame {other:?}"),
        }
    }
    assert!(
        saw_rate_limited,
        "expected a rate_limited error within the burst"
    );
}
