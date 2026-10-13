import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSteps, fullScript, randomPassword, SAFE_PASSWORD, serverLink, type SetupInput } from "./setup-script.ts";

const base: SetupInput = {
  ownerPass: "OwnerPass123456",
  appPass: "AppPass123456789",
  tunnel: "tailscale",
  ngrokToken: "",
  ngrokDomain: "",
  telegramToken: "",
  telegramChat: "",
  smtpHost: "",
  smtpPort: "",
  smtpUser: "",
  smtpPass: "",
  mailTo: "",
};

test("randomPassword is URL-safe and the right length", () => {
  for (let i = 0; i < 50; i++) assert.match(randomPassword(), SAFE_PASSWORD);
  assert.equal(randomPassword(40).length, 40);
});

test("optional steps appear only when filled in", () => {
  assert.deepEqual(buildSteps(base).map((s) => s.id), ["btop", "netdata", "caddy", "tunnel", "awake", "verify"]);
  const all = buildSteps({ ...base, telegramToken: "t", telegramChat: "1", smtpHost: "h", smtpUser: "u", smtpPass: "p", mailTo: "m" });
  assert.deepEqual(all.map((s) => s.id), ["btop", "netdata", "caddy", "tunnel", "telegram", "mail", "awake", "verify"]);
});

test("passwords are single-quoted so the shell cannot expand them", () => {
  const s = fullScript({ ...base, ownerPass: "a'b$(rm -rf /)" });
  assert.ok(s.includes(`--plaintext 'a'\\''b$(rm -rf /)'`));
  assert.ok(!s.includes("undefined"));
  assert.ok(s.startsWith("#!/usr/bin/env bash"));
});

test("ngrok steps and link", () => {
  const s = fullScript({ ...base, tunnel: "ngrok", ngrokDomain: "x.ngrok-free.app", ngrokToken: "tok" });
  assert.ok(s.includes("--url=https://x.ngrok-free.app"));
  assert.equal(serverLink(base, "box.ts.net"), "https://dashboard:AppPass123456789@box.ts.net/history");
});

test("an invalid ngrok domain never reaches the script", () => {
  const s = fullScript({ ...base, tunnel: "ngrok", ngrokDomain: "$(touch /tmp/pwn).ngrok-free.app" });
  assert.ok(!s.includes("$(touch"));
  // no address → no --url at all: ngrok then uses the account's own free address (a placeholder crash-looped)
  assert.ok(s.includes("ngrok) http 8080 --log=stdout"));
});

test("tailscale login is left out of the unattended script", () => {
  const s = fullScript(base);
  assert.ok(!/^sudo tailscale up/m.test(s));
  assert.ok(s.includes('echo "  sudo tailscale up"'));
});

test("24/7: tailscale warns about key expiry, every setup keeps the machine awake", () => {
  const ts = buildSteps(base).find((s) => s.id === "tunnel")!;
  assert.match(ts.note ?? "", /Disable key expiry/);
  assert.match(ts.verify ?? "", /KeyExpiry/);
  const s = fullScript({ ...base, tunnel: "ngrok", ngrokDomain: "x.ngrok-free.app" });
  assert.ok(s.includes("systemctl mask sleep.target"));
  assert.ok(s.includes("HandleLidSwitch=ignore"));
});
