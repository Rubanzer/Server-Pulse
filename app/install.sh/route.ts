import { type NextRequest } from "next/server";

// GET /install.sh — the one-line installer shown on the Add server screen:
//   curl -fsSL https://<dashboard>/install.sh | sudo bash -s -- CODE [https://own-tunnel.example]
// It downloads the agent from GitHub Releases, verifies the SHA-256 against the release's SHA256SUMS,
// installs it as a service and pairs it with this dashboard.

const REPO = "MonoEdge-in/Server-Pulse";

export function GET(req: NextRequest) {
  const dashboard = req.nextUrl.origin;
  const script = `#!/usr/bin/env bash
# Server Pulse agent installer — served by ${dashboard}
set -euo pipefail

CODE="\${1:-}"
PUBLIC_URL="\${2:-}"
DASHBOARD="${dashboard}"
BASE="https://github.com/${REPO}/releases/latest/download"

say() { printf '\\033[1m→ %s\\033[0m\\n' "$*"; }
die() { printf '\\033[31m✗ %s\\033[0m\\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run it with sudo:  curl -fsSL $DASHBOARD/install.sh | sudo bash -s -- YOUR-CODE"
[ -n "$CODE" ] || die "Missing pairing code. Copy the full command from Add server in the dashboard."
command -v systemctl >/dev/null || die "This server needs systemd (Ubuntu 22.04 / 24.04 have it)."
command -v curl >/dev/null || die "curl is missing:  sudo apt install -y curl"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Unsupported CPU type: $(uname -m)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading the Server Pulse agent ($ARCH)"
curl -fsSL -o "$TMP/server-pulse-agent" "$BASE/server-pulse-agent-linux-$ARCH" || die "Download failed. Is the GitHub repository public and does it have an agent release?"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || die "Checksum file missing from the release."

say "Verifying the download"
WANT="$(grep -E "[ *]server-pulse-agent-linux-$ARCH\\$" "$TMP/SHA256SUMS" | awk '{print $1}')"
GOT="$(sha256sum "$TMP/server-pulse-agent" | awk '{print $1}')"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || die "Checksum mismatch: refusing to run this download."
chmod +x "$TMP/server-pulse-agent"

if [ -n "$PUBLIC_URL" ]; then
  "$TMP/server-pulse-agent" install --pair "$CODE" --dashboard "$DASHBOARD" --public-url "$PUBLIC_URL"
else
  "$TMP/server-pulse-agent" install --pair "$CODE" --dashboard "$DASHBOARD"
fi
`;
  return new Response(script, {
    headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" },
  });
}
