"""Python-backed module-bridge contributions — first-party reference.

Every contribution here is owned by the Python subprocess: the renderer holds
only a proxy whose methods round-trip through `plugin_python_call`
(`lib/plugin/bridge/_shared/python-backed-proxy.ts`). None of these declare a
JS `entry`, which is exactly what marks them python-backed — see
`effectiveContributionBackend` in `lib/plugin/core/validation.ts`.

`describe()` returns the plain-data descriptor a JS factory would have returned
inline; every other public method is behaviour.
"""

import cognia


@cognia.contribution("echo-ocr")
class EchoOcr:
    """`media` capability — pythonExecution: supported."""

    def describe(self):
        return {
            "label": "Echo OCR (Python)",
            "category": "specialist",
            "shells": {"browser": False, "tauri": True, "capacitor": False},
            "credentialKeys": [],
        }

    def extract(self, image_input, ctx=None):
        source = image_input if isinstance(image_input, str) else repr(image_input)
        return {
            "pages": [],
            "providerId": "echo-ocr",
            "combinedMarkdown": "recognized: " + source,
            "combinedText": "recognized: " + source,
            "languages": [],
            "durationMs": 0,
            "cached": False,
        }


@cognia.contribution("echo-llm")
class EchoLlm:
    """`ai-provider` capability — pythonExecution: supported.

    The host reads label/models from the manifest, so the provider only has to
    supply behaviour. Yielding turns `complete` into chunk frames when the
    renderer passes a stream id.
    """

    def complete(self, request=None):
        prompt = ""
        if isinstance(request, dict):
            prompt = str(request.get("prompt", ""))
        for piece in ("echo:", prompt):
            if piece:
                yield piece


@cognia.contribution("memory-workspace")
class MemoryWorkspace:
    """`workspace-backend` capability — pythonExecution: supported."""

    def __init__(self):
        self._handles = {}

    def clone(self, repo_full_name, branch="main", **_kwargs):
        handle = {
            "backend": "memory-workspace",
            "path": "/virtual/" + str(repo_full_name),
            "repoFullName": repo_full_name,
            "branch": branch,
            "createdAt": 0,
        }
        self._handles[handle["path"]] = handle
        return handle

    def commitAndPush(self, handle=None, message="", **_kwargs):
        path = (handle or {}).get("path") if isinstance(handle, dict) else None
        if path not in self._handles:
            raise RuntimeError("unknown workspace handle: %r" % (path,))
        # A real backend would shell out to git; the demo returns a stable sha.
        return "sha-" + str(abs(hash(message)) % 10**7)

    def remove(self, handle=None, **_kwargs):
        path = (handle or {}).get("path") if isinstance(handle, dict) else None
        return self._handles.pop(path, None) is not None


@cognia.contribution("echo-chat")
class EchoConnector:
    """`connectors` capability — pythonExecution: EXPERIMENTAL.

    Bidirectional: the host drives `start`/`stop`/`send`, while inbound events
    travel the other way through `cognia.emit(..., "inbound", ...)`. The
    renderer wrapper owns `health()` (synchronous, so it cannot be an IPC call)
    and forwards each inbound push into the connector bus via `ctx.emit`.

    Gated by `lib/plugin/python/experimental-flag.ts` — OFF by default.
    """

    def describe(self):
        return {
            "meta": {
                "type": "echo-chat",
                "displayName": "Echo Chat (Python)",
                "version": "0.1.0",
                "capabilities": [],
                "transportModes": ["longpoll"],
                "configSchema": {},
            },
            "a2uiCapability": {"mode": "plainTextMirror"},
        }

    def start(self, ctx=None):
        # Demonstrates the inbound half: a real adapter would emit on every
        # platform message; the demo emits one synthetic event on start.
        cognia.emit("echo-chat", "inbound", {"kind": "started", "adapterId": (ctx or {}).get("adapterId")})
        return None

    def stop(self):
        return None

    def send(self, request=None):
        text = ""
        if isinstance(request, dict):
            text = str(request.get("text", ""))
        cognia.emit("echo-chat", "inbound", {"kind": "echo", "text": text})
        return {"ok": True, "messageId": "echo-1"}
