#!/usr/bin/env python3
"""Dev server for Runout v0.

Serves the app with the COOP/COEP headers required for cross-origin isolation,
which is what unlocks SharedArrayBuffer — the lock-free control channel and the
shared PCM buffer the audio worklet reads (spec §3). Without these headers the
app still runs, but falls back to the slower postMessage path, which is NOT the
path the §3 latency gate should be measured on.

    python3 serve.py [port]      # default 8000, then open http://localhost:8000
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Cross-origin isolation → SharedArrayBuffer available.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # No caching while iterating on feel.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".js"):
            return "text/javascript"
        return super().guess_type(path)


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Runout v0 → http://localhost:{PORT}  (cross-origin isolated)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
