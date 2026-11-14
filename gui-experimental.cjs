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
    "voice.processing": "Transcribing…",
    "voice.setup": "Preparing voice… (installing libraries on first use)",
    "voice.setupHint": "Click to cancel the setup",
    "voice.cancelled": "Voice setup cancelled",
    "voice.hint": "Dictate into the prompt",
    "voice.command": "Voice: dictate into the prompt",
    "voice.command.description": "Record speech and insert the transcription into the prompt",
    "voice.noComposer": "No prompt is open",
    "voice.noSpeech": "No speech detected",
    "voice.insertedElsewhere": "Inserted into the session where dictation started",
  },
  ar: {
    "voice.label": "صوت",
    "voice.recording": "… يتم التسجيل — اضغط للإيقاف",
    "voice.processing": "… جارٍ تحويل الكلام إلى نص",
    "voice.setup": "… جارٍ تجهيز الصوت (تنصيب المكتبات أول مرة)",
    "voice.setupHint": "اضغط لإلغاء التجهيز",
    "voice.cancelled": "تم إلغاء تجهيز الصوت",
    "voice.hint": "أملِ في خانة الكتابة",
    "voice.command": "صوت: إملاء داخل خانة الكتابة",
    "voice.command.description": "تسجيل الكلام وإدراج التفريغ في خانة الكتابة",
    "voice.noComposer": "لا توجد خانة كتابة مفتوحة",
    "voice.noSpeech": "لم يتم التقاط أي كلام",
    "voice.insertedElsewhere": "تم الإدراج في الجلسة التي بدأ فيها التسجيل",
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
const signals =
  solid && typeof solid.createSignal === "function"
    ? solid
    : { createSignal: (value) => [() => value, () => {}] };

// Must stay identical to the token declared in index.js.
const Voice =
  rpcSdk && typeof rpcSdk.Rpc?.define === "function"
    ? rpcSdk.Rpc.define({
        id: "voice",
        methods: {
          ensure: {
            input: {
              type: "object",
              properties: { force: { type: "boolean" } },
            },
            output: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                installed: { type: "boolean" },
                missing: { type: "array" },
                python: { type: "string" },
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
                code: { type: "string" },
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
              properties: { recording: { type: "boolean" }, phase: { type: "string" } },
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
      let cancelRequested = false;
      /** True once the dependency check passed; avoids re-probing on every click. */
      let depsReady = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      /** @type {ReturnType<typeof setInterval> | undefined} */
      let statusTimer;

      const currentSessionID = () => {
        try {
          return ctx.sessions?.current?.()?.id;
        } catch {
          return undefined;
        }
      };

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

        // A press during setup cancels it; a press while recording stops early.
        if (busy) {
          if (phase() === "setup") {
            cancelRequested = true;
            flash(t("voice.cancelled"));
            return;
          }
          if (phase() === "processing") {
            flash(t("voice.processing"));
            return;
          }
          try {
            await ctx.client.rpc(Voice).stop({});
          } catch {
            /* the recording may already have ended on silence */
          }
          return;
        }

        // Another window may own the recording; this press stops that one.
        if (phase() === "recording") {
          try {
            await ctx.client.rpc(Voice).stop({});
            setPhase("idle");
          } catch {
            /* the recording may already have ended */
          }
          return;
        }

        // The microphone is already closed and the text is on its way; a new
        // recording would only fail with "already in progress".
        if (phase() === "processing") {
          flash(t("voice.processing"));
          return;
        }

        // Capture the composer before recording. Recording takes seconds, and
        // `ctx.screen.current()` afterwards could point at another session.
        const composer = ctx.screen.current()?.composer;
        if (!composer) {
          flash(t("voice.noComposer"));
          return;
        }
        const sessionID = currentSessionID();

        busy = true;
        cancelRequested = false;
        setNote("");
        setPhase("setup");

        try {
          // First run on this machine may install the Python audio libraries.
          // A failed check is retried on the next click; a check that already
          // passed is served from the cache, so recording starts immediately.
          const ready = await ctx.client.rpc(Voice).ensure({ force: !depsReady });
          depsReady = Boolean(ready?.ok);
          if (cancelRequested) {
            flash(t("voice.cancelled"));
            return;
          }
          if (!ready?.ok) {
            flash(ready?.error || t("voice.setup"));
            return;
          }

          setPhase("recording");
          const result = await ctx.client.rpc(Voice).transcribe({});
          const text = typeof result?.text === "string" ? result.text.trim() : "";

          if (!text) {
            if (result?.code === "DEPENDENCY_ERROR") depsReady = false;
            flash(result?.error || t("voice.noSpeech"));
            return;
          }

          // The composer API adds text at the last cursor position. Add a
          // separator when the prompt already ends with a word.
          let current = "";
          try {
            current = typeof composer.text === "function" ? composer.text() : "";
          } catch {
            current = "";
          }
          const needsSpace = current.length > 0 && !/\s$/.test(current) && !/^\s/.test(text);

          composer.insert(needsSpace ? ` ${text}` : text);
          composer.focus();

          if (sessionID && currentSessionID() && currentSessionID() !== sessionID) {
            flash(t("voice.insertedElsewhere"));
          }
        } catch (error) {
          depsReady = false;
          flash(`Voice: ${error?.message ?? String(error)}`);
        } finally {
          busy = false;
          cancelRequested = false;
          setPhase("idle");
        }
      };

      // The server is shared by every window: reflect a recording started
      // elsewhere instead of showing a misleading "idle" pill.
      const syncStatus = async () => {
        if (!Voice) return;
        // Never fight the local flow: setup and flash messages own the pill.
        if (note() || phase() === "setup") return;
        try {
          const status = await ctx.client.rpc(Voice).status({});
          if (note() || phase() === "setup") return;
          if (status?.phase === "processing") setPhase("processing");
          else if (status?.recording) setPhase("recording");
          else if (!busy) setPhase("idle");
        } catch {
          /* the server may be reloading */
        }
      };

      void syncStatus();
      // Short interval: the pill must flip to "transcribing" right after the
      // microphone closes, and back to idle when the text lands.
      statusTimer = setInterval(() => void syncStatus(), 1200);

      try {
        ctx.add(gui.ComposerPill, {
          id: "mic",
          order: 10,
          show: () => {
            const pending = note();
            const current = phase();

            if (pending) {
              return {
                icon: "outline-hexagonal-warning",
                label: `⚠ ${pending}`,
                tone: "danger",
                title: pending,
                run: () => void dictate(),
              };
            }
            if (current === "setup") {
              return {
                icon: "outline-rotate-clockwise",
                label: t("voice.setup"),
                tone: "warning",
                title: t("voice.setupHint"),
                run: () => void dictate(),
              };
            }
            if (current === "recording") {
              return {
                icon: "outline-audio",
                label: t("voice.recording"),
                tone: "danger",
                title: t("voice.recording"),
                run: () => void dictate(),
              };
            }
            if (current === "processing") {
              return {
                icon: "outline-rotate-clockwise",
                label: t("voice.processing"),
                tone: "warning",
                title: t("voice.processing"),
                run: () => void dictate(),
              };
            }
            return {
              icon: "outline-audio",
              label: t("voice.label"),
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
        if (statusTimer) clearInterval(statusTimer);
        if (busy && Voice) {
          try {
            void ctx.client.rpc(Voice).stop({});
          } catch {
            /* the plugin is unloading */
          }
        }
      };
    },
  });
}

module.exports = build();
