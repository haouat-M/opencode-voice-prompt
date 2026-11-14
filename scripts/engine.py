"""Voice engine for the opencode-voice-prompt plugin.

This module is intentionally dependency-light: the ``doctor`` and ``fix``
actions work on a bare Python installation, and the audio stack
(``sounddevice``, ``SpeechRecognition``, ``numpy``) is only imported when a
recording actually starts.

Commands
--------
record   Capture the microphone, detect the end of speech, transcribe it with
         Google Speech Recognition, and print one JSON result line.
doctor   Report the interpreter, installed packages, audio devices and whether
         the engine is ready to record.
fix      Run text through the spoken-term fixer (used by the tests).
test     Print diagnostics about the fixer and the audio stack.
"""

import argparse
import importlib.util
import io
import json
import queue
import re
import sys
import threading
import time
import wave

try:
    import numpy as np
except Exception:  # pragma: no cover - doctor must work without numpy
    np = None

if sys.platform == "win32":
    # Force UTF-8 on the standard streams; Windows consoles default to a legacy
    # code page and would otherwise crash while printing Arabic or JSON.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        try:
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
            sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
        except Exception:
            pass

JSON_START = "__JSON_START__"
JSON_END = "__JSON_END__"


def emit(payload):
    """Print a machine-readable result the Node side can parse."""
    print(
        JSON_START + json.dumps(payload, ensure_ascii=False) + JSON_END,
        flush=True,
    )


# ---------------------------------------------------------------------------
# Spoken-term fixer
# ---------------------------------------------------------------------------

# Some Arabic words are both ordinary speech and transliterated developer
# terms. They are only rewritten when another, unambiguous term is close by,
# otherwise normal dictation would be corrupted (for example "جيت على بالي"
# must stay Arabic, not become "Git على بالي").
AMBIGUOUS_TERMS = [
    (r"جيت|غت", "Git"),
    (r"بوش", "push"),
    (r"رست", "Rust"),
    (r"دارت", "Dart"),
    (r"نست", "NestJS"),
]

# Unambiguous terms. Multi-word and uncommon spellings only: this list is
# applied to every transcription.
STRONG_TERMS = [
    # Core tools & agents
    (r"انتي جرافيتي|أنتي غرافيتي|انتي غرافيتي|انتيجرافيتي|أنتيجرافيتي|انتي جرفيتي", "Antigravity"),
    (r"اوبن كود|أوبن كود", "OpenCode"),
    (r"اي بي اي|إي بي آي|اي بي آي|اب اي", "API"),
    (r"ام سي بي|إم سي بي", "MCP"),
    (r"برومت|برومبت", "Prompt"),
    (r"توكن|توكنز", "Token"),

    # Containers & environments
    (r"جوكر|الجوكر|دوكر|الدوكر|دوكار|داكر|دكر", "Docker"),
    (r"دوكر كومبوز|دوكر كمبوز", "Docker Compose"),
    (r"لاراجون|لاراجن|لارغون|لاراجان|لارجون|لاراغون|الاراجوز|الأراجوز", "Laragon"),
    (r"كوبيرنيتس|كوبرنيتس|كوبرنيتيز", "Kubernetes"),

    # Version control
    (r"جيت هاب|غيتهاب|جتهاب|جيت هب", "GitHub"),
    (r"جيت لاب|غيتلاب", "GitLab"),
    (r"كوميت|كوميتات|كمت", "commit"),
    (r"بوشينج", "push"),
    (r"بول ريكويست|بول ريكوست|بي ار", "Pull Request"),
    (r"برانش|برانشات", "branch"),
    (r"ميرج|ميرجنج", "merge"),

    # Web frameworks & libraries
    (r"فيو جي اس|فيو جي إس|فيو جيس|فيوجي اس|فيوز", "Vue.js"),
    (r"رياكت جي اس|رياكت جي إس|رياكت", "React"),
    (r"انجلر|أنجولار|انغولار", "Angular"),
    (r"نكست جي اس|نكست جي إس|نكست", "Next.js"),
    (r"نوكست جي اس|نوكست", "Nuxt.js"),
    (r"نوفيل|لارافيل|لارافل|لاريفيل", "Laravel"),
    (r"تيلويند|تيلوند|تلويند|تلويند سي اس اس", "Tailwind CSS"),
    (r"بوتستراب|بوت ستراب", "Bootstrap"),
    (r"جانجو|ديجانجو|دي جانجو", "Django"),
    (r"فلاسك", "Flask"),
    (r"فاست اي بي اي|فاست اب اي", "FastAPI"),
    (r"اكسبريس|إكسبريس", "Express.js"),
    (r"نست جي اس", "NestJS"),

    # Programming languages
    (r"بايثون|بيثون|بايثن", "Python"),
    (r"جافا سكريبت|جافاسكريبت", "JavaScript"),
    (r"تايب سكريبت|تايبسكريبت", "TypeScript"),
    (r"نود جي اس|نود جي إس|نود", "Node.js"),
    (r"بي اتش بي|بي إتش بي", "PHP"),
    (r"اتش تي ام ال|إتش تي إم إل|اتش تي ام ال فايف", "HTML"),
    (r"سي اس اس|سي إس إس|سي اس اس ثري", "CSS"),
    (r"سي بلس بلس", "C++"),
    (r"سي شارب", "C#"),
    (r"جافا", "Java"),
    (r"راست", "Rust"),
    (r"جو لانج|جولانج", "Go"),
    (r"فلاتر|فلوتر", "Flutter"),

    # Databases & caching
    (r"ماي اس كيو ال|ماي إس كيو إل|ماي سيكول", "MySQL"),
    (r"بوستجري|بوستجرس|بوستجريس", "PostgreSQL"),
    (r"سيكولايت|اس كيو لايت", "SQLite"),
    (r"اس كيو ال|إس كيو إل|سيكول", "SQL"),
    (r"مونجو|مونجو دي بي", "MongoDB"),
    (r"ريديس|ريدس", "Redis"),
    (r"سوبابيس|سوبا بيز", "Supabase"),
    (r"فايربيس|فاير بيس", "Firebase"),

    # Web servers & infrastructure
    (r"اباتشي|أباتشي", "Apache"),
    (r"انجكس|انجن اكس|إنجن إكس|انجنكس|انجينكس", "Nginx"),
    (r"سيرفر|سيرفرات", "server"),
    (r"فرونت اند|فرونت إند", "Frontend"),
    (r"باك اند|باك إند", "Backend"),
    (r"فول ستاك|فل ستاك", "Fullstack"),
    (r"ويب هوك|ويب هوكس", "Webhook"),
    (r"ميدل وير|ميدلوير", "middleware"),
    (r"كومبوننت|كومبوننتس|كمبوننت", "Component"),
    (r"ريفاكتور|ريفاكتورينج", "refactor"),
    (r"ديباج|ديباجينج|ديبوق", "debug"),
    (r"تيرمنال|الترمينال|تيرمينال", "terminal"),
]

# How many characters may separate an ambiguous word from a confidently
# recognized term before the ambiguous word is left alone.
AMBIGUOUS_CONTEXT_CHARS = 24


def make_term_rule(words_regex, english_term):
    """Build a prefix-aware rule for one spoken term.

    Arabic speakers often attach و / ب / ل (and / with / for) and the definite
    article ال to a word. The prefix is preserved in the replacement:
    "والدوكر" becomes "و Docker".
    """
    pattern = re.compile(
        r"(?:^|\b)([وفلك]?(?:ب)?)?(?:ال)?(?:" + words_regex + r")\b",
        re.IGNORECASE,
    )

    def repl(match):
        prefix = match.group(1) or ""
        return (prefix + " " if prefix else "") + english_term

    return pattern, repl


def _specificity(regex_str):
    """Longest spoken alternative in a rule.

    Specific terms must run first, otherwise "دوكر" (Docker) would rewrite the
    first half of "دوكر كومبوز" before the longer rule can match.
    """
    return max((len(alt) for alt in regex_str.split("|")), default=0)


STRONG_RULES = [
    make_term_rule(regex_str, term)
    for regex_str, term in sorted(STRONG_TERMS, key=lambda item: _specificity(item[0]), reverse=True)
]
AMBIGUOUS_RULES = [make_term_rule(regex_str, term) for regex_str, term in AMBIGUOUS_TERMS]


def _match_spans(text, rules):
    spans = []
    for pattern, _repl in rules:
        for match in pattern.finditer(text):
            spans.append((match.start(), match.end()))
    return spans


def _inside(match, spans):
    return any(start <= match.start() and match.end() <= end for start, end in spans)


def _near(match, spans, window=AMBIGUOUS_CONTEXT_CHARS):
    """True when a match is inside or close to one of the confident terms."""
    if not spans:
        return False
    for start, end in spans:
        if start <= match.start() and match.end() <= end:
            return True
        if match.end() <= start:
            distance = start - match.end()
        elif match.start() >= end:
            distance = match.start() - end
        else:
            return True
        if distance <= window:
            return True
    return False


def apply_fixes(text, custom_fixes=None, auto_fix=True):
    """Rewrite spoken developer terms into their English spelling.

    ``auto_fix=False`` disables the built-in rules but still applies
    ``custom_fixes`` (a list of ``[spoken, replacement]`` pairs) supplied by the
    user. Ambiguous single words are only replaced next to a confident term.
    """
    if not text:
        return ""

    custom_rules = []
    if custom_fixes:
        for item in custom_fixes:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                spoken, term = item[0], item[1]
                if isinstance(spoken, str) and spoken and isinstance(term, str) and term:
                    custom_rules.append(make_term_rule(re.escape(spoken), term))

    rules = list(custom_rules)
    if auto_fix:
        rules.extend(STRONG_RULES)

    # Confident matches are located before anything is rewritten so ambiguous
    # words can be gated by their proximity to real developer terms.
    confident_spans = _match_spans(text, rules)

    if auto_fix:
        edits = []
        for pattern, repl in AMBIGUOUS_RULES:
            for match in pattern.finditer(text):
                if _inside(match, confident_spans):
                    continue
                if not _near(match, confident_spans):
                    continue
                edits.append((match.start(), match.end(), repl(match)))
        # Apply from the end so earlier offsets stay valid.
        for start, end, value in sorted(edits, reverse=True):
            text = text[:start] + value + text[end:]

    for pattern, repl in rules:
        text = pattern.sub(repl, text)

    # A preserved spoken prefix (و / ب / ل) can leave a double space.
    return re.sub(r"[ \t]{2,}", " ", text).strip()


# ---------------------------------------------------------------------------
# Audio capture
# ---------------------------------------------------------------------------

DEFAULT_SAMPLE_RATES = (48000, 44100, 32000, 16000)
SILENCE_THRESHOLD = 0.014
NOISE_FLOOR = 0.01
MIN_SPEECH_SECONDS = 0.3
PRE_ROLL_CHUNKS = 4
# Silence kept after the last spoken chunk: enough to finish a trailing
# consonant, without uploading seconds of dead air to the recognizer.
POST_ROLL_CHUNKS = 4
# Progressive endpointing. A pause in the middle of a sentence must not end the
# dictation, but waiting for a long silence before even starting the upload
# makes it feel slow. So once the pause is "long enough", the audio collected
# so far is transcribed in a background thread while capture keeps running:
#   * the speaker resumes  -> the guess is thrown away and recording goes on;
#   * the speaker is done   -> the text of the guess is used as the final text.
# A guess is only used after the configured silence plus an extra wait, so a
# pause is tolerated no matter how fast the speech service answers, and a real
# ending still costs only that wait (the upload already ran in parallel).
SPECULATE_AT = 0.6  # fraction of the silence window before the first guess
SPECULATE_COOLDOWN = 0.4  # seconds between two guesses
SPECULATE_CONFIRM = 0.4  # silence required after a guess starts, before it is accepted
SPECULATE_WAIT = 1.2  # extra silence demanded of a guess, so a pause is not cut
SPECULATE_WAIT_STEP = 0.3  # added per discarded guess (this speaker pauses a lot)
SPECULATE_WAIT_MAX = 2.0  # upper bound for that extra silence
SPECULATE_UNFINISHED = 0.6  # extra silence when the guessed text ends mid-phrase
SPECULATE_LIMIT = 6  # guesses per recording (protects the free speech service)

# Words that cannot end a sentence in practice: if the guess stops on one of
# them, the speaker was pausing in the middle of a phrase.
UNFINISHED_WORDS = frozenset(
    """
    و او أو ثم لكن بس لأن لان حتى مع في من إلى الى على عن أن ان إن الى
    the a an and or but so because with without to of in on at for from by
    that which who whom whose if then than as is are was were be been being
    """.split()
)


def resolve_input_device(sounddevice, value):
    """Turn a device index or a (partial) name into something PortAudio accepts."""
    if value is None or value == "":
        return None
    text = str(value).strip()
    if re.fullmatch(r"\d+", text):
        return int(text)

    try:
        devices = sounddevice.query_devices()
    except Exception:
        return text

    wanted = text.casefold()
    for index, device in enumerate(devices):
        if device.get("max_input_channels", 0) <= 0:
            continue
        name = str(device.get("name", ""))
        if wanted in name.casefold():
            return index

    names = [str(d.get("name", "")) for d in devices if d.get("max_input_channels", 0) > 0]
    raise ValueError(
        'input device "%s" was not found. Available inputs: %s' % (text, ", ".join(names) or "none")
    )


def open_input_stream(sounddevice, device, rates):
    """Open the microphone in callback mode and return its audio queue.

    Callback mode is used for every device because some Windows drivers (the
    WDM-KS host API, for example Stereo Mix) reject blocking reads with
    "Blocking API not supported yet". The queue is bounded so a slow consumer
    can never grow memory without limit. Each sample rate is tried in turn,
    which covers devices that reject 48 kHz but accept 44.1 kHz.
    """
    last_error = None
    for rate in rates:
        rate = int(rate)
        block_size = max(256, int(rate * 0.064))
        chunks = queue.Queue(maxsize=max(8, int(4.0 * rate / block_size)))
        stream = None

        def callback(indata, _frames, _time_info, _status, target=chunks):
            # Overflows/underflows are not fatal: the captured audio is still
            # usable, and dropping the newest block keeps the queue bounded.
            try:
                target.put_nowait(indata.copy())
            except queue.Full:
                pass

        try:
            stream = sounddevice.InputStream(
                samplerate=rate,
                channels=1,
                blocksize=block_size,
                dtype="float32",
                device=device,
                callback=callback,
            )
            stream.start()
            return stream, rate, block_size, chunks
        except Exception as error:  # PortAudioError for unsupported formats
            last_error = error
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass
    if last_error is None:
        raise RuntimeError("no sample rate was available")
    raise last_error


def _read_stdin(stop_event):
    try:
        for line in sys.stdin:
            if line.strip().lower() in ("stop", "exit", "quit"):
                stop_event.set()
                break
    except Exception:
        pass


def audio_to_wav(np, chunks, rate, first_speech_index, last_speech_index):
    """Trim dead air at both ends and pack the audio into an in-memory WAV.

    A short pre-roll is kept so the first syllable is not clipped, and the
    trailing silence is cut down to a short post-roll. Less audio means a
    smaller upload and slightly faster recognition.
    """
    if last_speech_index is not None:
        chunks = chunks[: last_speech_index + POST_ROLL_CHUNKS + 1]
    if first_speech_index is not None:
        chunks = chunks[max(0, first_speech_index - PRE_ROLL_CHUNKS) :]

    audio = np.concatenate(chunks, axis=0)
    int16_audio = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)

    wav_io = io.BytesIO()
    with wave.open(wav_io, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(int16_audio.tobytes())
    wav_io.seek(0)
    return wav_io, round(len(audio) / rate, 2)


def sentence_looks_unfinished(text):
    """True when the transcript stops on a word that rarely ends a sentence.

    This is the cheap linguistic half of end-of-speech detection: timing alone
    cannot know whether "… and push the branch to" is the end, but the trailing
    connector says the speaker was still going.
    """
    if not text:
        return False
    words = re.findall(r"[\w\u0600-\u06FF]+", str(text), flags=re.UNICODE)
    if not words:
        return False
    return words[-1].casefold() in UNFINISHED_WORDS


def transcribe_wav(speech_recognition, wav_io, language):
    """Send one WAV buffer to the speech service and return the raw text."""
    recognizer = speech_recognition.Recognizer()
    # recognize_google passes this to urlopen; without it a hung request could
    # block the plugin forever.
    recognizer.operation_timeout = 30
    with speech_recognition.AudioFile(wav_io) as source:
        audio = recognizer.record(source)
    return recognizer.recognize_google(audio, language=language)


def _speculate_worker(np, sr, state, chunks, rate, first, last, language):
    """Transcribe a snapshot of the audio while the microphone keeps running."""
    try:
        wav_io, duration = audio_to_wav(np, chunks, rate, first, last)
        state["text"] = transcribe_wav(sr, wav_io, language)
        state["duration"] = duration
    except Exception as error:
        state["error"] = error
    finally:
        state["done"] = True


def record_and_transcribe(
    language="ar-SA",
    timeout=90,
    silence_seconds=1.5,
    custom_fixes=None,
    input_device=None,
    sample_rate=None,
    auto_fix=True,
):
    try:
        import numpy as np  # noqa: F401 - local import: the doctor works without it
        import sounddevice as sd
        import speech_recognition as sr
    except Exception as error:
        emit(
            {
                "success": False,
                "error": "missing Python package: %s" % error,
                "code": "DEPENDENCY_ERROR",
            }
        )
        return

    timeout = max(5, int(timeout))
    silence_seconds = min(10.0, max(0.3, float(silence_seconds)))

    recorded_chunks = []
    stop_event = threading.Event()
    silent_chunks = 0
    speech_chunks = 0
    speech_detected = False
    first_speech_index = None
    last_speech_index = None
    noise_floor = NOISE_FLOOR
    lang_code = "ar-SA" if not language or str(language).lower() in ("auto", "none") else language

    # Progressive endpointing state (see SPECULATE_* above). `speculation` is a
    # small dict shared with the worker thread: {done, text, duration, error,
    # cancelled}. It is only read after `done` is set, so no lock is needed.
    speculation = None
    speculation_count = 0
    speculation_enabled = True
    last_speculation_at = 0.0

    threading.Thread(target=_read_stdin, args=(stop_event,), daemon=True).start()
    print("__STATUS_RECORDING__", flush=True)

    start_time = time.time()
    stream = None

    try:
        device = resolve_input_device(sd, input_device)
        rates = (int(sample_rate),) if sample_rate else DEFAULT_SAMPLE_RATES
        stream, rate, block_size, chunks = open_input_stream(sd, device, rates)

        chunks_per_second = float(rate) / block_size
        max_silent_chunks = max(1, int(chunks_per_second * silence_seconds))
        min_speech_chunks = max(1, int(chunks_per_second * MIN_SPEECH_SECONDS))
        speculate_after = max(1, int(max_silent_chunks * SPECULATE_AT))
        confirm_chunks = max(1, int(chunks_per_second * SPECULATE_CONFIRM))
        wait_chunks = int(chunks_per_second * SPECULATE_WAIT)
        wait_step_chunks = int(chunks_per_second * SPECULATE_WAIT_STEP)
        max_wait_chunks = int(chunks_per_second * SPECULATE_WAIT_MAX)
        # Extra silence demanded on top of the configured window. It grows each
        # time a guess turns out to be a mid-sentence pause, so a speaker who
        # pauses a lot gets more room while a fluent speaker stays fast.
        continuation_wait = wait_chunks

        while not stop_event.is_set():
            if time.time() - start_time > timeout:
                break

            try:
                data = chunks.get(timeout=0.2)
            except queue.Empty:
                # The device is silent or still starting; keep waiting until
                # the stop event or the hard timeout fires.
                continue
            rms = float(np.sqrt(np.mean(np.square(data))))
            recorded_chunks.append(data.copy())

            # Follow the ambient level, but never make the threshold stricter
            # than the calibrated value, so soft speakers still register.
            if rms < noise_floor:
                noise_floor = noise_floor * 0.9 + rms * 0.1
            elif not speech_detected:
                noise_floor = noise_floor * 0.995 + rms * 0.005
            threshold = max(0.008, min(SILENCE_THRESHOLD, noise_floor * 2.0))

            if rms > threshold:
                if not speech_detected:
                    first_speech_index = len(recorded_chunks) - 1
                speech_detected = True
                last_speech_index = len(recorded_chunks) - 1
                speech_chunks += 1
                silent_chunks = 0
                if speculation is not None:
                    # The speaker continued: the guess stopped mid-sentence, so
                    # it must never be inserted. Keep recording instead, and be
                    # a little more patient with this speaker from now on.
                    speculation["cancelled"] = True
                    speculation = None
                    continuation_wait = min(max_wait_chunks, continuation_wait + wait_step_chunks)
            elif speech_detected:
                silent_chunks += 1

                # Start a background transcription once the pause looks as if
                # it might be the end. The answer is reused when it turns out
                # to be the end, and discarded when speech resumes.
                if (
                    speculation is None
                    and speculation_enabled
                    and speech_chunks >= min_speech_chunks
                    and silent_chunks >= speculate_after
                    and speculation_count < SPECULATE_LIMIT
                    and (time.time() - last_speculation_at) >= SPECULATE_COOLDOWN
                ):
                    speculation = {
                        "done": False,
                        "text": None,
                        "duration": None,
                        "error": None,
                        "cancelled": False,
                        # Silence already elapsed when the guess started; the
                        # guess is not trusted until the configured window plus
                        # the continuation wait has passed, so an unfinished
                        # word is never accepted early.
                        "accept_at": max(
                            max_silent_chunks,
                            silent_chunks + confirm_chunks,
                        )
                        + continuation_wait,
                    }
                    speculation_count += 1
                    last_speculation_at = time.time()
                    snapshot = list(recorded_chunks)
                    threading.Thread(
                        target=_speculate_worker,
                        args=(
                            np,
                            sr,
                            speculation,
                            snapshot,
                            rate,
                            first_speech_index,
                            last_speech_index,
                            lang_code,
                        ),
                        daemon=True,
                    ).start()

                if speculation is not None and speculation["done"]:
                    if speculation["error"] is not None:
                        # The guess failed (noise, a very short clip, network).
                        # Drop it and fall back to plain endpointing so the
                        # microphone does not stay open forever.
                        speculation = None
                        speculation_enabled = False
                    elif not speculation.get("extended") and sentence_looks_unfinished(
                        speculation.get("text")
                    ):
                        # The guess stops on a connector ("… and", "… في"): the
                        # speaker is almost certainly still mid-sentence.
                        speculation["extended"] = True
                        speculation["accept_at"] = speculation.get(
                            "accept_at", max_silent_chunks
                        ) + int(chunks_per_second * SPECULATE_UNFINISHED)
                    elif silent_chunks >= speculation.get("accept_at", max_silent_chunks):
                        break

                # Plain endpointing: used when guessing is impossible (limit
                # reached) and after a failed guess. Until then the speaker
                # gets the same patient wait as an accepted guess.
                if (
                    speculation is None
                    and silent_chunks
                    >= max_silent_chunks + (continuation_wait if speculation_enabled else 0)
                    and speech_chunks >= min_speech_chunks
                ):
                    break
    except Exception as error:
        emit({"success": False, "error": "Audio recording error: %s" % error, "code": "AUDIO_ERROR"})
        return
    finally:
        if stream is not None:
            try:
                stream.stop()
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass

    if not recorded_chunks:
        emit({"success": False, "error": "لم يتم التقاط صوت", "code": "NO_SPEECH"})
        return

    if not speech_detected:
        emit(
            {
                "success": False,
                "error": "لم يتم التقاط صوت واضح",
                "code": "NO_SPEECH",
                "duration": round(len(recorded_chunks) * block_size / rate, 2),
            }
        )
        return

    print("__STATUS_PROCESSING__", flush=True)

    # When a guess finished and the speaker never continued, its text is the
    # final text: no second upload, and the wait after the last word is only
    # as long as the speech service needs.
    accepted = None
    if (
        speculation is not None
        and speculation.get("done")
        and speculation.get("error") is None
        and not speculation.get("cancelled")
    ):
        accepted = speculation
    elif speculation is not None:
        # The recording was stopped by a timeout or by the user while a guess
        # was still in flight; it cannot be trusted, so transcribe normally.
        speculation["cancelled"] = True

    try:
        if accepted is not None:
            raw_text = accepted["text"]
            duration = accepted["duration"]
        else:
            wav_io, duration = audio_to_wav(
                np, recorded_chunks, rate, first_speech_index, last_speech_index
            )
            raw_text = transcribe_wav(sr, wav_io, lang_code)
        emit(
            {
                "success": True,
                "text": apply_fixes(raw_text, custom_fixes, auto_fix=auto_fix),
                "raw_text": raw_text,
                "duration": duration,
                "language": lang_code,
            }
        )
    except sr.UnknownValueError:
        emit({"success": False, "error": "لم يتم التقاط صوت واضح", "code": "NO_SPEECH"})
    except sr.RequestError as error:
        emit(
            {
                "success": False,
                "error": "خطأ في الاتصال بالخدمة: %s" % error,
                "code": "NETWORK_ERROR",
            }
        )
    except Exception as error:
        emit({"success": False, "error": str(error), "code": "UNKNOWN_ERROR"})


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

REQUIRED_MODULES = (
    ("numpy", "numpy"),
    ("sounddevice", "sounddevice"),
    ("speech_recognition", "SpeechRecognition"),
)


def _module_state(module):
    """Return (installed, import_error) for one optional dependency.

    A package that is installed but fails to import (sounddevice without the
    PortAudio shared library, for example) must not be reported as "missing":
    reinstalling it cannot help, and the user needs the real reason instead.
    """
    try:
        __import__(module)
        return True, ""
    except Exception as error:
        try:
            installed = importlib.util.find_spec(module) is not None
        except Exception:
            installed = False
        return installed, str(error)


def doctor(input_device=None):
    """Report the interpreter, missing packages, broken imports and microphones."""
    missing = []
    broken = {}
    for module, pip_name in REQUIRED_MODULES:
        installed, error = _module_state(module)
        if error and installed:
            broken[pip_name] = error
        elif not installed:
            missing.append(pip_name)

    info = {
        "success": True,
        "ready": not missing and not broken,
        "missing": missing,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": sys.platform,
    }

    if broken:
        info["import_errors"] = broken
        details = "; ".join("%s: %s" % (name, message) for name, message in broken.items())
        hint = ""
        if any(
            name == "sounddevice" or "portaudio" in message.lower()
            for name, message in broken.items()
        ):
            hint = (
                " On Debian/Ubuntu install PortAudio (sudo apt install libportaudio2) "
                "and make sure PulseAudio or PipeWire is running."
            )
        info["audio_error"] = "the audio library is installed but cannot load: %s.%s" % (
            details,
            hint,
        )

    if info["ready"]:
        try:
            import sounddevice as sd

            devices = sd.query_devices()
            info["input_devices"] = [
                str(device.get("name", ""))
                for device in devices
                if device.get("max_input_channels", 0) > 0
            ]
            info["default_input"] = sd.query_devices(kind="input")["name"]
            if input_device not in (None, ""):
                info["input_device"] = resolve_input_device(sd, input_device)
        except Exception as error:
            info["audio_error"] = str(error)
            info["ready"] = False

    emit(info)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Fast Arabic voice transcriber")
    parser.add_argument("--action", choices=["record", "test", "fix", "doctor"], default="record")
    parser.add_argument("--language", type=str, default="ar-SA")
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--silence", type=float, default=1.5)
    parser.add_argument("--device", type=str, default="", help="input device index or name")
    parser.add_argument("--sample-rate", type=int, default=0, help="force one sample rate")
    parser.add_argument("--no-auto-fix", action="store_true", help="keep the raw transcription")
    parser.add_argument("--custom-fixes-json", type=str, default="")
    parser.add_argument("--text", type=str, default="", help="text for --action fix")

    args = parser.parse_args(argv)

    custom_fixes = None
    if args.custom_fixes_json:
        try:
            custom_fixes = json.loads(args.custom_fixes_json)
        except Exception:
            custom_fixes = None

    if args.action == "record":
        record_and_transcribe(
            language=args.language,
            timeout=args.timeout,
            silence_seconds=args.silence,
            custom_fixes=custom_fixes,
            input_device=args.device or None,
            sample_rate=args.sample_rate or None,
            auto_fix=not args.no_auto_fix,
        )
    elif args.action == "doctor":
        doctor(input_device=args.device or None)
    elif args.action == "fix":
        emit(
            {
                "success": True,
                "input": args.text,
                "text": apply_fixes(args.text, custom_fixes, auto_fix=not args.no_auto_fix),
            }
        )
    elif args.action == "test":
        info = {"success": True, "python": sys.version.split()[0], "platform": sys.platform}
        try:
            info["fixer_sample"] = apply_fixes("استخدم دوكر كومبوز وجيت هاب مع بايثون و رياكت")
        except Exception as error:
            info["fixer_error"] = str(error)
        try:
            import sounddevice as sd

            info["input_devices"] = [
                str(device.get("name", ""))
                for device in sd.query_devices()
                if device.get("max_input_channels", 0) > 0
            ]
            info["default_input"] = sd.query_devices(kind="input")["name"]
        except Exception as error:
            info["audio_error"] = str(error)
        emit(info)


if __name__ == "__main__":
    main()
