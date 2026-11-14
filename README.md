# OpenCode Voice Prompt 🎙️

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-green.svg)](https://opencode.ai)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()
[![Python 3.8+](https://img.shields.io/badge/Python-3.8+-yellow.svg)](https://www.python.org/)

Hands-free voice dictation for **OpenCode Desktop**. The microphone button lives
inside the OpenCode window, right above the prompt composer, and the transcribed
text is written straight into the prompt you are writing — no clipboard, no
separate window, no pasting.

It ships intelligent Arabic/multilingual speech-to-text and automatic spoken
developer-term conversion (`Docker`, `Git`, `Python`, `React`, …).

---

## ✨ Features

- 🎙️ **In-app microphone pill**:
  - A `🎙 Voice` pill is rendered inside the OpenCode window, directly above the
    prompt composer, by the plugin's GUI part.
  - Click it to start, click again (it turns red) to stop early.
- ⌨️ **Keyboard and slash command**:
  - `Ctrl/Cmd+Alt+A` starts/stops a dictation.
  - `/voice` in the composer does the same.
- ⏱️ **Natural silence detection**:
  - Recording finishes automatically after you pause for **2.2 seconds**.
- ⚡ **Fast turnaround**:
  - Transcription completes less than a second after speech ends.
- ✍️ **Writes into the prompt box**:
  - Text is inserted through the composer API (`composer.insert(text)`), so it
    lands where you are typing and keeps your cursor there.
- 🌐 **Technical terminology correction**:
  - Spoken developer keywords (including phonetic and localized variants) become
    exact English terms: `Docker`, `Git`, `GitHub`, `Python`, `React`,
    `Next.js`, `API`, `PostgreSQL`, `MySQL`, `Laragon`, …
- 🧩 **Native plugin architecture**:
  - Server part registers the `voice` RPC and the `voice_input` model tool.
  - GUI part contributes the composer pill and the command.
- 🪶 **Optional fallback widget**:
  - `floating_mic.py` still exists for OpenCode CLI users, but it never starts
    on its own; run it manually if you want it.

---

## 🚀 Installation & Getting Started

### 1. Prerequisites

Ensure **Python 3.8+** is installed:

```bash
python --version
```

Install the audio and speech libraries:

```bash
pip install SpeechRecognition sounddevice numpy
```

`pyperclip`, `keyboard`, `psutil` and `tkinter` are only needed by the optional
floating widget.

---

### 2. Add the plugin to OpenCode

Either install it as a package:

```bash
opencode plugin add github:haouat-M/opencode-voice-prompt
```

or point the config at a local checkout in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "package": "./plugins/opencode-voice-prompt",
      "options": { "language": "ar-SA", "silenceSeconds": 2.2 }
    }
  ]
}
```

Restart or reload the app (`opencode reload`) after changing the config.

---

### 3. Dictate

1. Open a session in **OpenCode Desktop** and click into the prompt box.
2. Click the `🎙 Voice` pill above the input (or press `Ctrl+Alt+A`).
3. Speak your prompt; mention any programming keywords you like.
4. Pause for ~2 seconds — recording stops, and the text appears in the prompt.

#### Plugin options

| Option           | Default  | Meaning                                        |
| ---------------- | -------- | ---------------------------------------------- |
| `language`       | `ar-SA`  | BCP-47 language tag passed to the recognizer.  |
| `silenceSeconds` | `2.2`    | Silence that ends a recording.                 |
| `timeoutSeconds` | `90`     | Hard limit for a single recording.             |
| `python`         | auto     | Interpreter used for `scripts/engine.py`.      |

The interpreter can also be set with `OPENCODE_VOICE_PYTHON`.

---

## 🗂️ Project Structure

```text
opencode-voice-prompt/
├── index.js               # Server part: voice RPC + voice_input tool
├── gui-experimental.cjs    # GUI part: composer pill + /voice command
├── scripts/
│   └── engine.py           # Recording, silence detection, STT, term fixer
├── floating_mic.py         # Optional standalone widget (manual start only)
├── Start_OpenCode_Voice.bat
├── package.json
└── README.md
```

---

## 🔌 RPC and tool API

The server part exposes the `voice` RPC:

| Method       | Input                             | Output                                        |
| ------------ | --------------------------------- | --------------------------------------------- |
| `transcribe` | `{ language?, silence?, timeout? }` | `{ text, raw?, duration?, language?, error? }` |
| `stop`       | `{}`                              | `{ ok }`                                       |
| `status`     | `{}`                              | `{ recording }`                                |

Call it over HTTP:

```bash
curl -X POST "http://127.0.0.1:28894/api/rpc/voice/status?directory=$PWD" \
  -H "Content-Type: application/json" -d '{"input":{}}'
```

The same recording is available to agents as the `voice_input` tool:

```json
{ "language": "ar-SA" }
```

---

## 🛠️ Supported Technical Terms

The built-in phonetics engine recognizes and normalizes dozens of keywords:

- `Docker`, `Docker Compose`, `Laragon`, `Git`, `GitHub`, `GitLab`
- `Python`, `JavaScript`, `TypeScript`, `React`, `Next.js`, `Vue`, `Node.js`
- `PostgreSQL`, `MySQL`, `MongoDB`, `Redis`, `SQLite`
- `Terminal`, `VS Code`, `Antigravity`, `OpenCode`, `API`, `Server`, `Database`

---

## 🤝 Contributing

Contributions, issues and feature requests are welcome — see the
[issues page](https://github.com/haouat-M/opencode-voice-prompt/issues).

---

## 📄 License

MIT — see [LICENSE](LICENSE).
