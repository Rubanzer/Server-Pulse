import { test } from "node:test";
import assert from "node:assert/strict";
import { decrypt, encrypt, hashPassword, isPrivateAddress, verifyPassword } from "./crypto.ts";

test("password hash round-trip", () => {
  const h = hashPassword("correct horse");
  assert.ok(h.startsWith("scrypt$"));
  assert.ok(verifyPassword("correct horse", h));
  assert.ok(!verifyPassword("wrong horse", h));
  assert.notEqual(hashPassword("x"), hashPassword("x")); // salted
  assert.ok(!verifyPassword("x", "garbage"));
});

test("encrypt / decrypt", () => {
  const t = encrypt("https://u:p@host", "s1");
  assert.equal(decrypt(t, "s1"), "https://u:p@host");
  assert.equal(decrypt(t, "s2"), null); // wrong key
  const parts = t.split(".");
  parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("A") ? "BB" : "AA");
  assert.equal(decrypt(parts.join("."), "s1"), null); // tampered
});

test("private addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "nope"])
    assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "104.16.1.1", "2606:4700::1111", "::ffff:808:808"]) assert.ok(!isPrivateAddress(ip), ip);
});
