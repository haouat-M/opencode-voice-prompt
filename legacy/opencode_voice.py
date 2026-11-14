import sys
import os
import re
import io
import time
import json
import wave
import threading
import winsound
import numpy as np
import keyboard
import pyperclip
import sounddevice as sd
import speech_recognition as sr

# Force UTF-8 on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Import phonetic fixes from engine
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "scripts"))
try:
    from engine import apply_fixes
except ImportError:
    def apply_fixes(text):
        return text

class OpenCodeVoiceCompanion:
    def __init__(self, language="ar-SA", silence_seconds=2.2):
        self.language = language
        self.silence_seconds = silence_seconds
        self.sample_rate = 16000
        self.channels = 1
        self.block_size = 1024
        self.silence_threshold = 0.014
        self.is_recording = False
        self.stop_requested = False
        self.recognizer = sr.Recognizer()

    def play_start_sound(self):
        try:
            winsound.Beep(1200, 100)
        except Exception:
            pass

    def play_stop_sound(self):
        try:
            winsound.Beep(1600, 120)
        except Exception:
            pass

    def play_error_sound(self):
        try:
            winsound.Beep(600, 200)
        except Exception:
            pass

    def toggle(self):
        if self.is_recording:
            self.stop_requested = True
        else:
            threading.Thread(target=self._record_and_inject, daemon=True).start()

    def _record_and_inject(self):
        self.is_recording = True
        self.stop_requested = False
        self.play_start_sound()
        print("🎙️ [OpenCode Voice] Listening... (Speak naturally in Arabic)", flush=True)

        recorded_chunks = []
        silent_chunks_count = 0
        speech_detected = False

        chunks_per_sec = int(self.sample_rate / self.block_size)
        max_silent_chunks = int(chunks_per_sec * self.silence_seconds)
        min_speech_chunks = int(chunks_per_sec * 0.3)
        start_time = time.time()

        try:
            with sd.InputStream(samplerate=self.sample_rate, channels=self.channels, blocksize=self.block_size, dtype='float32') as stream:
                while not self.stop_requested:
                    if time.time() - start_time > 90:
                        break

                    data, _ = stream.read(self.block_size)
                    rms = float(np.linalg.norm(data) / np.sqrt(len(data)))
                    recorded_chunks.append(data.copy())

                    if rms > self.silence_threshold:
                        speech_detected = True
                        silent_chunks_count = 0
                    else:
                        if speech_detected:
                            silent_chunks_count += 1
                            if silent_chunks_count >= max_silent_chunks:
                                if len(recorded_chunks) >= min_speech_chunks:
                                    break
        except Exception as e:
            print("Error recording:", e)
            self.play_error_sound()
            self.is_recording = False
            return

        self.play_stop_sound()
        self.is_recording = False

        if not recorded_chunks:
            return

        print("⚡ [OpenCode Voice] Transcribing and fixing technical terms...", flush=True)

        audio_full = np.concatenate(recorded_chunks, axis=0)
        int16_data = (np.clip(audio_full, -1.0, 1.0) * 32767).astype(np.int16)
        wav_io = io.BytesIO()
        with wave.open(wav_io, 'wb') as wf:
            wf.setnchannels(self.channels)
            wf.setsampwidth(2)
            wf.setframerate(self.sample_rate)
            wf.writeframes(int16_data.tobytes())
        wav_io.seek(0)

        try:
            with sr.AudioFile(wav_io) as source:
                audio_record = self.recognizer.record(source)
                raw_text = self.recognizer.recognize_google(audio_record, language=self.language)
                cleaned_text = apply_fixes(raw_text)

                if cleaned_text:
                    print(f"✅ [OpenCode Voice]: {cleaned_text}", flush=True)
                    # 1. Copy to clipboard
                    pyperclip.copy(cleaned_text)
                    # 2. Short sleep to ensure active window gets focus
                    time.sleep(0.08)
                    # 3. Simulate Ctrl+V to paste into OpenCode prompt
                    keyboard.send('ctrl+v')
        except sr.UnknownValueError:
            print("ℹ️ [OpenCode Voice] No speech detected", flush=True)
        except Exception as e:
            print("Transcription error:", e)
            self.play_error_sound()

if __name__ == "__main__":
    print("==================================================")
    print("🎙️ OpenCode Voice Prompt Companion Active")
    print("Press Ctrl+Alt+A anywhere (in OpenCode) to speak!")
    print("Natural 2.2s breathing pause detection enabled.")
    print("Press Ctrl+C in this terminal to stop.")
    print("==================================================", flush=True)

    companion = OpenCodeVoiceCompanion()
    keyboard.add_hotkey("ctrl+alt+a", companion.toggle)

    try:
        keyboard.wait()
    except KeyboardInterrupt:
        print("\nExiting OpenCode Voice Companion.")
