#!/usr/bin/env python3
"""An authenticating reverse proxy in front of a Temporal HTTP API.

`temporal server start-dev` cannot enforce anything. It has no --authorizer,
no --config, and it ignores the TEMPORAL_AUTH_* variables the full distribution
reads: an unauthenticated request and one carrying `Authorization: Bearer
totally-fake` both come back 200. So there is no way to test the plugin's
authentication handling against the test bed's servers directly.

A proxy in front of one is the honest substitute, and it happens to be the
topology this is really for -- self-hosted Temporal behind Cloudflare Access,
an ingress, or an oauth2-proxy. It reproduces exactly the three behaviours the
plugin has to get right:

  * a missing or wrong token           -> 401, {"code": 16, ...}
  * a credential scoped to namespaces  -> 403 on ListNamespaces only, so the
                                          namespace fallback is exercised while
                                          the namespaces themselves still work
  * required proxy headers             -> 403 unless both are present

What it does *not* prove is that Temporal itself answers this way; that comes
from the server's own source, which maps UNAUTHENTICATED to 401 and
PERMISSION_DENIED to 403, and returns google.rpc.Status as {code, message,
details}. The bodies here are shaped to match, including the dev server's
peculiar `Content-Type: *`.

    UPSTREAM=http://localhost:7243 TOKEN=hunter2 python3 testbed/authproxy.py

Env:
    PORT          listen port (default 7253)
    UPSTREAM      where to forward (default http://127.0.0.1:7243)
    TOKEN         the bearer token that is accepted; empty disables the check
    DENY_LIST     "1" to refuse ListNamespaces with 403 (default "1")
    CF_ID         if set, CF-Access-Client-Id must match
    CF_SECRET     if set, CF-Access-Client-Secret must match
"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "7253"))
UPSTREAM = os.environ.get("UPSTREAM", "http://127.0.0.1:7243").rstrip("/")
TOKEN = os.environ.get("TOKEN", "s3cret-token-value")
DENY_LIST = os.environ.get("DENY_LIST", "1") == "1"
CF_ID = os.environ.get("CF_ID", "")
CF_SECRET = os.environ.get("CF_SECRET", "")

# gRPC status codes, as the HTTP API reports them in the body.
UNAUTHENTICATED = 16
PERMISSION_DENIED = 7


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("authproxy: " + (fmt % args) + "\n")

    def deny(self, status, code, message):
        body = json.dumps({"code": code, "message": message}).encode()
        self.send_response(status)
        # The dev server really does send this, and a client that gates JSON
        # parsing on a content type of application/json breaks against it.
        self.send_header("Content-Type", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if CF_ID and self.headers.get("CF-Access-Client-Id") != CF_ID:
            self.deny(403, PERMISSION_DENIED, "Request unauthorized.")
            return
        if CF_SECRET and self.headers.get("CF-Access-Client-Secret") != CF_SECRET:
            self.deny(403, PERMISSION_DENIED, "Request unauthorized.")
            return

        if TOKEN:
            header = self.headers.get("Authorization") or ""
            if header != "Bearer " + TOKEN:
                self.deny(401, UNAUTHENTICATED, "Jwt is missing or invalid")
                return

        # The whole point of the namespace fallback: listing is a cluster-level
        # call and a namespace-scoped credential does not get it, even though
        # every namespace it names reads fine.
        path = self.path.split("?")[0].rstrip("/")
        if DENY_LIST and path in ("/api/v1/namespaces", "/namespaces"):
            self.deny(403, PERMISSION_DENIED,
                      "Request unauthorized. Credential is not permitted to list namespaces.")
            return

        try:
            with urllib.request.urlopen(UPSTREAM + self.path, timeout=15) as upstream:
                body = upstream.read()
                status = upstream.status
        except urllib.error.HTTPError as err:
            body = err.read()
            status = err.code
        except Exception as err:  # upstream down is the proxy's problem to report
            self.deny(502, 14, "upstream unreachable: %s" % err)
            return

        self.send_response(status)
        self.send_header("Content-Type", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("authproxy on :%d -> %s (token %s, deny-list %s, cf %s)"
          % (PORT, UPSTREAM, "set" if TOKEN else "off", DENY_LIST, "on" if CF_ID else "off"),
          flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
