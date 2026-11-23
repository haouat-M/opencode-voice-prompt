# OpenCode Voice Prompt 🎙️

[![CI](https://github.com/haouat-M/opencode-voice-prompt/actions/workflows/ci.yml/badge.svg)](https://github.com/haouat-M/opencode-voice-prompt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-green.svg)](https://opencode.ai)
[![Platform](https://img.shields.io/badge/Platform-Windows%20(tested)-lightgrey.svg)]()
[![Python 3.8+](https://img.shields.io/badge/Python-3.8+-yellow.svg)](https://www.python.org/)

Hands-free voice dictation for **OpenCode Desktop**. The microphone control
lives inside the OpenCode window, right above the prompt composer, and the
transcribed text is written straight into the prompt you are writing — no
clipboard, no separate window, no pasting.

It ships Arabic/multilingual speech-to-text and automatic spoken developer-term
conversion (`Docker`, `GitHub`, `Python`, `React`, …).

**بالعربي:** زر الميكروفون يظهر داخل نافذة OpenCode فوق خانة الكتابة. اضغطه،
تكلّم، ثم اسكت ثانيتين — يظهر النص في نفس الخانة. أول تشغيل ينصّب مكتبات
بايثون تلقائياً.

---

## ✨ Features

- 🎙️ **In-app microphone pill** — `🎙 Voice` appears above the composer. Click to
  start; the mic icon turns red and clicking again stops early.
- ⌨️ **Keyboard and slash command** — `Ctrl/Cmd+Alt+A`, or `/voice` in the
  composer.
- ⏱️ **Pause-tolerant end of speech** — the recording does not stop on the
  first pause. Once the silence looks like an ending, the audio is transcribed
  in the background while the microphone stays open: if you continue, that guess
  is thrown away and recording goes on; if you really stopped, its text is
  inserted. A 2-second pause in the middle of a sentence is no longer cut.
- ⚡ **Fast turnaround** — a Google round trip is typically 1–3 seconds after
  speech ends.
- ✍️ **Writes into the prompt box** — uses `composer.insert(text)` and keeps the
  cursor in the prompt. The target session is captured *before* recording, so
  switching sessions mid-dictation cannot lose or misplace the text.
- 🌐 **Technical terminology correction** — spoken Arabic/English variants
  become exact English terms. Ambiguous everyday words such as «جيت» and «بوش»
  are only rewritten next to a real technical term, so normal dictation is not
  corrupted (`autoFixTerms` can turn the whole fixer off).
- 🧠 **Contextual correction** — before insertion, a model fixes recognition
  mistakes using the sentence context («كتب صندوق وطلعت كلمة تانية»). It keeps
  the speaker's own dialect and wording, never translates, and writes
  English-origin words in English script (إنجلش → `English`, دوكر → `Docker`).
  Falls back to the uncorrected text if the model is unavailable. Set
  `contextCorrection: false` to skip it.
- 🧩 **Native plugin architecture** — the server part registers the `voice` RPC
  (and an opt-in agent tool); the GUI part contributes the pill and command.
- 🪶 **Optional legacy widget** — `legacy/floating_mic.py` is kept for OpenCode
  CLI users; it never starts on its own.

---

## 🚀 Installation

### 1. Prerequisites

The only requirement is **Python 3.8+** on your `PATH`:

```bash
python --version
```

You do **not** need to install any Python package by hand. On the first
dictation the plugin checks for `SpeechRecognition`, `sounddevice` and `numpy`,
installs whatever is missing with pip, and then starts recording. That first run
takes a few extra seconds and needs an internet connection; later runs are
instant.

- **Linux:** `sounddevice` needs the PortAudio shared library, which pip cannot
  install:

  ```bash
  sudo apt install libportaudio2        # Debian/Ubuntu
  sudo dnf install portaudio            # Fedora
  ```

  You still need `python3-venv` if your distro blocks system pip installs
  (`sudo apt install python3-venv` on Debian/Ubuntu). Stock Ubuntu 24.04+ and
  26.04 ship `python3` **without pip**, so this is the normal path there.

- **macOS:** PortAudio is bundled with the `sounddevice` wheel, but the terminal
  running OpenCode needs microphone permission (System Settings → Privacy →
  Microphone).

- **Debian 12 / Ubuntu 23.04+ / Homebrew Python (PEP 668):** pip refuses to
  install into the system Python. The plugin detects this — and the related
  `No module named pip` case — creates a private environment under
  `~/.cache/opencode-voice-prompt/venv`, and installs there automatically. It
  reuses that interpreter for recordings. If the OS also blocks creating a venv,
  install `python3-venv` (Debian/Ubuntu) or point the `python` option at any
  working interpreter.

> Run `python scripts/engine.py --action doctor` to see exactly what is wrong:
> `missing` lists packages to install, while `import_errors` means the package is
> there but cannot load (usually a missing PortAudio library or no audio server).

> If `python` is not on your `PATH`, set it with the `python` plugin option or
> the `OPENCODE_VOICE_PYTHON` environment variable. `python3` is tried
> automatically on every platform.

### 2. Add the plugin to OpenCode

From the repository:

```bash
opencode plugin add github:haouat-M/opencode-voice-prompt
```

Or, from a local clone, use `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "package": "./plugins/opencode-voice-prompt",
      "options": { "language": "ar-SA", "silenceSeconds": 1.5 }
    }
  ]
}
```

Restart or reload the app (`opencode reload`) after changing the config.

---

## 🎤 Usage

1. Open a session in **OpenCode Desktop** and click into the prompt box.
2. Click the `Voice` pill above the input (or press `Ctrl+Alt+A`).
3. Speak your prompt; mention any programming keywords you like.
4. Stop speaking and stay quiet — the pill switches to «Transcribing…» once the
   silence is confirmed, and the text appears in the prompt. A short pause in
   the middle of a sentence is not treated as the end; if you keep talking, the
   guess made during the pause is discarded.

Stopping fast: click the pill (or press `Ctrl+Alt+A` again) right after your
last word — that ends the recording immediately and skips the silence wait.

The pill reflects the real server state, so a second OpenCode window shows
«Recording…» too; clicking it there stops the recording. If setup is running,
clicking the pill cancels it.

### Plugin options

| Option                      | Default                              | Meaning                                                                 |
| --------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `language`                  | `ar-SA`                              | BCP-47 language tag passed to the recognizer.                           |
| `silenceSeconds`            | `1.5`                                | Minimum silence before a recording may end (0.3–10). Pauses shorter than this are always tolerated; a bit more is added on top, and the wait grows after each mid-sentence pause that was detected. |
| `timeoutSeconds`            | `90`                                 | Hard limit for a single recording (5–300).                              |
| `python`                    | auto                                 | Interpreter used for `scripts/engine.py`.                               |
| `inputDevice`               | system default                       | Microphone index or (partial) name, e.g. `"USB"`.                       |
| `sampleRate`                | auto                                 | Force one rate; otherwise 48000 → 44100 → 32000 → 16000 is tried.       |
| `autoFixTerms`              | `true`                               | Set `false` to keep the raw transcription (useful for prose).           |
| `fixes`                     | `[]`                                 | Extra `[spoken, replacement]` pairs, e.g. `[["فاست", "Fast"]]`.         |
| `contextCorrection`         | `true`                               | Fix recognition mistakes in context before insertion; preserves dialect and meaning. |
| `correctionModel`           | `opencode/hy4-flash-free`             | Optional host model override: `{ "providerID": "…", "id": "…" }` or `"provider/id"`. |
| `allowAgentRecording`       | `false`                              | Expose the `voice_input` model tool (asks permission on every call).    |
| `allowBreakSystemPackages`  | `false`                              | Allow pip `--break-system-packages` if a private venv cannot be built.  |
| `venvPath`                  | `~/.cache/opencode-voice-prompt/venv` | Where the fallback environment is created.                              |

Environment overrides: `OPENCODE_VOICE_PYTHON`, `OPENCODE_VOICE_VENV`, and
`OPENCODE_VOICE_CORRECTION_MODEL` to pick a different host model.

The plugin contains **no API keys** and makes no third-party model calls of its
own. Correction uses the host application's model API, so each user's own
OpenCode setup and permissions apply.

Example with a USB microphone and custom terms:

```json
{
  "plugins": [
    {
      "package": "github:haouat-M/opencode-voice-prompt",
      "options": {
        "language": "ar-SA",
        "inputDevice": "USB",
        "fixes": [["فاست", "Fast"], ["سوبر بيس", "Supabase"]]
      }
    }
  ]
}
```

---

## 🔌 RPC and tool API

The server part exposes the `voice` RPC:

| Method       | Input                                | Output                                          |
| ------------ | ------------------------------------ | ----------------------------------------------- |
| `ensure`     | `{ force? }`                         | `{ ok, installed, missing?, python?, error? }`  |
| `transcribe` | `{ language?, silence?, timeout?, sessionID? }`  | `{ text, raw?, duration?, language?, code?, error? }` |
| `correct`    | `{ text, sessionID? }`                 | `{ text }` — run the contextual correction without opening the mic (test hook) |
| `stop`       | `{}`                                 | `{ ok }`                                        |
| `status`     | `{}`                                 | `{ recording, phase }`                          |

`ensure` verifies Python and the audio packages, installing anything missing on
the first call. `force: true` bypasses both the positive and the negative cache,
which is what an explicit click does. After the first success a normal call
returns `{ ok: true, installed: false }` in milliseconds.

Call it over HTTP, using the port reported by `opencode service status` (the
default is `4096`, not a fixed number):

```bash
PORT=4096
curl -X POST "http://127.0.0.1:$PORT/api/rpc/voice/status?directory=$PWD" \
  -H "Content-Type: application/json" -d '{"input":{}}'
```

On Windows PowerShell:

```powershell
$port = 4096
Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:$port/api/rpc/voice/status?directory=$PWD" `
  -ContentType "application/json" -Body '{"input":{}}'
```

If the service has authentication enabled, add its authorization header.

When `allowAgentRecording: true`, the same recording is available to agents as
the `voice_input` tool:

```json
{ "language": "ar-SA" }
```

---

## 🛠️ Supported Technical Terms

The built-in phonetics engine normalizes dozens of keywords, including:

- **Tools:** `Docker`, `Docker Compose`, `Kubernetes`, `Laragon`, `GitHub`,
  `GitLab`, `commit`, `push`, `Pull Request`, `branch`, `merge`
- **Web:** `React`, `Vue.js`, `Angular`, `Next.js`, `Nuxt.js`, `Laravel`,
  `Tailwind CSS`, `Bootstrap`, `Django`, `Flask`, `FastAPI`, `Express.js`,
  `NestJS`
- **Languages:** `Python`, `JavaScript`, `TypeScript`, `Node.js`, `PHP`,
  `HTML`, `CSS`, `C++`, `C#`, `Java`, `Rust`, `Go`, `Flutter`
- **Data:** `MySQL`, `PostgreSQL`, `SQLite`, `SQL`, `MongoDB`, `Redis`,
  `Supabase`, `Firebase`
- **Infra:** `Apache`, `Nginx`, `server`, `Frontend`, `Backend`, `Fullstack`,
  `Webhook`, `middleware`, `Component`, `refactor`, `debug`, `terminal`,
  `API`, `MCP`, `Prompt`, `Token`, `OpenCode`, `Antigravity`

Ambiguous everyday words (`جيت`, `بوش`, `رست`, `دارت`, `نست`) are only converted
when another technical term is nearby. For example, «اعمل كوميت وبعدها بوش على
جيت هاب» becomes «اعمل commit وبعدها push على GitHub», while «جيت على بالي»
stays untouched.

---

## 🔐 Privacy and permissions

- The microphone opens **only** when you click the pill, press the shortcut, run
  `/voice`, or explicitly allow the agent tool.
- Audio is sent to Google's free Web Speech endpoint by
  `SpeechRecognition.recognize_google`. No audio is written to disk by the
  plugin; it is buffered in memory as a WAV.
- With `contextCorrection` enabled, the **text** of the transcription (never the
  audio) is passed to the host application's model API for cleanup — preferably
  the focused session's transient generation, which uses the same host model and
  allowance as chat and is not written to the conversation. No key is stored or
  read by the plugin, and no third-party endpoint is contacted by the plugin
  itself. On any failure the uncorrected text is used. Disable the whole step
  with `contextCorrection: false`.
- The first dictation may run `pip install` for `SpeechRecognition`,
  `sounddevice` and `numpy`. On a PEP 668 system it creates a private venv in
  `~/.cache/opencode-voice-prompt/venv`.
- The `voice_input` tool is **off by default**. With
  `allowAgentRecording: true`, every tool call still goes through OpenCode's
  permission prompt (`voice.record` / `microphone`).
- No telemetry, no API keys, no account.

---

## 🩺 Troubleshooting

| Symptom | Fix |
| --- | --- |
| Pill shows `python was not found` | Install Python 3.8+, put it on `PATH`, or set `python` / `OPENCODE_VOICE_PYTHON`. |
| `"python" is the Microsoft Store alias` | Install Python from python.org, or disable the alias in Settings → Apps → App execution aliases. |
| `PEP 668` / `externally-managed-environment` | Install `python3-venv`; the plugin will build its own environment. Or set `python` to a virtualenv interpreter. |
| `No module named pip` (stock Ubuntu) | Run `sudo apt install python3-venv`; the plugin builds a private venv, since system pip is absent. |
| `the audio library is installed but cannot load: ... PortAudio` | Install `libportaudio2` (Debian/Ubuntu) and start PulseAudio/PipeWire. |
| `the audio system is not ready` | No usable input device (or a load failure); run the doctor command below and pick a device with `inputDevice`. |
| `Audio recording error: ...Blocking API not supported yet` | Old versions only; 2.2.0 uses callback capture and supports WDM-KS devices such as *Stereo Mix*. |
| `Audio recording error: ...` | The device rejected the format; set `sampleRate` to `44100` or `16000`, or choose another `inputDevice`. |
| Nothing is transcribed | Check the internet connection (Google STT is online), the language tag, and the microphone level. |

Run the engine diagnostics directly:

```bash
python scripts/engine.py --action doctor
python scripts/engine.py --action test
```

---

## 🧑‍💻 Development

```bash
npm run check          # node --check on both JavaScript parts
npm test               # Python unittest suite
python scripts/engine.py --action fix --text "دوكر كومبوز"
```

CI runs both commands on Ubuntu and Windows for Node 20/22 and Python 3.10/3.12.

### Project structure

```text
opencode-voice-prompt/
├── index.js                 # Server part: voice RPC + opt-in voice_input tool
├── gui-experimental.cjs      # GUI part: composer pill + /voice command
├── scripts/
│   └── engine.py             # Capture, silence detection, STT, term fixer
├── tests/
│   ├── test_fixer.py         # Term-fixer regressions (ordinary Arabic stays intact)
│   └── test_engine_cli.py    # JSON protocol / CLI smoke tests
├── .github/workflows/ci.yml
├── legacy/                   # Optional v1 extras, never loaded automatically
├── CHANGELOG.md
├── package.json
├── README.md
└── LICENSE
```

Only `index.js`, `gui-experimental.cjs` and `scripts/` are loaded by OpenCode;
`legacy/` is kept for people on the old floating-widget workflow.

---

## 🤝 Contributing

Contributions, issues and feature requests are welcome — see the
[issues page](https://github.com/haouat-M/opencode-voice-prompt/issues). Please
run `npm run check` and `npm test` before opening a pull request.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
