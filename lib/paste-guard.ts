// Recognize the things people paste by mistake and explain what they are. Pure; used client-side.

export function explainPaste(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/tskey-(auth|client|api)-/i.test(s))
    return "That's a Tailscale auth key. It belongs on your server (the installer asks for it), not here. Use Add server to get the one-line install command instead.";
  if (/login\.tailscale\.com\/admin\/invite/i.test(s) || /login\.tailscale\.com\/.*share/i.test(s))
    return "That's a Tailscale invite or share link. It invites a person to your Tailscale network; the dashboard doesn't use it. Use Add server instead.";
  if (/login\.tailscale\.com\/a\//i.test(s))
    return "That's a Tailscale login link. Open it in your browser to approve the server; you don't paste it here.";
  if (/^ngrok config add-authtoken|^[0-9A-Za-z]{20,}_[0-9A-Za-z]{20,}$/.test(s))
    return "That looks like an ngrok authtoken. It stays on your server; never paste it into websites.";
  if (/:7681\b|ttyd|btop/i.test(s))
    return "That looks like a btop terminal address. The dashboard needs the Server Pulse agent instead: use Add server, or point your tunnel at 127.0.0.1:19998.";
  return null;
}

/** Address + username + password → the server link the dashboard stores. */
export function composeLink(address: string, user: string, pass: string): string {
  let host = address.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  host = host.replace(/^[^@]*@/, ""); // someone pasted credentials into the address field
  return `https://${encodeURIComponent(user.trim() || "dashboard")}:${encodeURIComponent(pass)}@${host}/history`;
}
