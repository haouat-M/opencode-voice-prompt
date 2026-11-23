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
                sessionID: { type: "string" },
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
          correct: {
            input: {
              type: "object",
              properties: { text: { type: "string" }, sessionID: { type: "string" } },
              required: ["text"],
            },
            output: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          stop: {
            input: { type: "object", properties: { sessionID: { type: "string" } } },
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
              properties: {
                recording: { type: "boolean" },
                phase: { type: "string" },
                sessions: { type: "object" },
              },
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

      // Each session owns its own pill state. A recording in one session must
      // never make the button in another session look busy.
      const [statuses, setStatuses] = signals.createSignal({});
      const localStates = new Map();

      const idOf = (session) => session?.id ?? "default";

      const statusByID = (id) => statuses()[id]?.phase ?? "idle";
      const noteByID = (id) => statuses()[id]?.note ?? "";
      const patchStatus = (id, patch) => {
        setStatuses((prev) => ({
          ...prev,
          [id]: { phase: "idle", note: "", ...(prev[id] ?? {}), ...patch },
        }));
      };

      const phaseOf = (session) => statusByID(idOf(session));
      const noteOf = (session) => noteByID(idOf(session));
      const setPhase = (session, value) => patchStatus(idOf(session), { phase: value });
      const setNote = (session, value) => patchStatus(idOf(session), { note: value });

      const localOf = (session) => {
        const id = idOf(session);
        let local = localStates.get(id);
        if (!local) {
          local = { busy: false, cancelRequested: false, timer: undefined };
          localStates.set(id, local);
        }
        return local;
      };

      /** True once the dependency check passed; avoids re-probing on every click. */
      let depsReady = false;
      /** @type {ReturnType<typeof setInterval> | undefined} */
      let statusTimer;

      const currentSession = () => {
        try {
          return ctx.sessions?.current?.();
        } catch {
          return undefined;
        }
      };

      const currentSessionID = () => currentSession()?.id;

      const activeTabKey = () => {
        try {
          return ctx.tabs?.list?.().find((tab) => tab.active)?.key;
        } catch {
          return undefined;
        }
      };

      const flash = (session, text) => {
        setNote(session, text);
        const local = localOf(session);
        if (local.timer) clearTimeout(local.timer);
        local.timer = setTimeout(() => setNote(session, ""), 5000);
      };

      const dictate = async (session) => {
        if (!Voice) {
          flash(session, "Voice: RPC unavailable");
          return;
        }

        const local = localOf(session);
        const view = () => phaseOf(session);
        const sid = typeof session?.id === "string" ? session.id : undefined;

        // A press during setup cancels it; a press while recording stops early.
        if (local.busy) {
          if (view() === "setup") {
            local.cancelRequested = true;
            flash(session, t("voice.cancelled"));
            return;
          }
          if (view() === "processing") {
            flash(session, t("voice.processing"));
            return;
          }
          try {
            await ctx.client.rpc(Voice).stop({ sessionID: sid });
          } catch {
            /* the recording may already have ended on silence */
          }
          local.busy = false;
          setPhase(session, "idle");
          return;
        }

        if (view() === "recording") {
          try {
            await ctx.client.rpc(Voice).stop({ sessionID: sid });
            setPhase(session, "idle");
          } catch {
            /* the recording may already have ended */
          }
          return;
        }

        if (view() === "processing") {
          flash(session, t("voice.processing"));
          return;
        }

        const composer = ctx.screen.current()?.composer;
        if (!composer) {
          flash(session, t("voice.noComposer"));
          return;
        }
        const startSession = session ?? currentSession();
        const sessionID = startSession?.id;

        local.busy = true;
        local.cancelRequested = false;
        setNote(session, "");
        setPhase(session, "setup");

        try {
          const ready = await ctx.client.rpc(Voice).ensure({ force: !depsReady });
          depsReady = Boolean(ready?.ok);
          if (local.cancelRequested) {
            flash(session, t("voice.cancelled"));
            return;
          }
          if (!ready?.ok) {
            flash(session, ready?.error || t("voice.setup"));
            return;
          }

          setPhase(session, "recording");
          const result = await ctx.client.rpc(Voice).transcribe({ sessionID });
          const text = typeof result?.text === "string" ? result.text.trim() : "";

          if (!text) {
            if (result?.code === "DEPENDENCY_ERROR") depsReady = false;
            flash(session, result?.error || t("voice.noSpeech"));
            return;
          }

          // Writes apply to the routed session, so route back to the session
          // whose button started this recording before inserting. Then restore
          // the tab the user moved to, leaving the text in its own session.
          const userTab = activeTabKey();
          let targetTabKey;
          try {
            targetTabKey = ctx.tabs
              ?.list?.()
              .find((tab) => tab.session?.id === sessionID || tab.session?.key === startSession?.key)?.key;
          } catch {
            targetTabKey = undefined;
          }
          if (targetTabKey && ctx.tabs?.focus && userTab !== targetTabKey) {
            ctx.tabs.focus(targetTabKey);
            for (let i = 0; i < 20 && currentSessionID() !== sessionID; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          // If the tab registry is unavailable, stay with the composer captured
          // when the button was pressed instead of dropping the transcript.
          const targetComposer = targetTabKey ? ctx.screen.current()?.composer : composer;
          if (!targetComposer) {
            flash(session, t("voice.noComposer"));
            return;
          }

          // The composer API adds text at the last cursor position. Add a
          // separator when the prompt already ends with a word.
          let current = "";
          try {
            current = typeof targetComposer.text === "function" ? targetComposer.text() : "";
          } catch {
            current = "";
          }
          const needsSpace = current.length > 0 && !/\s$/.test(current) && !/^\s/.test(text);

          targetComposer.insert(needsSpace ? ` ${text}` : text);
          targetComposer.focus();

          if (userTab && userTab !== targetTabKey && ctx.tabs?.focus) {
            ctx.tabs.focus(userTab);
          }
          if (userTab && userTab !== targetTabKey) {
            flash(session, t("voice.insertedElsewhere"));
          }
        } catch (error) {
          depsReady = false;
          flash(session, `Voice: ${error?.message ?? String(error)}`);
        } finally {
          local.busy = false;
          local.cancelRequested = false;
          setPhase(session, "idle");
        }
      };

      // The server is shared by every window. Apply each session's state only
      // to that session's pill, leaving every other button free.
      const syncStatus = async () => {
        if (!Voice) return;
        try {
          const status = await ctx.client.rpc(Voice).status({});
          const sessions = status?.sessions ?? {};
          for (const [id, phase] of Object.entries(sessions)) {
            if (!localStates.get(id)?.busy) patchStatus(id, { phase });
          }
          for (const id of Object.keys(statuses())) {
            if (!sessions[id] && !localStates.get(id)?.busy && statusByID(id) !== "idle") {
              patchStatus(id, { phase: "idle" });
            }
          }
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
          show: (input) => {
            const session = input?.session ?? currentSession();
            const pending = noteOf(session);
            const current = phaseOf(session);

            if (pending) {
              return {
                icon: "outline-hexagonal-warning",
                label: `⚠ ${pending}`,
                tone: "danger",
                title: pending,
                run: () => void dictate(session),
              };
            }
            if (current === "setup") {
              return {
                icon: "outline-rotate-clockwise",
                label: t("voice.setup"),
                tone: "warning",
                title: t("voice.setupHint"),
                run: () => void dictate(session),
              };
            }
            if (current === "recording") {
              return {
                icon: "outline-audio",
                label: t("voice.recording"),
                tone: "danger",
                title: t("voice.recording"),
                run: () => void dictate(session),
              };
            }
            if (current === "processing") {
              return {
                icon: "outline-rotate-clockwise",
                label: t("voice.processing"),
                tone: "warning",
                title: t("voice.processing"),
                run: () => void dictate(session),
              };
            }
            return {
              icon: "outline-audio",
              label: t("voice.label"),
              title: t("voice.hint"),
              run: () => void dictate(session),
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
        if (statusTimer) clearInterval(statusTimer);
        for (const local of localStates.values()) {
          if (local.timer) clearTimeout(local.timer);
        }
        for (const [id, local] of localStates) {
          if (local.busy && Voice) {
            try {
              void ctx.client.rpc(Voice).stop({ sessionID: id === "default" ? undefined : id });
            } catch {
              /* the plugin is unloading */
            }
          }
        }
      };
    },
  });
}

module.exports = build();
