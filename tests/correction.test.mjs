import test from "node:test";
import assert from "node:assert/strict";
import { CORRECTION_PROMPT, buildCorrectionPrompt, parseCorrection } from "../correction.mjs";

test("prompt protects dialect, meaning and script rules", () => {
  assert.match(CORRECTION_PROMPT, /Never translate Arabic words/);
  assert.match(CORRECTION_PROMPT, /Never rewrite into Modern Standard Arabic/);
  assert.match(CORRECTION_PROMPT, /Latin script/);
  assert.match(CORRECTION_PROMPT, /صندوق/);
  assert.match(CORRECTION_PROMPT, /إنجلش/);
});

test("prompt carries the transcript and custom fixes", () => {
  const prompt = buildCorrectionPrompt("عايز حطها بالإنجلش", [["فاست", "Fast"]]);
  assert.match(prompt, /TRANSCRIPT: "عايز حطها بالإنجلش"/);
  assert.match(prompt, /فاست/);
  assert.match(prompt, /Fast/);
});

test("parses a plain JSON reply", () => {
  assert.equal(
    parseCorrection('{"text":"عايز حطها بالـ English"}', "عايز حطها بالإنجلش"),
    "عايز حطها بالـ English",
  );
});

test("parses a fenced reply with extra prose", () => {
  const reply = 'Here is the result:\n```json\n{"text":"بدي اعمل commit"}\n```\nDone.';
  assert.equal(parseCorrection(reply, "بدي اعمل كوميت"), "بدي اعمل commit");
});

test("rejects missing, empty, malformed and runaway replies", () => {
  assert.equal(parseCorrection("", "original"), "");
  assert.equal(parseCorrection(undefined, "original"), "");
  assert.equal(parseCorrection("no json here", "original"), "");
  assert.equal(parseCorrection('{"text":""}', "original"), "");
  assert.equal(parseCorrection('{"text":"' + "x".repeat(500) + '"}', "short"), "");
});
