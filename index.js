import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "scripts", "engine.py");

const JSON_START = "__JSON_START__";
const JSON_END = "__JSON_END__";

const TRANSCRIBE_OUTPUT = {
  type: "object",
  properties: {
    text: { type: "string" },
    raw: { type: "string" },
    duration: { type: "number" },
    language: { type: "string" },
    error: { type: "string" },
  },
  required: ["text"],
};

/**
 * Token shared with the GUI part (gui-experimental.cjs). Both files must declare
 * the same id and the same method shapes.
 */
export const Voice = Rpc.define({
  id: "voice",
  methods: {
    transcribe: {
      input: {
        type: "object",
        properties: {
          language: { type: "string" },
          silence: { type: "number" },
          timeout: { type: "number" },
        },
      },
      output: TRANSCRIBE_OUTPUT,
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
  events: {},
});

function parseEngineOutput(stdout) {
  const start = stdout.lastIndexOf(JSON_START);
  const end = stdout.lastIndexOf(JSON_END);
  if (start === -1 || end === -1 || end < start) return undefined;

  const body = stdout.slice(start + JSON_START.length, end).trim();
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function pythonCandidates(options) {
  const list = [];

  // 1. Explicit plugin option from opencode.json.
  if (typeof options.python === "string" && options.python.trim()) {
    list.push(options.python.trim());
  }
  // 2. Environment override.
  if (process.env.OPENCODE_VOICE_PYTHON) {
    list.push(process.env.OPENCODE_VOICE_PYTHON);
  }
  // 3. Whatever is first on PATH (Windows also exposes "py").
  list.push("python");
  if (process.platform === "win32") list.push("py");

  return [...new Set(list)];
}

export default Plugin.define({
  id: "opencode-voice-prompt",

  async setup(ctx) {
    const options = ctx.options ?? {};

    const defaultLanguage = typeof options.language === "string" ? options.language : "ar-SA";
    const defaultSilence = typeof options.silenceSeconds === "number" ? options.silenceSeconds : 2.2;
    const defaultTimeout = typeof options.timeoutSeconds === "number" ? options.timeoutSeconds : 90;
    const execs = pythonCandidates(options);

    /** @type {import("node:child_process").ChildProcess | null} */
    let active = null;

    const record = (input) => {
      const request = input ?? {};

      return new Promise((resolve) => {
        if (active) {
          resolve({ text: "", error: "a recording is already in progress" });
          return;
        }
        if (!existsSync(ENGINE)) {
          resolve({ text: "", error: `voice engine not found at ${ENGINE}` });
          return;
        }

        const language =
          typeof request.language === "string" && request.language.trim()
            ? request.language.trim()
            : defaultLanguage;
        const silence = typeof request.silence === "number" ? request.silence : defaultSilence;
        const timeout = typeof request.timeout === "number" ? request.timeout : defaultTimeout;

        const args = [
          ENGINE,
          "--action",
          "record",
          "--language",
          language,
          "--silence",
          String(silence),
          "--timeout",
          String(timeout),
        ];

        let attempt = 0;
        let settled = false;

        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (active === child) active = null;
          resolve(result);
        };

        /** @type {import("node:child_process").ChildProcess | undefined} */
        let child;

        const launch = () => {
          const exe = execs[attempt];

          child = spawn(exe, args, {
            cwd: HERE,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
          });
          active = child;

          let stdout = "";
          let stderr = "";

          child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
          });
          child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
          });

          child.on("error", (error) => {
            // Try the next interpreter when this one does not exist.
            if (error && error.code === "ENOENT" && attempt + 1 < execs.length) {
              attempt += 1;
              active = null;
              launch();
              return;
            }
            finish({
              text: "",
              error: `could not start "${exe}": ${error?.message ?? String(error)}`,
            });
          });

          child.on("close", () => {
            const parsed = parseEngineOutput(stdout);

            if (parsed) {
              if (parsed.success === false) {
                finish({
                  text: "",
                  raw: parsed.raw_text ?? "",
                  duration: parsed.duration ?? 0,
                  language,
                  error: parsed.error || "no speech detected",
                });
                return;
              }
              finish({
                text: typeof parsed.text === "string" ? parsed.text : "",
                raw: parsed.raw_text ?? "",
                duration: parsed.duration ?? 0,
                language: parsed.language ?? language,
              });
              return;
            }

            const tail = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
            finish({
              text: "",
              language,
              error:
                tail ||
                "the voice engine returned no result (is python plus sounddevice and SpeechRecognition installed?)",
            });
          });
        };

        launch();
      });
    };

    try {
      await ctx.rpc.register(Voice, {
        transcribe: async (input) => record(input),
        stop: async () => {
          if (active?.stdin?.writable) {
            try {
              active.stdin.write("stop\n");
            } catch {
              /* the process may have exited between the check and the write */
            }
          }
          return { ok: true };
        },
        status: async () => {
          return { recording: active !== null };
        },
      });
    } catch (error) {
      console.error("[opencode-voice-prompt] could not register the voice RPC:", error);
    }

    // Also expose voice input as a model tool, so an agent can ask for dictation.
    try {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "voice_input",
          description:
            "Record the user's microphone, transcribe the speech, and return the text. Language defaults to the plugin configuration (ar-SA).",
          input: {
            type: "object",
            properties: {
              language: { type: "string", description: "BCP-47 language tag, e.g. ar-SA or en-US" },
            },
          },
          execute: async (input) => {
            const result = await record(input);
            return { content: result.text || `(no speech captured: ${result.error ?? "unknown error"})` };
          },
        });
      });
    } catch (error) {
      console.error("[opencode-voice-prompt] could not register the voice_input tool:", error);
    }
  },
});
