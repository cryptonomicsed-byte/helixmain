#!/usr/bin/env python3
"""Add cache headers to the live helixmain /dashboard nginx block.

The SPA shell (index.html) must be revalidated every load; the content-addressed
assets/* under it can be cached forever. Without this, a rebuild (or a login
credential rotation) leaves the browser running a STALE bundle — the "wrong PIN"
bug of 2026-10-10, where the file's correct value was rejected by an old page.

nginx `add_header` does NOT inherit from the parent level once a level declares
any add_header, so the two server-level security headers are repeated here on
purpose rather than silently dropped.

Idempotent and assertion-guarded: writes nothing if the anchor is missing.
"""
import shutil
import sys
import time

PATH = "/etc/nginx/sites-enabled/helixmain"

ANCHOR = """    # Owner dashboard (Vite SPA)
    location /dashboard {
        alias /var/www/helix-dashboard;
        try_files $uri $uri/ /dashboard/index.html;
    }
"""

REPLACEMENT = """    # Owner dashboard (Vite SPA)
    # Content-addressed assets: safe to cache forever.
    location /dashboard/assets/ {
        alias /var/www/helix-dashboard/assets/;
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Frame-Options SAMEORIGIN;
        add_header X-Content-Type-Options nosniff;
    }

    # The SPA shell must NEVER be cached: a rebuild (or a credential rotation)
    # otherwise leaves the browser running a stale bundle. add_header does not
    # inherit across levels, so the security headers are repeated deliberately.
    location /dashboard {
        alias /var/www/helix-dashboard;
        try_files $uri $uri/ /dashboard/index.html;
        add_header Cache-Control "no-cache";
        add_header X-Frame-Options SAMEORIGIN;
        add_header X-Content-Type-Options nosniff;
    }
"""


def main() -> int:
    with open(PATH, encoding="utf-8") as fh:
        src = fh.read()
    if "location /dashboard/assets/" in src:
        print("already patched — no change")
        return 0
    if ANCHOR not in src:
        print("ANCHOR NOT FOUND — nothing written", file=sys.stderr)
        return 1
    ts = time.strftime("%Y%m%d%H%M%S")
    bak = f"/root/nginx-helixmain.bak-cache-{ts}"
    shutil.copy2(PATH, bak)
    with open(PATH, "w", encoding="utf-8") as fh:
        fh.write(src.replace(ANCHOR, REPLACEMENT, 1))
    print("patched live nginx; backup:", bak)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
