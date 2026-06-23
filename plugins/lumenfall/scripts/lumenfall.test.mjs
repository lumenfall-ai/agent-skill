import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maskKey, maskSecret, idTokenEmail, parseArgs, parseGenerate, parseGenerateFlags, formatEstimateCost, truncate, storeCredential, loadCredential, credentialPath, topupUrl } from "./lumenfall.mjs";

test("maskKey shows prefix + last 4 only", () => {
  assert.equal(maskKey("lmnfl_key_abc.SECRETvalue1234"), "lmnfl_key_abc.…1234");
});

test("parseArgs reads the subcommand and flags", () => {
  const a = parseArgs(["login", "--env-file", ".env"]);
  assert.equal(a.command, "login");
  assert.equal(a.flags["env-file"], ".env");
});

test("storeCredential writes 0600 JSON and round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lmnfl-"));
  process.env.LUMENFALL_CONFIG_DIR = dir;
  storeCredential({ api_key: "lmnfl_key_x.secret1234", key_id: "key_x", organization_id: "org_y", issuer: "https://lumenfall.ai" });
  const mode = fs.statSync(credentialPath()).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(loadCredential().key_id, "key_x");
  delete process.env.LUMENFALL_CONFIG_DIR;
});

test("maskKey handles a dot-less key without inserting a spurious dot", () => {
  // key with no dot — falls back to 8-char prefix; result must not start with "."
  const result = maskKey("abcdefghijklmnop");
  assert.ok(!result.startsWith("."), "no leading dot when key has no dot");
  assert.equal(result, "abcdefgh.…mnop");
});

test("topupUrl points at the connected page on the issuer", () => {
  assert.equal(topupUrl(), "https://lumenfall.ai/app/cli/connected");
});

test("maskSecret shows brand prefix + bullets + last 4, never the secret", () => {
  const masked = maskSecret("lmnfl_key_abc.SECRETvalue3a9f");
  assert.equal(masked, `lmnfl_${"•".repeat(13)}3a9f`);
  assert.ok(!masked.includes("SECRET"), "secret body must not appear");
});

test("idTokenEmail decodes the email claim from an id_token payload", () => {
  const payload = Buffer.from(JSON.stringify({ email: "till@lumenfall.ai", sub: "1" })).toString("base64url");
  assert.equal(idTokenEmail(`header.${payload}.sig`), "till@lumenfall.ai");
});

test("idTokenEmail returns null for missing or malformed tokens", () => {
  assert.equal(idTokenEmail(null), null);
  assert.equal(idTokenEmail("not-a-jwt"), null);
});

test("formatEstimateCost renders micros as a trimmed dollar string", () => {
  assert.equal(formatEstimateCost(40000), "0.04");
  assert.equal(formatEstimateCost(420000), "0.42");
  assert.equal(formatEstimateCost(1_000_000), "1.00");
  assert.equal(formatEstimateCost(1500), "0.0015"); // sub-cent keeps precision
  assert.equal(formatEstimateCost(0), "0.00");
});

test("truncate collapses whitespace/newlines and caps length", () => {
  assert.equal(truncate("hello", 20), "hello");
  assert.equal(truncate("a\n  multi   line\nmessage", 80), "a multi line message");
  assert.equal(truncate("0123456789", 5), "0123…");
  assert.equal(truncate(null, 5), "");
});

test("parseGenerateFlags treats --video and --estimate as booleans", () => {
  const f = parseGenerateFlags(["a capybara", "--estimate", "--model", "flux1.1-pro"]);
  assert.equal(f.estimate, true);
  assert.equal(f.model, "flux1.1-pro");
  // boolean flag must not swallow the following token
  const v = parseGenerateFlags(["--video", "--output", "out.mp4"]);
  assert.equal(v.video, true);
  assert.equal(v.output, "out.mp4");
});

test("parseGenerate keeps value-flag values out of positionals (prompt not corrupted)", () => {
  // flag-before-prompt must not make the flag's value the prompt
  const a = parseGenerate(["--size", "1280x720", "a dog"]);
  assert.deepEqual(a.positionals, ["a dog"]);
  assert.equal(a.flags.size, "1280x720");

  // estimate <modality> "<prompt>" with a value flag in between
  const b = parseGenerate(["image", "--model", "flux1.1-pro", "a cat"]);
  assert.deepEqual(b.positionals, ["image", "a cat"]);
  assert.equal(b.flags.model, "flux1.1-pro");

  // boolean flag interleaved, prompt last
  const c = parseGenerate(["video", "--estimate", "a fox"]);
  assert.deepEqual(c.positionals, ["video", "a fox"]);
  assert.equal(c.flags.estimate, true);
});
