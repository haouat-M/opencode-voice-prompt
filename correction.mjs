/**
 * Contextual correction of dictated text.
 *
 * Dependency-free on purpose, so it can be unit-tested with `node --test`
 * without installing the OpenCode plugin SDK.
 *
 * The corrector must NOT translate, normalise the speaker's dialect, or add
 * information. It only fixes spelling/recognition mistakes and writes words
 * that the speaker uttered in English (even with an Arabic accent) in Latin
 * script.
 */

export const CORRECTION_PROMPT = `You correct speech-to-text output for Arabic dictation.

Rules:
1. Fix only spelling and recognition mistakes using the context of the sentence.
2. Keep the speaker's exact wording and dialect (Lebanese, Palestinian, Jordanian, Egyptian, Gulf, or any other). Never rewrite into Modern Standard Arabic or into a different dialect.
3. Never translate Arabic words into English. A word like "صندوق" stays "صندوق".
4. Write any word the speaker said in English — even pronounced with an Arabic accent — in correct English Latin script. Examples: إنجلش/انجلش/إنجليزي (meaning the language) -> English; دوكر -> Docker; كوميت -> commit; بوش -> push; جيت هاب -> GitHub; ريبو -> repo; سيرفر -> server.
5. Do not add, remove, or reorder information. Keep numbers, punctuation and the general length of the text.
6. Return ONLY a JSON object with one field: {"text":"corrected text"}

Examples:
"بدي اعمل كوميت وبعدها بوش على جيت هاب" -> {"text":"بدي اعمل commit وبعدها push على GitHub"}
"عايز حطها بالإنجلش" -> {"text":"عايز حطها بالـ English"}
"قلت صندوق" -> {"text":"قلت صندوق"}`;

/**
 * Build the model prompt. Custom fixes are appended as hard requirements so
 * user-supplied spellings survive the correction step.
 */
export function buildCorrectionPrompt(text, customFixes = []) {
  const fixes = Array.isArray(customFixes) ? customFixes : [];
  const extra = fixes.length
    ? `\n\nAlways write these exact spellings: ${JSON.stringify(fixes)}`
    : "";
  return `${CORRECTION_PROMPT}\n\nTRANSCRIPT: ${JSON.stringify(text)}${extra}`;
}

/**
 * Extract the corrected text from a model reply. Returns "" on anything that
 * looks unsafe, so the caller can fall back to the uncorrected transcription.
 */
export function parseCorrection(raw, originalText) {
  if (typeof raw !== "string" || !originalText) return "";

  let body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const objectMatch = body.match(/\{[\s\S]*\}/);
  if (!objectMatch) return "";
  body = objectMatch[0];

  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return "";
  }

  const text = value && typeof value.text === "string" ? value.text.trim() : "";
  if (!text) return "";

  // A short correction must not turn into a paragraph, translation or summary.
  const limit = Math.max(80, originalText.length * 2 + 40);
  if (text.length > limit) return "";
  return text;
}
