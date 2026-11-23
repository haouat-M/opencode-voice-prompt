import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";
import { buildCorrectionPrompt, parseCorrection } from "./correction.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "scripts", "engine.py");

const JSON_START = "__JSON_START__";
const JSON_END = "__JSON_END__";

/** Python packages the engine needs, in pip spelling. */
const PIP_PACKAGES = ["SpeechRecognition", "sounddevice", "numpy"];

/** A pip install can take a while on a cold machine. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** A failed setup is retried quickly; the user may have just fixed the cause. */
const RETRY_AFTER_MS = 30 * 1000;

/** A successful check is reused for this long before revalidating. */
const READY_TTL_MS = 5 * 60 * 1000;

/** Extra time the watchdog allows after the engine's own recording timeout. */
const WATCHDOG_GRACE_SECONDS = 40;

/** Maximum time allowed for the contextual correction model call. */
const CORRECTION_TIMEOUT_MS = 8000;

/** Correction runs through the host application's own model API — no keys. */
const DEFAULT_CORRECTION_MODEL = { providerID: "opencode", id: "hy4-flash-free" };

const PEP668_RE = /externally-managed-environment|EXTERNALLY-MANAGED/i;
const PIP_MISSING_RE = /No module named pip|pip is not installed|ensurepip is not available/i;
const STORE_STUB_RE =
  /Python was not found|Python est introuvable|Microsoft Store|App execution alias|لم يتم العثور على Python/i;
const DEPENDENCY_FAILURE_RE =
  /ModuleNotFoundError|No module named|ImportError|missing Python package|speech_recognition|sounddevice/i;

const ENSURE_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    installed: { type: "boolean" },
    missing: { type: "array" },
    python: { type: "string" },
    error: { type: "string" },
  },
  required: ["ok"],
};

const TRANSCRIBE_OUTPUT = {
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
};

/**
 * Token shared with the GUI part (gui-experimental.cjs). Both files must declare
 * the same id and the same method shapes.
 */
export const Voice = Rpc.define({
  id: "voice",
  methods: {
    ensure: {
      input: {
        type: "object",
        properties: {
          // Every explicit click asks for a fresh check, even after a failure.
          force: { type: "boolean" },
        },
      },
      output: ENSURE_OUTPUT,
    },
    transcribe: {
      input: {
        type: "object",
        properties: {
          language: { type: "string" },
          silence: { type: "number" },
          timeout: { type: "number" },
          // The focused session lets correction run through its transient
          // generation, which uses the same host model and allowance as chat.
          sessionID: { type: "string" },
        },
      },
      output: TRANSCRIBE_OUTPUT,
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

function lastLine(text) {
  return String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();
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
  //    "python3" without a "python" alias; Windows also exposes "py" and, less
  //    often, "python3" (Git Bash / MSYS).
  list.push("python");
  if (process.platform === "win32") list.push("py");
  list.push("python3");

  return [...new Set(list)];
}

function venvPython(directory) {
  return process.platform === "win32"
    ? path.join(directory, "Scripts", "python.exe")
    : path.join(directory, "bin", "python");
}

function resolveVenvPath(options) {
  const configured =
    (typeof options.venvPath === "string" && options.venvPath.trim()) ||
    process.env.OPENCODE_VOICE_VENV;
  if (configured) return path.resolve(HERE, configured);
  return path.join(homedir(), ".cache", "opencode-voice-prompt", "venv");
}

function normalizePath(value) {
  return String(value ?? "").replace(/[\\/]+$/, "").toLowerCase();
}

function sameExecutable(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return normalizePath(a) === normalizePath(b);
}

/**
 * Run a process and collect its output. Never rejects: a missing interpreter is
 * reported as `enoent` so the caller can try the next candidate.
 */
function spawnCapture(exe, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
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
      resolve({
        enoent: error?.code === "ENOENT",
        code: -1,
        stdout,
        stderr: String(error?.message ?? error),
      });
      return;
    }

    if (options.timeout) {
      timer = setTimeout(() => {
        // A killed child closes with code === null. Remember why, otherwise a
        // timeout would be reported as a successful exit code 0.
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, options.timeout);
      timer.unref?.();
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
      finish({
        enoent: false,
        code: timedOut ? -1 : code ?? 0,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

export default Plugin.define({
  id: "opencode-voice-prompt",

  async setup(ctx) {
    const options = ctx.options ?? {};

    const defaultLanguage = typeof options.language === "string" ? options.language : "ar-SA";
    const defaultSilence = numberOption(options.silenceSeconds, 1.5, 0.3, 10);
    const defaultTimeout = numberOption(options.timeoutSeconds, 90, 5, 300);
    const inputDevice =
      typeof options.inputDevice === "string" || typeof options.inputDevice === "number"
        ? String(options.inputDevice).trim()
        : "";
    const sampleRate = numberOption(options.sampleRate, 0, 0, 192000);
    const autoFixTerms = options.autoFixTerms !== false;
    const allowAgentRecording = options.allowAgentRecording === true;
    const allowBreakSystemPackages = options.allowBreakSystemPackages === true;
    const contextCorrection = options.contextCorrection !== false;
    const correctionModel = normalizeCorrectionModel(
      options.correctionModel ?? process.env.OPENCODE_VOICE_CORRECTION_MODEL,
    );
    const venvPath = resolveVenvPath(options);
    const execs = pythonCandidates(options);
    const cachedVenvPython = venvPython(venvPath);
    if (existsSync(cachedVenvPython)) execs.unshift(cachedVenvPython);

    const customFixes = normalizeFixes(options.fixes);

    /**
     * Every session owns its recorder. States stay apart even when the shared
     * microphone lets two sessions run at once.
     * @type {Map<string, { child: import("node:child_process").ChildProcess, phase: string }>}
     */
    const activeBySession = new Map();

    const sessionKey = (input) =>
      typeof input?.sessionID === "string" && input.sessionID ? input.sessionID : "default";

    /** Interpreter that passed the doctor probe, reused for recording. */
    let resolvedExe = null;

    /** Cached result of the last dependency check. */
    let deps = {
      ready: false,
      checked: false,
      error: "",
      missing: /** @type {string[]} */ ([]),
      at: 0,
    };

    /** Shared in-flight check so two clicks never run pip at the same time. */
    let ensureInFlight = null;

    const doctorArgs = () => {
      const args = [ENGINE, "--action", "doctor"];
      if (inputDevice) args.push("--device", inputDevice);
      return args;
    };

    const pipInstall = (exe, packages, extra = [], timeout = INSTALL_TIMEOUT_MS) => {
      return spawnCapture(
        exe,
        ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...extra, ...packages],
        { timeout },
      );
    };

    const describePipFailure = (result, exe) => {
      const stderr = String(result?.stderr ?? "");
      const output = `${result?.stdout ?? ""}\n${stderr}`;
      if (PEP668_RE.test(output)) return pep668Message(exe);
      if (STORE_STUB_RE.test(output)) return storeStubMessage(exe);
      if (PIP_MISSING_RE.test(output)) {
        return (
          `pip is not available for ${exe}. Run "${exe} -m ensurepip --upgrade", ` +
          `or install pip for that interpreter, then try again.`
        );
      }
      if (result?.timedOut) return `pip timed out after ${INSTALL_TIMEOUT_MS / 1000} seconds`;
      return lastLine(stderr) || lastLine(result?.stdout) || `pip exited with code ${result?.code ?? -1}`;
    };

    const installInVenv = async (exe, packages) => {
      const python = venvPython(venvPath);

      if (!existsSync(python)) {
        try {
          mkdirSync(path.dirname(venvPath), { recursive: true });
        } catch {
          /* the venv tool reports the real error below */
        }
        const create = await spawnCapture(exe, ["-m", "venv", venvPath], { timeout: 2 * 60 * 1000 });
        if (create.code !== 0) {
          // On Debian/Ubuntu the venv failure is printed to stdout, not stderr.
          const output = `${create.stdout ?? ""}\n${create.stderr ?? ""}`;
          const summary =
            output
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find((line) => /not created successfully|No module named venv|ensurepip/i.test(line)) ||
            lastLine(output) ||
            `exit code ${create.code}`;
          const hint = /ensurepip|python3-venv|venv module|No module named venv|not created successfully/i.test(
            output,
          )
            ? ` Install the venv support for ${exe} first ("sudo apt install python3-venv" on Debian/Ubuntu provides ensurepip), or set the "python" option to a working interpreter.`
            : ` Install the venv support for ${exe}, or set the "python" option to a working interpreter.`;
          return {
            ok: false,
            error: `could not create a private Python environment at ${venvPath}: ${summary}.${hint}`,
          };
        }
      }

      const result = await pipInstall(python, packages);
      if (result.code === 0) return { ok: true, python };
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (PIP_MISSING_RE.test(output)) {
        return {
          ok: false,
          error:
            `the private environment at ${venvPath} exists but has no pip. ` +
            `Delete that folder, install python3-venv ("sudo apt install python3-venv") so it can be recreated, then try again.`,
        };
      }
      return { ok: false, error: describePipFailure(result, python) };
    };

    const installDeps = async (exe, missing) => {
      const packages = missing.length ? missing : PIP_PACKAGES;
      let last = null;
      let needsVenv = false;

      // A virtual environment refuses --user, so fall back to a plain install.
      for (const extra of [["--user"], []]) {
        const result = await pipInstall(exe, packages, extra);
        if (result.code === 0) return { ok: true, python: exe };
        last = result;
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        // On a PEP 668 interpreter both attempts fail with the same hint; go
        // straight to the private environment instead of repeating it.
        if (PEP668_RE.test(output)) {
          needsVenv = true;
          break;
        }
        // Ubuntu ships python3 without pip and without ensurepip, so no pip
        // command can succeed there; a private environment is the only way.
        if (PIP_MISSING_RE.test(output)) {
          needsVenv = true;
          break;
        }
        if (extra.length) continue;
      }

      if (needsVenv) {
        const venv = await installInVenv(exe, packages);
        if (venv.ok) return venv;

        // Explicit opt-in only: never weaken the OS protection silently. This
        // cannot rescue a missing pip, so it only applies to PEP 668.
        const lastOutput = `${last?.stdout ?? ""}\n${last?.stderr ?? ""}`;
        if (allowBreakSystemPackages && PEP668_RE.test(lastOutput)) {
          const forced = await pipInstall(exe, packages, ["--break-system-packages"]);
          if (forced.code === 0) return { ok: true, python: exe };
          return { ok: false, error: describePipFailure(forced, exe) };
        }
        return venv;
      }

      return { ok: false, error: describePipFailure(last, exe) };
    };

    const invalidateDeps = (reason) => {
      deps = {
        ready: false,
        checked: false,
        error: reason || "",
        missing: [],
        at: 0,
      };
      resolvedExe = null;
    };

    /**
     * Make sure python plus the audio packages are usable. Installs whatever is
     * missing on first use, then caches the answer briefly. `force` skips both
     * the positive and the negative cache, which is what an explicit click does.
     */
    const ensureDeps = async (force = false) => {
      const now = Date.now();

      if (!force && deps.ready && now - deps.at < READY_TTL_MS) {
        return { ok: true, installed: false, missing: [], python: resolvedExe ?? undefined };
      }
      if (!force && deps.checked && !deps.ready && deps.error && now - deps.at < RETRY_AFTER_MS) {
        return {
          ok: false,
          installed: false,
          missing: deps.missing,
          python: resolvedExe ?? undefined,
          error: deps.error,
        };
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
      let fallback = null;
      let lastError = "";

      for (const candidate of execs) {
        const probe = await spawnCapture(candidate, doctorArgs(), { timeout: 60_000 });
        const parsed = parseEngineOutput(probe.stdout);

        if (probe.enoent) {
          lastError = `"${candidate}" was not found`;
          continue;
        }
        if (!parsed && isStoreStub(probe)) {
          lastError = storeStubMessage(candidate);
          continue;
        }
        if (!parsed) {
          lastError =
            lastLine(probe.stderr) ||
            (probe.timedOut
              ? `"${candidate}" did not answer in 60 seconds`
              : `"${candidate}" could not run the voice engine`);
          continue;
        }

        if (parsed.ready) {
          exe = candidate;
          doctor = parsed;
          break;
        }

        // Keep looking for a ready interpreter (for example a private venv
        // from an earlier PEP 668 install) before settling on this one.
        if (!fallback || (fallback.parsed.missing?.length && !parsed.missing?.length)) {
          fallback = { candidate, parsed };
        }
      }

      if (!exe && fallback) {
        exe = fallback.candidate;
        doctor = fallback.parsed;
      }

      if (exe && doctor) {
        // The shim may resolve to a different absolute interpreter; caching the
        // resolved path keeps `ensure` and `transcribe` on the same one.
        resolvedExe = doctor.executable || exe;
      }

      if (!exe || !doctor) {
        deps = {
          ready: false,
          checked: true,
          at: Date.now(),
          missing: [],
          error:
            lastError ||
            "python was not found; install Python 3.10+ and put it on PATH (python or python3), or set OPENCODE_VOICE_PYTHON",
        };
        return { ok: false, installed: false, missing: [], error: deps.error };
      }

      if (doctor.ready) {
        deps = { ready: true, checked: true, at: Date.now(), missing: [], error: "" };
        return { ok: true, installed: false, missing: [], python: resolvedExe ?? undefined };
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

        if (install.python) resolvedExe = install.python;

        // Recheck with the interpreter that actually received the packages.
        const recheckExe = install.python || exe;
        const recheck = await spawnCapture(recheckExe, doctorArgs(), { timeout: 60_000 });
        const after = parseEngineOutput(recheck.stdout);

        if (after?.executable) resolvedExe = after.executable;

        if (after?.ready) {
          deps = { ready: true, checked: true, at: Date.now(), missing: [], error: "" };
          return { ok: true, installed: true, missing: [], python: resolvedExe ?? undefined };
        }

        const audioError = after?.audio_error || doctor.audio_error;
        const error = audioError
          ? `the audio system is not ready: ${audioError}`
          : `the voice libraries were installed but the engine is not ready` +
            (after?.missing?.length ? ` (missing: ${after.missing.join(", ")})` : "");

        deps = {
          ready: false,
          checked: true,
          at: Date.now(),
          missing: after?.missing ?? doctor.missing ?? [],
          error,
        };
        return { ok: false, installed: false, missing: deps.missing, error };
      }

      const audioError = doctor.audio_error;
      const error = audioError
        ? `the audio system is not ready: ${audioError}`
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

    const ensureOnce = (force = false) => {
      // A check already in flight is the freshest answer available; starting a
      // second one would run two pip processes at the same time.
      if (ensureInFlight) return ensureInFlight;

      const pending = ensureDeps(force).finally(() => {
        if (ensureInFlight === pending) ensureInFlight = null;
      });
      ensureInFlight = pending;
      return pending;
    };

    /**
     * Fix recognition mistakes in context without translating, changing the
     * speaker's dialect, or inventing content. English-origin words are written
     * in Latin script. Any failure simply returns the engine's own text.
     */
    const correctText = async (text, sessionID) => {
      if (!contextCorrection || !text) return text;
      const prompt = buildCorrectionPrompt(text, customFixes);
      let raw = "";

      // Preferred: the focused session's transient generation. It uses the
      // host model and the session's allowance, and is not written to history.
      // This correction step ships no keys and talks to no third-party endpoint.
      try {
        if (sessionID && typeof ctx.session?.generate === "function") {
          const answer = await withTimeout(
            ctx.session.generate({ sessionID, prompt }),
            CORRECTION_TIMEOUT_MS,
          );
          raw = typeof answer === "string" ? answer : answer?.text;
        }
      } catch (error) {
        console.error(
          "[opencode-voice-prompt] session correction failed:",
          error?.message ?? String(error),
        );
      }

      // Fallback: the host's experimental generate API, when there is no session.
      if (!parseCorrection(raw, text)) {
        const generate =
          typeof ctx.experimental?.generate?.text === "function"
            ? ctx.experimental.generate.text.bind(ctx.experimental.generate)
            : typeof ctx.generate?.text === "function"
              ? ctx.generate.text.bind(ctx.generate)
              : null;
        if (generate) {
          try {
            const answer = await withTimeout(
              generate({
                prompt,
                model: correctionModel ?? DEFAULT_CORRECTION_MODEL,
              }),
              CORRECTION_TIMEOUT_MS,
            );
            raw = typeof answer === "string" ? answer : answer?.text;
          } catch (error) {
            console.error(
              "[opencode-voice-prompt] host correction failed:",
              error?.message ?? String(error),
            );
          }
        }
      }

      const corrected = parseCorrection(raw, text);
      if (!corrected) {
        console.error(
          "[opencode-voice-prompt] correction reply rejected:",
          JSON.stringify(raw ?? null).slice(0, 500),
        );
      }
      return corrected || text;
    };

    const record = async (input) => {
      const request = input ?? {};

      const key = sessionKey(request);
      if (activeBySession.has(key)) return { text: "", error: "a recording is already in progress" };
      if (!existsSync(ENGINE)) return { text: "", error: `voice engine not found at ${ENGINE}` };

      const ready = await ensureOnce();
      if (!ready.ok) {
        return { text: "", error: ready.error || "the voice dependencies are not installed" };
      }
      // A second call may have started while the dependency check was running.
      if (activeBySession.has(key)) return { text: "", error: "a recording is already in progress" };

      return new Promise((resolve) => {
        const language =
          typeof request.language === "string" && request.language.trim()
            ? request.language.trim()
            : defaultLanguage;
        const silence = numberOption(request.silence, defaultSilence, 0.3, 10);
        const timeout = numberOption(request.timeout, defaultTimeout, 5, 300);

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
        if (inputDevice) args.push("--device", inputDevice);
        if (sampleRate > 0) args.push("--sample-rate", String(sampleRate));
        if (customFixes.length) args.push("--custom-fixes-json", JSON.stringify(customFixes));
        if (!autoFixTerms) args.push("--no-auto-fix");

        let attempt = 0;
        let settled = false;

        /** @type {import("node:child_process").ChildProcess | undefined} */
        let child;
        /** @type {NodeJS.Timeout | undefined} */
        let killer;

        let entry;

        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (killer) clearTimeout(killer);
          if (entry && activeBySession.get(key) === entry) activeBySession.delete(key);
          resolve(result);
        };

        const launch = () => {
          const exe = resolvedExe ?? execs[attempt] ?? execs[0];

          child = spawn(exe, args, {
            cwd: HERE,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
          });
          entry = { child, phase: "recording" };
          activeBySession.set(key, entry);

          // A hung network request must not poison the plugin forever: without
          // this, the session would stay busy and later dictations there would
          // be rejected with "a recording is already in progress".
          killer = setTimeout(() => {
            try {
              child?.kill();
            } catch {
              /* already gone */
            }
            finish({
              text: "",
              language,
              error: `the speech service did not respond within ${timeout + WATCHDOG_GRACE_SECONDS} seconds`,
            });
          }, (timeout + WATCHDOG_GRACE_SECONDS) * 1000);
          killer.unref?.();

          let stdout = "";
          let stderr = "";

          child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
            // The engine streams progress markers before the JSON result, so
            // the pill can say "transcribing" while the network call runs.
            // Matching on the accumulated text avoids false negatives when a
            // marker is split across two chunks.
            if (stdout.includes("__STATUS_PROCESSING__") && entry) entry.phase = "processing";
          });
          child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
          });

          child.on("error", (error) => {
            if (settled) return;
            if (sameExecutable(exe, resolvedExe)) resolvedExe = null;
            // Try the next interpreter when this one does not exist.
            if (error?.code === "ENOENT" && attempt + 1 < execs.length) {
              attempt += 1;
              activeBySession.delete(key);
              launch();
              return;
            }
            finish({
              text: "",
              error: `could not start "${exe}": ${error?.message ?? String(error)}`,
            });
          });

          child.on("close", async () => {
            if (settled) return;
            const parsed = parseEngineOutput(stdout);

            if (parsed) {
              const failure = parsed.success === false;
              const errorText = failure ? parsed.error || "no speech detected" : "";

              if (failure) {
                const dependencyFailure =
                  parsed.code === "DEPENDENCY_ERROR" || DEPENDENCY_FAILURE_RE.test(errorText);
                if (dependencyFailure) invalidateDeps(errorText);
                finish({
                  text: "",
                  raw: parsed.raw_text ?? "",
                  duration: parsed.duration ?? 0,
                  language,
                  code: parsed.code,
                  error: errorText,
                });
                return;
              }

              // Remember the interpreter that actually produced a result.
              resolvedExe = exe;

              // The engine has exited. Stop its watchdog before the model
              // call, so a slow model cannot be killed and leave the RPC stuck.
              if (killer) {
                clearTimeout(killer);
                killer = null;
              }

              const original = typeof parsed.text === "string" ? parsed.text : "";
              const corrected = await correctText(original, request.sessionID);
              finish({
                text: corrected,
                raw: parsed.raw_text ?? "",
                duration: parsed.duration ?? 0,
                language: parsed.language ?? language,
              });
              return;
            }

            const combined = `${stderr}\n${stdout}`;
            if (DEPENDENCY_FAILURE_RE.test(combined)) {
              invalidateDeps(lastLine(stderr));
            }

            // A Store stub can exist on PATH without being a working Python.
            if (attempt + 1 < execs.length && isStoreStub({ stdout, stderr })) {
              if (sameExecutable(exe, resolvedExe)) resolvedExe = null;
              attempt += 1;
              activeBySession.delete(key);
              launch();
              return;
            }

            finish({
              text: "",
              language,
              error:
                lastLine(stderr) ||
                "the voice engine returned no result (is python plus sounddevice and SpeechRecognition installed?)",
            });
          });
        };

        launch();
      });
    };

    try {
      await ctx.rpc.register(Voice, {
        ensure: async (input) => ensureOnce(input?.force === true),
        transcribe: async (input) => record(input),
        // Test/debug hook: run the correction step without opening the mic.
        correct: async (input) => ({
          text: await correctText(
            typeof input?.text === "string" ? input.text : "",
            typeof input?.sessionID === "string" ? input.sessionID : undefined,
          ),
        }),
        stop: async (input) => {
          const key = typeof input?.sessionID === "string" ? input.sessionID : undefined;
          const entries = key ? [activeBySession.get(key)].filter(Boolean) : [...activeBySession.values()];
          for (const item of entries) {
            if (item.child.stdin?.writable) {
              try {
                item.child.stdin.write("stop\n");
              } catch {
                /* the process may have exited between the check and the write */
              }
            }
          }
          return { ok: true };
        },
        status: async () => {
          const sessions = {};
          for (const [id, item] of activeBySession) sessions[id] = item.phase || "recording";
          return {
            recording: activeBySession.size > 0,
            phase: [...activeBySession.values()][0]?.phase || "idle",
            sessions,
          };
        },
      });
    } catch (error) {
      console.error("[opencode-voice-prompt] could not register the voice RPC:", error);
    }

    // The agent-facing tool can open the microphone, so it is opt-in and asks
    // for permission on every call.
    if (allowAgentRecording) {
      try {
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "voice_input",
            description:
              "Record the user's microphone, transcribe the speech, and return the text. " +
              "Use it only when the user explicitly asks for dictation. Language defaults to the plugin configuration (ar-SA).",
            input: {
              type: "object",
              properties: {
                language: { type: "string", description: "BCP-47 language tag, e.g. ar-SA or en-US" },
              },
              additionalProperties: false,
            },
            execute: async (input, context) => {
              if (ctx.permission?.assert && context?.sessionID) {
                await ctx.permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                  action: "voice.record",
                  resources: ["microphone"],
                  save: ["voice.record"],
                });
              }

              const result = await record(input);
              return {
                content: result.text || `(no speech captured: ${result.error ?? "unknown error"})`,
              };
            },
          });
        });
      } catch (error) {
        console.error("[opencode-voice-prompt] could not register the voice_input tool:", error);
      }
    }

    // Kill an in-flight recorder when the plugin unloads or reloads. Without
    // this the microphone could stay open with no UI left to stop it.
    return () => {
      for (const item of activeBySession.values()) {
        try {
          item.child.kill();
        } catch {
          /* already gone */
        }
      }
      activeBySession.clear();
    };
  },
});

function numberOption(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Resolve a correction model given as {providerID,id} or "provider/id". */
function normalizeCorrectionModel(value) {
  if (value && typeof value === "object") {
    const { providerID, id } = value;
    return typeof providerID === "string" && typeof id === "string"
      ? { providerID, id }
      : undefined;
  }
  if (typeof value === "string") {
    const [providerID, id] = value.split("/", 2);
    if (providerID && id) return { providerID, id };
  }
  return undefined;
}

/** Never let a slow host model call hold the dictation RPC open indefinitely. */
function withTimeout(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeFixes(value) {
  if (!Array.isArray(value)) return [];
  const fixes = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [spoken, replacement] = item;
    if (typeof spoken !== "string" || !spoken || typeof replacement !== "string" || !replacement) {
      continue;
    }
    fixes.push([spoken, replacement]);
  }
  return fixes;
}

function isStoreStub(result) {
  return STORE_STUB_RE.test(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`);
}

function storeStubMessage(exe) {
  return (
    `"${exe}" is the Microsoft Store alias for Python, which is not a working interpreter. ` +
    `Install Python from python.org (or disable the alias in Settings > Apps > App execution aliases), ` +
    `or set the "python" plugin option to a real python.exe.`
  );
}

function pep668Message(exe) {
  return (
    `"${exe}" is managed by the operating system (PEP 668), so pip cannot install into it. ` +
    `The plugin tried to create a private environment instead; if that also failed, install python3-venv ` +
    `(Debian/Ubuntu) or set the "python" option to a virtualenv interpreter.`
  );
}
