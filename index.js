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

const ENSURE_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    installed: { type: "boolean" },
    missing: { type: "array" },
    error: { type: "string" },
  },
  required: ["ok"],
};

/**
 * Token shared with the GUI part (gui-experimental.cjs). Both files must declare
 * the same id and the same method shapes.
 */
export const Voice = Rpc.define({
  id: "voice",
  methods: {
    ensure: {
      input: { type: "object", properties: {} },
      output: ENSURE_OUTPUT,
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
  // 3. Whatever is first on PATH. macOS and most Linux distributions ship
  //    "python3" without a "python" alias; Windows also exposes "py".
  list.push("python");
  if (process.platform === "win32") {
    list.push("py");
  } else {
    list.push("python3");
  }

  return [...new Set(list)];
}

/** Python packages the engine needs, in pip spelling. */
const PIP_PACKAGES = ["SpeechRecognition", "sounddevice", "numpy"];

/** A pip install can take a while on a cold machine. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** After a failed setup, wait this long before trying to install again. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Run a process and collect its output. Never rejects: a missing interpreter is
 * reported as `enoent` so the caller can try the next candidate.
 */
function spawnCapture(exe, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(exe, args, {
        cwd: HERE,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });
    } catch (error) {
      resolve({ enoent: true, code: -1, stdout, stderr: String(error?.message ?? error) });
      return;
    }

    if (options.timeout) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, options.timeout);
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish({
        enoent: error?.code === "ENOENT",
        code: -1,
        stdout,
        stderr: String(error?.message ?? error),
      });
    });

    child.on("close", (code) => {
      finish({ enoent: false, code: code ?? 0, stdout, stderr });
    });
  });
}

function lastLine(text) {
  return String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();
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

    /** Cached result of the last dependency check. */
    let deps = { ready: false, checked: false, error: "", missing: /** @type {string[]} */ ([]), at: 0 };

    /** Shared in-flight check so two clicks never run pip at the same time. */
    let ensureInFlight = null;

    const installDeps = async (exe, missing) => {
      const packages = missing.length ? missing : PIP_PACKAGES;
      const base = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input"];

      // A virtual environment refuses --user, so fall back to a plain install.
      for (const args of [
        [...base, "--user", ...packages],
        [...base, ...packages],
      ]) {
        const result = await spawnCapture(exe, args, { timeout: INSTALL_TIMEOUT_MS });
        if (result.code === 0) return { ok: true };
        const tail = lastLine(result.stderr);
        if (args.includes("--user")) continue;
        return { ok: false, error: tail || `pip exited with code ${result.code}` };
      }

      return { ok: false, error: "pip could not install the voice libraries" };
    };

    /**
     * Make sure python plus the audio packages are usable. Installs whatever is
     * missing on first use, then caches the answer.
     */
    const ensureDeps = async () => {
      if (deps.ready) return { ok: true, installed: false, missing: [] };
      if (!deps.ready && deps.checked && deps.error && Date.now() - deps.at < RETRY_AFTER_MS) {
        return { ok: false, installed: false, missing: deps.missing, error: deps.error };
      }
      if (!existsSync(ENGINE)) {
        deps = {
          ready: false,
          checked: true,
          at: Date.now(),
          missing: [],
          error: `voice engine not found at ${ENGINE}`,
        };
        return { ok: false, installed: false, missing: [], error: deps.error };
      }

      let exe;
      let doctor;
      let lastError = "";

      for (const candidate of execs) {
        const probe = await spawnCapture(candidate, [ENGINE, "--action", "doctor"], {
          timeout: 60_000,
        });
        if (probe.enoent) continue;
        const parsed = parseEngineOutput(probe.stdout);
        if (parsed) {
          exe = candidate;
          doctor = parsed;
          break;
        }
        lastError = lastLine(probe.stderr) || `"${candidate}" could not run the voice engine`;
      }

      if (!exe || !doctor) {
        deps = {
          ready: false,
          checked: true,
          at: Date.now(),
          missing: [],
          error:
            lastError ||
            "python was not found; install Python 3.8+ and put it on PATH (python or python3), or set OPENCODE_VOICE_PYTHON",
        };
        return { ok: false, installed: false, missing: [], error: deps.error };
      }

      if (doctor.ready) {
        deps = { ready: true, checked: true, at: Date.now(), missing: [], error: "" };
        return { ok: true, installed: false, missing: [] };
      }

      if (doctor.missing?.length) {
        const install = await installDeps(exe, doctor.missing);
        if (!install.ok) {
          deps = {
            ready: false,
            checked: true,
            at: Date.now(),
            missing: doctor.missing,
            error: install.error,
          };
          return {
            ok: false,
            installed: false,
            missing: doctor.missing,
            error: install.error,
          };
        }

        const recheck = await spawnCapture(exe, [ENGINE, "--action", "doctor"], { timeout: 60_000 });
        const after = parseEngineOutput(recheck.stdout);
        if (after?.ready) {
          deps = { ready: true, checked: true, at: Date.now(), missing: [], error: "" };
          return { ok: true, installed: true, missing: [] };
        }
      }

      const audioError = doctor.audio_error;
      const error = audioError
        ? `no microphone available: ${audioError}`
        : "the voice libraries are installed but the engine is not ready";

      deps = {
        ready: false,
        checked: true,
        at: Date.now(),
        missing: doctor.missing ?? [],
        error,
      };
      return { ok: false, installed: false, missing: deps.missing, error };
    };

    const ensureOnce = () => {
      if (!ensureInFlight) {
        ensureInFlight = ensureDeps().finally(() => {
          ensureInFlight = null;
        });
      }
      return ensureInFlight;
    };

    const record = async (input) => {
      const request = input ?? {};

      if (active) return { text: "", error: "a recording is already in progress" };
      if (!existsSync(ENGINE)) return { text: "", error: `voice engine not found at ${ENGINE}` };

      const ready = await ensureOnce();
      if (!ready.ok) {
        return { text: "", error: ready.error || "the voice dependencies are not installed" };
      }
      // A second call may have started while the dependency check was running.
      if (active) return { text: "", error: "a recording is already in progress" };

      return new Promise((resolve) => {
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
        ensure: async () => ensureOnce(),
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
