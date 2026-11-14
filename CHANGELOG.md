# Changelog

All notable changes to this project are documented here.

## 2.2.0 — 2026-11-14

Full review pass: correctness, packaging, documentation and tests.

### Fixed

- **Term fixer no longer corrupts ordinary Arabic.** `جيت`, `بوش`, `رست`,
  `دارت` and `نست` are only rewritten when another confident technical term is
  nearby. «جيت على بالي» stays Arabic; «اعمل كوميت وبعدها بوش على جيت هاب»
  still becomes «اعمل commit وبعدها push على GitHub».
- **One interpreter for setup and recording.** The interpreter that passes the
  doctor probe is cached and reused by `transcribe`, so a Microsoft Store alias
  or broken shim can no longer make `ensure` succeed while recording fails.
- **PEP 668 systems work again.** When pip reports
  `externally-managed-environment`, the plugin creates a private venv under
  `~/.cache/opencode-voice-prompt/venv` and installs there. A venv failure now
  gives an actionable message instead of the raw pip `hint:` line.
- **Ubuntu without pip is handled.** Stock Ubuntu ships `python3` with neither
  pip nor `ensurepip`, so every `pip` command used to fail with a dead end. The
  plugin now treats `No module named pip` as a reason to build the private venv
  too, and tells you to install `python3-venv` when the OS blocks that.
- **Devices that reject blocking reads work.** Capture now uses the PortAudio
  callback API with a bounded queue, so WDM-KS inputs such as *Stereo Mix* (which
  answer `Blocking API not supported yet`) record normally instead of failing.
- **Doctor separates "missing" from "broken".** A package that is installed but
  cannot import — `sounddevice` without `libportaudio2` — is reported under
  `import_errors` with the PortAudio hint, instead of being listed as missing and
  triggering a pointless reinstall.
- **Faster text insertion.** Dead air is now trimmed from both ends before the
  upload, the default silence dropped from 2.2 s to 1.5 s, and the dependency
  check is cached between clicks instead of re-probing the interpreter every
  time. The pill also shows «Transcribing…» as soon as the microphone closes, so
  the wait is visible instead of looking like a frozen recorder.
- **The recording no longer stops at a mid-sentence pause.** When the silence
  reaches the configured window, the engine starts transcribing the audio
  collected so far in a background thread but keeps the microphone open. If
  speech resumes, that guess is discarded and recording continues; only if the
  speaker stays quiet is its text used as the final result. The required
  silence grows by 0.3 s after each discarded guess, and a guessed transcript
  that ends on a connector («و», «and», «the», «في» …) is treated as unfinished
  and given more time. With `silenceSeconds: 1.3` a 2-second pause is now
  tolerated, and a real ending still lands in ~2.5–3 s instead of ~3.5 s because
  the transcription already ran during the wait.
- **No more stuck recordings.** A watchdog kills a hung transcription after
  `timeoutSeconds + 25` seconds, and Google requests use
  `recognizer.operation_timeout = 30`.
- **Composer captured before recording.** Text is inserted into the session that
  was focused when the pill was clicked, and a separating space is added when
  the prompt already ends with a word.
- **Retries work.** `ensure` accepts `force`, every explicit click forces a fresh
  check, the failure cache is 30 seconds, the success cache is 5 minutes, and a
  dependency failure during `transcribe` invalidates it immediately.
- **Timeouts are reported as failures.** A killed child now exits with `-1`
  instead of being treated as a successful `0`.
- **No silent microphone access for agents.** The `voice_input` tool is
  registered only with `allowAgentRecording: true` and asks for permission on
  every call.
- **Cleanup and status.** Unloading the plugin kills an active recorder, the GUI
  polls `status` so a second window shows the recording, and clicking the
  setup pill cancels setup.
- **Icons and tones.** The pill uses a supported icon, so the red/warning tone is
  visible while recording or preparing.
- **Windows interpreter edge cases.** `python3` is always a candidate, and the
  Microsoft Store alias is detected with a clear error.
- **Audio input improvements.** Sample-rate fallback (48000 → 44100 → 32000 →
  16000), `inputDevice` option, real speech-chunk counting, and leading silence
  trimming before upload.
- **Custom fixes are reachable.** `fixes` and `autoFixTerms` are passed through
  to `engine.py --custom-fixes-json` / `--no-auto-fix`.
- **Packaging.** `@opencode/plugin` is pinned to `^2.3.0`, `legacy/` is included
  in the npm file list, and `.gitignore` covers venvs, tarballs and caches.

### Added

- `tests/test_fixer.py` and `tests/test_engine_cli.py` (25 tests).
- GitHub Actions CI on Ubuntu and Windows.
- A privacy/permissions section and accurate troubleshooting in the README.

## 2.1.1 — 2026-11-13

- `python3` fallback for macOS and Linux.
- Moved v1 floating-widget files to `legacy/`.
- Platform notes in the README.

## 2.1.0 — 2026-11-12

- Automatic installation of the Python audio libraries on first use (`ensure`).

## 2.0.0 — 2026-11-11

- Native plugin: in-app composer pill, `voice` RPC, `voice_input` tool.
- Removed the automatic floating widget from the startup path.
