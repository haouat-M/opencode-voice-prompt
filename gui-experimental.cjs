"use strict";

/**
 * OpenCode Voice Prompt — GUI part (OpenCode Desktop).
 *
 * Runs inside every desktop window, so the microphone control lives inside the
 * application itself and the transcription is written straight into the prompt
 * composer instead of being pasted through the clipboard.
 */

const messages = {
  en: {
    "voice.label": "Voice",
    "voice.recording": "Recording… click to stop",
    "voice.setup": "Preparing voice… (installing libraries on first use)",
    "voice.hint": "Dictate into the prompt",
    "voice.command": "Voice: dictate into the prompt",
    "voice.command.description": "Record speech and insert the transcription into the prompt",
    "voice.noComposer": "No prompt is open",
    "voice.noSpeech": "No speech detected",
  },
  ar: {
    "voice.label": "صوت",
    "voice.recording": "… يتم التسجيل — اضغط للإيقاف",
    "voice.setup": "… جارٍ تجهيز الصوت (تنصيب المكتبات أول مرة)",
    "voice.hint": "أملِ في خانة الكتابة",
    "voice.command": "صوت: إملاء داخل خانة الكتابة",
    "voice.command.description": "تسجيل الكلام وإدراج التفريغ في خانة الكتابة",
    "voice.noComposer": "لا توجد خانة كتابة مفتوحة",
    "voice.noSpeech": "لم يتم التقاط أي كلام",
  },
};

let gui;
let rpcSdk;
let solid;

try {
  gui = require("@opencode/plugin/gui");
} catch (error) {
  console.error("[opencode-voice-prompt] GUI SDK unavailable:", error);
}

try {
  rpcSdk = require("@opencode/plugin/rpc");
} catch (error) {
  console.error("[opencode-voice-prompt] RPC SDK unavailable:", error);
}

try {
  solid = require("solid-js");
} catch (error) {
  solid = undefined;
}

// Minimal fallback so the module still loads when solid-js is not provided.
const signals = solid && typeof solid.createSignal === "function"
  ? solid
  : { createSignal: (value) => [() => value, () => {}] };

// Must stay identical to the token declared in index.js.
const Voice =
  rpcSdk && typeof rpcSdk.Rpc?.define === "function"
    ? rpcSdk.Rpc.define({
        id: "voice",
        methods: {
          ensure: {
            input: { type: "object", properties: {} },
            output: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                installed: { type: "boolean" },
                missing: { type: "array" },
                error: { type: "string" },
              },
              required: ["ok"],
            },
          },
          transcribe: {
            input: {
              type: "object",
              properties: {
                language: { type: "string" },
                silence: { type: "number" },
                timeout: { type: "number" },
              },
            },
            output: {
              type: "object",
              properties: {
                text: { type: "string" },
                raw: { type: "string" },
                duration: { type: "number" },
                language: { type: "string" },
                error: { type: "string" },
              },
              required: ["text"],
            },
          },
          stop: {
            input: { type: "object", properties: {} },
            output: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          },
          status: {
            input: { type: "object", properties: {} },
            output: {
              type: "object",
              properties: { recording: { type: "boolean" } },
              required: ["recording"],
            },
          },
        },
      })
    : undefined;

function build() {
  if (!gui || typeof gui.Plugin?.define !== "function") {
    return { setup() {} };
  }

  return gui.Plugin.define({
    i18n: messages,

    setup(ctx) {
      const t = (key) => {
        try {
          const value = ctx.t(key);
          return typeof value === "string" && value && value !== key ? value : messages.en[key] ?? key;
        } catch {
          return messages.en[key] ?? key;
        }
      };

      const [phase, setPhase] = signals.createSignal("idle");
      const [note, setNote] = signals.createSignal("");

      let busy = false;
      let timer;

      const flash = (text) => {
        setNote(text);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setNote(""), 5000);
      };

      const dictate = async () => {
        if (!Voice) {
          flash("Voice: RPC unavailable");
          return;
        }

        // A second press stops the running recording early.
        if (busy) {
          try {
            await ctx.client.rpc(Voice).stop({});
          } catch {
            /* the recording may already have ended on silence */
          }
          return;
        }

        busy = true;
        setNote("");
        setPhase("setup");

        try {
          // First run on this machine may install the Python audio libraries.
          const ready = await ctx.client.rpc(Voice).ensure({});
          if (!ready?.ok) {
            flash(ready?.error || t("voice.setup"));
            return;
          }

          setPhase("recording");
          const result = await ctx.client.rpc(Voice).transcribe({});
          const text = typeof result?.text === "string" ? result.text.trim() : "";

          if (!text) {
            flash(result?.error || t("voice.noSpeech"));
            return;
          }

          const composer = ctx.screen.current()?.composer;

          if (!composer) {
            flash(t("voice.noComposer"));
            return;
          }

          // The whole point: put the text in the prompt the user is writing.
          composer.insert(text);
          composer.focus();
        } catch (error) {
          flash(`Voice: ${error?.message ?? String(error)}`);
        } finally {
          busy = false;
          setPhase("idle");
        }
      };

      try {
        ctx.add(gui.ComposerPill, {
          id: "mic",
          order: 10,
          show: () => {
            const pending = note();
            const current = phase();

            if (pending) {
              return {
                label: `⚠ ${pending}`,
                tone: "danger",
                title: pending,
                run: () => void dictate(),
              };
            }
            if (current === "setup") {
              return {
                label: `⚙ ${t("voice.setup")}`,
                tone: "warning",
                title: t("voice.setup"),
                run: () => void dictate(),
              };
            }
            if (current === "recording") {
              return {
                label: t("voice.recording"),
                tone: "danger",
                title: t("voice.recording"),
                run: () => void dictate(),
              };
            }
            return {
              label: `🎙 ${t("voice.label")}`,
              title: t("voice.hint"),
              run: () => void dictate(),
            };
          },
        });
      } catch (error) {
        console.error("[opencode-voice-prompt] composer pill failed:", error);
      }

      try {
        ctx.add(gui.Command, () => ({
          id: "dictate",
          title: t("voice.command"),
          description: t("voice.command.description"),
          keywords: "voice mic microphone dictation transcribe speech صوت إملاء",
          section: "prompt",
          bind: "mod+alt+a",
          slash: { name: "voice" },
          editable: true,
          run: () => void dictate(),
        }));
      } catch (error) {
        console.error("[opencode-voice-prompt] command failed:", error);
      }

      return () => {
        if (timer) clearTimeout(timer);
      };
    },
  });
}

module.exports = build();
