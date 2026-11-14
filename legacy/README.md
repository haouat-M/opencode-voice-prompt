# Legacy (v1) extras — optional

These files are **not** part of the plugin OpenCode loads. The plugin itself is
`../index.js` + `../gui-experimental.cjs` + `../scripts/engine.py`, and it puts
the microphone inside the OpenCode window.

Keep these only if you want the old workflows:

| File                        | What it is                                                        |
| --------------------------- | ----------------------------------------------------------------- |
| `floating_mic.py`           | Always-on-top circular mic widget that pastes with `Ctrl+V`. Needs `tkinter`, `keyboard`, `pyperclip`, `psutil`. Windows only (`winsound`, `user32`). |
| `opencode_voice.py`         | v1 helper that records and copies the text to the clipboard. Superseded by `scripts/engine.py`. |
| `Start_OpenCode_Voice.bat`  | Double-click launcher for `floating_mic.py`.                       |

```bash
pip install tkinter keyboard pyperclip psutil   # only for floating_mic.py
python legacy/floating_mic.py
```

Nothing here starts automatically. The plugin never launches these files.
