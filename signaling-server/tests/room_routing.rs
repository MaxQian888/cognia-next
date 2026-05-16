//! End-to-end smoke test: boot the server on an ephemeral port, open two
//! WS clients, drive a subscribe→relay→leave dance, assert ordering.

use cognia_signaling_server::{
    proto::{ClientFrame, PeerRole, ServerFrame},
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
    client.send(TgMessage::Text(text.into())).await.unwrap();
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
        // Skip control frames (Ping/Pong) which the runtime may surface.
    }
}

#[tokio::test]
async fn two_peers_relay_via_room() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");

    // Desktop subscribes first.
    let mut desktop = connect(addr).await;
    send(
        &mut desktop,
        ClientFrame::Subscribe {
            rendezvous_id: "room-1".into(),
            role: PeerRole::Desktop,
            client_nonce: "nd".into(),
        },
    )
    .await;
    match recv(&mut desktop).await {
        ServerFrame::Subscribed { peers, .. } => assert!(peers.is_empty()),
        other => panic!("expected Subscribed, got {other:?}"),
    }

    // Mobile subscribes second; desktop must observe `peerJoined`.
    let mut mobile = connect(addr).await;
    send(
        &mut mobile,
        ClientFrame::Subscribe {
            rendezvous_id: "room-1".into(),
            role: PeerRole::Mobile,
            client_nonce: "nm".into(),
        },
    )
    .await;
    let mobile_subscribed = recv(&mut mobile).await;
    let desktop_notified = recv(&mut desktop).await;
    match mobile_subscribed {
        ServerFrame::Subscribed { peers, .. } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].role, PeerRole::Desktop);
        }
        other => panic!("expected Subscribed, got {other:?}"),
    }
    match desktop_notified {
        ServerFrame::PeerJoined { role, .. } => assert_eq!(role, PeerRole::Mobile),
        other => panic!("expected PeerJoined, got {other:?}"),
    }

    // Mobile relays. Desktop must observe the relay, mobile must not.
    send(
        &mut mobile,
        ClientFrame::Relay {
            rendezvous_id: "room-1".into(),
            payload: "opaque-base64==".into(),
        },
    )
    .await;
    match recv(&mut desktop).await {
        ServerFrame::Relay {
            from_role, payload, ..
        } => {
            assert_eq!(from_role, PeerRole::Mobile);
            assert_eq!(payload, "opaque-base64==");
        }
        other => panic!("expected Relay, got {other:?}"),
    }

    // Close mobile; desktop must observe peerLeft.
    drop(mobile);
    match recv(&mut desktop).await {
        ServerFrame::PeerLeft { role, .. } => assert_eq!(role, PeerRole::Mobile),
        other => panic!("expected PeerLeft, got {other:?}"),
    }
}

#[tokio::test]
async fn relay_to_unsubscribed_room_errors() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;

    send(
        &mut client,
        ClientFrame::Relay {
            rendezvous_id: "ghost".into(),
            payload: "x".into(),
        },
    )
    .await;
    match recv(&mut client).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "not_subscribed"),
        other => panic!("expected Error, got {other:?}"),
    }
}

#[tokio::test]
async fn ping_round_trips() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;
    send(&mut client, ClientFrame::Ping).await;
    match recv(&mut client).await {
        ServerFrame::Pong => {}
        other => panic!("expected Pong, got {other:?}"),
    }
}

#[tokio::test]
async fn malformed_frame_does_not_disconnect() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;
    client
        .send(TgMessage::Text("not-json".into()))
        .await
        .unwrap();
    match recv(&mut client).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "malformed_frame"),
        other => panic!("expected Error, got {other:?}"),
    }
    // The client is still usable.
    send(&mut client, ClientFrame::Ping).await;
    matches!(recv(&mut client).await, ServerFrame::Pong);
}
