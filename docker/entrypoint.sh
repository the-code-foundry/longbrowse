#!/bin/sh
# HEADLESS=1: no display at all. Otherwise node spawns Xvnc + websockify itself
# (core/display.js), so pause/unpause can stop and restart them. This script only
# prepares what node cannot: the X lock cleanup and the VNC password file (DES
# needs --openssl-legacy-provider, which the server process does not run with).
set -e
if [ "$HEADLESS" = "1" ]; then
  exec node core/server.js
fi
# docker restart keeps the container fs: a stale X lock would kill Xvnc
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
if [ -n "$VNC_PASSWORD" ]; then
  # VNC auth file: password DES-encrypted with the fixed VNC key (first 8 chars
  # count). The image's tigervnc ships no vncpasswd, so node writes it.
  node --openssl-legacy-provider -e '
    const c = require("node:crypto");
    const pw = Buffer.alloc(8);
    Buffer.from(process.env.VNC_PASSWORD).copy(pw, 0, 0, 8);
    const ci = c.createCipheriv("des-ecb", Buffer.from("e84ad660c4721ae0", "hex"), null);
    ci.setAutoPadding(false);
    require("node:fs").writeFileSync("/tmp/vncpass", ci.update(pw), { mode: 0o600 });'
fi
exec node core/server.js
