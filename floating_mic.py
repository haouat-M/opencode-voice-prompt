"""Optional floating microphone widget for OpenCode Desktop.

This is a fallback for people who prefer a button outside the app. The primary
integration lives inside OpenCode (see gui-experimental.cjs), because a floating
top-level window can only *hover over* the app, never live inside it.

Fixes over the previous version:
  * One instance only (named mutex), instead of one per plugin reload.
  * The button never takes keyboard focus (WS_EX_NOACTIVATE), so the text is
    pasted into the OpenCode prompt instead of into the widget.
  * Position comes from the live window rectangle, not a stale saved geometry,
    so it stays inside the window when you move or maximise it.
  * The button hides itself while OpenCode is minimised or closed.
"""

import ctypes
import glob
import io
import json
import os
import sys
import threading
import time
import wave

import numpy as np
import sounddevice as sd
import speech_recognition as sr
import tkinter as tk
import winsound

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.append(os.path.join(os.path.dirname(__file__), "scripts"))
try:
    from engine import apply_fixes
except Exception:  # pragma: no cover - the widget still works without the fixer
    def apply_fixes(text):
        return text


user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

GWL_EXSTYLE = -20
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TOPMOST = 0x00000008
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_FRAMECHANGED = 0x0020
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = -1
ERROR_ALREADY_EXISTS = 183

MUTEX_NAME = "Local\\OpenCodeVoicePromptFloatingMic"


def enable_dpi_awareness():
    """Make window coordinates and the widget agree on physical pixels."""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per monitor v2
        return
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def acquire_single_instance():
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        return None
    return handle


def process_image_name(hwnd):
    pid = ctypes.wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def find_opencode_window():
    """Return the HWND of the largest visible OpenCode top-level window."""
    import psutil

    targets = set()
    for proc in psutil.process_iter(["pid", "name"]):
        name = (proc.info.get("name") or "").lower()
        if name in ("opencode.exe", "opencode"):
            targets.add(proc.info["pid"])
    if not targets:
        return None

    best = None
    best_area = 0

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    def enum_proc(hwnd, _lparam):
        nonlocal best, best_area
        if not user32.IsWindowVisible(hwnd):
            return True
        if process_image_name(hwnd) not in targets:
            return True
        rect = ctypes.wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        width = rect.right - rect.left
        height = rect.bottom - rect.top
        if width < 200 or height < 200:
            return True
        area = width * height
        if area > best_area:
            best_area = area
            best = (hwnd, rect.left, rect.top, width, height)
        return True

    user32.EnumWindows(enum_proc, 0)
    return best


def saved_window_bounds():
    """Fallback geometry when the window cannot be enumerated yet."""
    try:
        pattern = os.path.expanduser(r"~\AppData\Roaming\ai.opencode.desktop\window-state-*.json")
        for path in sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True):
            with open(path, "r", encoding="utf-8") as handle:
                state = json.load(handle)
            if state.get("width") and state.get("height"):
                return (
                    state.get("x", 320),
                    state.get("y", 116),
                    state.get("width", 1280),
                    state.get("height", 800),
                )
    except Exception:
        pass
    return 320, 116, 1280, 800


class FloatingMic:
    SIZE = 34
    # Distance from the bottom-left corner of the OpenCode window, where the
    # prompt composer sits next to the "+" button.
    OFFSET_X = 14
    OFFSET_BOTTOM = 58

    def __init__(self):
        self.language = "ar-SA"
        self.silence_seconds = 2.2
        self.sample_rate = 16000
        self.block_size = 1024
        self.silence_threshold = 0.014
        self.is_recording = False
        self.stop_requested = False
        self.recognizer = sr.Recognizer()
        self.last_rect = None

        self.root = tk.Tk()
        self.root.title("OpenCode Voice")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.97)

        self.canvas = tk.Canvas(
            self.root,
            width=self.SIZE,
            height=self.SIZE,
            bg="#18181b",
            highlightthickness=0,
            cursor="hand2",
        )
        self.canvas.pack(fill=tk.BOTH, expand=True)

        pad = 2
        self.circle = self.canvas.create_oval(
            pad, pad, self.SIZE - pad, self.SIZE - pad,
            fill="#27272a", outline="#3f3f46", width=1,
        )
        self.icon = self.canvas.create_text(
            self.SIZE // 2, self.SIZE // 2,
            text="🎙", font=("Segoe UI Emoji", 12), fill="white",
        )

        self.canvas.bind("<Button-1>", lambda _event: self.toggle())
        self.canvas.bind("<Button-3>", self.show_menu)

        self.menu = tk.Menu(self.root, tearoff=0)
        self.menu.add_command(label="Arabic (ar-SA)", command=lambda: self.set_language("ar-SA"))
        self.menu.add_command(label="English (en-US)", command=lambda: self.set_language("en-US"))
        self.menu.add_command(label="French (fr-FR)", command=lambda: self.set_language("fr-FR"))
        self.menu.add_separator()
        self.menu.add_command(label="Exit", command=self.root.destroy)

        self.root.update_idletasks()
        self.make_non_activating()
        self.position_over_opencode()

        try:
            import keyboard

            keyboard.add_hotkey("ctrl+alt+a", self.toggle_from_hotkey)
        except Exception:
            pass

        self.root.after(400, self.track_opencode_window)

    # ------------------------------------------------------------------ window
    def make_non_activating(self):
        """Stop the widget from stealing focus when it is clicked."""
        try:
            hwnd = user32.GetParent(self.root.winfo_id()) or self.root.winfo_id()
            style = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
            user32.SetWindowLongPtrW(
                hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST
            )
            user32.SetWindowPos(
                hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
        except Exception:
            pass

    def position_over_opencode(self):
        found = find_opencode_window()
        if found:
            _hwnd, left, top, width, height = found
            rect = (left, top, width, height)
        else:
            rect = saved_window_bounds()

        if rect == self.last_rect:
            return

        self.last_rect = rect
        left, top, width, height = rect
        x = left + self.OFFSET_X
        y = top + height - self.OFFSET_BOTTOM
        self.root.geometry(f"{self.SIZE}x{self.SIZE}+{x}+{y}")

    def track_opencode_window(self):
        try:
            found = find_opencode_window()

            if not found:
                self.root.withdraw()
            else:
                hwnd, _left, _top, _width, _height = found
                if user32.IsIconic(hwnd):
                    self.root.withdraw()
                else:
                    self.root.deiconify()
                    self.position_over_opencode()
        except Exception:
            pass

        self.root.after(500, self.track_opencode_window)

    # ---------------------------------------------------------------- controls
    def set_language(self, language):
        self.language = language
        try:
            winsound.Beep(1400, 100)
        except Exception:
            pass

    def show_menu(self, event):
        try:
            self.menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.menu.grab_release()

    def toggle_from_hotkey(self):
        self.root.after(0, self.toggle)

    def toggle(self):
        if self.is_recording:
            self.stop_requested = True
            return
        self.set_state_recording()
        threading.Thread(target=self.record_worker, daemon=True).start()

    def set_state_recording(self):
        self.is_recording = True
        self.stop_requested = False
        self.canvas.itemconfig(self.circle, fill="#ef4444", outline="#dc2626")
        self.canvas.itemconfig(self.icon, text="●")
        self.beep(1200, 80)

    def set_state_processing(self):
        self.canvas.itemconfig(self.circle, fill="#f59e0b", outline="#d97706")
        self.canvas.itemconfig(self.icon, text="…")

    def set_state_idle(self):
        self.is_recording = False
        self.stop_requested = False
        self.canvas.itemconfig(self.circle, fill="#27272a", outline="#3f3f46")
        self.canvas.itemconfig(self.icon, text="🎙")
        self.beep(800, 80)

    def beep(self, frequency, duration):
        try:
            winsound.Beep(frequency, duration)
        except Exception:
            pass

    # --------------------------------------------------------------- recording
    def record_worker(self):
        chunks = []
        speech = False
        silent = 0
        noise_floor = 0.01
        chunk_seconds = self.block_size / self.sample_rate
        max_silent = int(self.silence_seconds / chunk_seconds)
        min_speech = int(0.35 / chunk_seconds)
        max_chunks = int(90 / chunk_seconds)

        try:
            with sd.InputStream(
                samplerate=self.sample_rate, channels=1,
                blocksize=self.block_size, dtype="float32",
            ) as stream:
                for _ in range(max_chunks):
                    if self.stop_requested:
                        break
                    data, _overflow = stream.read(self.block_size)
                    block = data[:, 0]
                    chunks.append(block.copy())

                    rms = float(np.sqrt(np.mean(block ** 2)))
                    if rms < noise_floor:
                        noise_floor = noise_floor * 0.9 + rms * 0.1
                    elif not speech:
                        noise_floor = noise_floor * 0.995 + rms * 0.005
                    threshold = max(0.008, min(self.silence_threshold, noise_floor * 2.0))

                    if rms > threshold:
                        speech = True
                        silent = 0
                    elif speech:
                        silent += 1
                        if silent >= max_silent and len(chunks) >= min_speech:
                            break
        except Exception:
            self.root.after(0, self.set_state_idle)
            return

        if not speech:
            self.root.after(0, self.set_state_idle)
            return

        self.root.after(0, self.set_state_processing)

        audio = np.concatenate(chunks, axis=0)
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            wav.writeframes(pcm.tobytes())
        buffer.seek(0)

        try:
            with sr.AudioFile(buffer) as source:
                recording = self.recognizer.record(source)
                raw = self.recognizer.recognize_google(recording, language=self.language)
            text = apply_fixes(raw)
            if text:
                self.insert_into_prompt(text)
        except Exception:
            self.beep(600, 200)

        self.root.after(0, self.set_state_idle)

    def insert_into_prompt(self, text):
        """Paste into whatever has focus. Because this widget never activates,
        that is still the OpenCode prompt."""
        import pyperclip

        for attempt in range(4):
            try:
                pyperclip.copy(text)
                break
            except Exception:
                time.sleep(0.05 * (attempt + 1))
        else:
            return

        time.sleep(0.05)

        try:
            import keyboard

            keyboard.send("ctrl+v")
        except Exception:
            pass


def main():
    enable_dpi_awareness()

    mutex = acquire_single_instance()
    if mutex is None:
        # Another copy is already on screen; do nothing.
        return

    app = FloatingMic()
    try:
        app.root.mainloop()
    finally:
        kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    main()
