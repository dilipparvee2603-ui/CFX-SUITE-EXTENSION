"""CFX Suite - offline speech-to-text and caption language for Auto Captions.

Runs faster-whisper (CTranslate2 Whisper) on an audio file rendered from the After Effects comp, works out
the spoken language (From) and writes the caption words in the chosen language (To), each with a start / end
time, as JSON. To: Tamil, English, Tanglish (Tamil + English, Latin letters) or Hinglish (Hindi + English).
Every translation (into English too) is made from the transcript by MADLAD-400 3B (dala_setup_mt.py downloads
it once), a whole sentence at a time, with the words timed over the speech they translate.
The panel starts it as a child process and reads one status line per event on stdout:

    STATUS <text>               what is happening now
    DOWNLOAD <done> <total>     first-run model download, bytes
    PROGRESS <0..1>             progress of the whole run
    DEVICE <cuda|cpu> <type>    where the model runs
    NEEDMT                      the translation model is needed but not set up yet (exit code 3)
    DONE <out.json>
    ERROR <message>

    python dala_transcribe.py --check
    python dala_transcribe.py --audio a.aif --out words.json [--source auto|ta|en|tanglish|hinglish|hi]
                              [--target en|ta|tanglish|hinglish] [--model large-v3] [--device auto|cuda|cpu]
"""
import argparse
import glob
import html
import json
import os
import re
import sys
import threading
import time

MODEL_REPOS = {
    "small": ("Systran/faster-whisper-small", 484e6),
    "medium": ("Systran/faster-whisper-medium", 1530e6),
    "large-v3": ("Systran/faster-whisper-large-v3", 3090e6),
}
LABELS = {"ta": "Tamil", "en": "English", "hi": "Hindi", "tanglish": "Tanglish", "hinglish": "Hinglish",
          "te": "Telugu", "ml": "Malayalam", "kn": "Kannada", "bn": "Bengali", "mr": "Marathi", "ur": "Urdu",
          "es": "Spanish", "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean", "zh": "Chinese"}
# languages the translator (MADLAD-400) reads and writes, by their Whisper codes (its target tags are "<2ta>"...)
MT_LANGS = ("en", "ta", "hi", "te", "ml", "kn", "bn", "mr", "gu", "pa", "ur", "es", "fr", "de", "ja", "ko", "zh", "ar",
            "ru", "it", "pt", "si")
MT_NAME = "madlad-3b"
SOURCE_LANG = {"auto": None, "ta": "ta", "tanglish": "ta", "en": "en", "hinglish": "hi", "hi": "hi"}
TARGET_BASE = {"ta": "ta", "tanglish": "ta", "hinglish": "hi", "en": "en"}
# film-style lines steer Whisper to the spelling of spoken Tamil (Whisper copies the style of its prompt);
# dala_spoken.py then converts what is still written in the formal register. Hindi has none: a prompt made
# Whisper skip whole stretches of Hindi film dialogue (22 s - 59 s of the test clip), and Whisper already writes
# film Hindi the everyday way. A prompted pass is still checked for skipped speech (fill_missed).
PROMPTS = {
    "ta": u"டேய், நீ எங்க போற? இங்க வா. என்ன பண்ற? அவங்க வந்துட்டாங்க. "
          u"எனக்கு தெரியல, நான் அப்புறம் சொல்றேன். சரி, நாளைக்கு பாக்கலாம். "
          u"ரொம்ப நல்லா இருக்கு. உன்கிட்ட ஒண்ணு கேக்கணும்.",
}


def emit(kind, *parts):
    sys.stdout.write(kind + (" " + " ".join(str(p) for p in parts) if parts else "") + "\n")
    sys.stdout.flush()


def private_cuda_dir():
    """cuBLAS 12 installed by the panel for GPU captions, kept out of the user's Python packages."""
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(base, "DalaSuite", "cuda12")


def add_cuda_dll_dirs():
    """pip's nvidia-* wheels keep cuBLAS / cuDNN in site-packages/nvidia/*/bin; Windows will not search there."""
    if os.name != "nt":
        return
    for sp in [private_cuda_dir()] + sys.path:
        for d in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            except OSError:
                pass


def default_cache():
    d = os.path.join(os.path.expanduser("~"), ".cache", "dala_whisper")
    if os.path.isdir(d): return d
    return os.path.join(os.path.expanduser("~"), ".cache", "cfx_whisper")


def mt_ready(cache):
    """The translator is downloaded and checked (sizes + the manifest written after its checksums matched)."""
    import dala_models
    return dala_models.status(cache, MT_NAME)["state"] == "ok"


def mt_needed(source, target):
    """When the languages are known up front: does this run translate? (Detect decides after listening.)"""
    lang = SOURCE_LANG.get(source)
    return lang is not None and lang != TARGET_BASE[target]


def folder_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def ensure_model(name, cache):
    """The model's folder: downloaded (resuming, checksum-verified) by dala_models.py if it is not complete."""
    import dala_models
    try:
        return dala_models.ensure(cache, name, quiet=True)
    except dala_models.ModelError as e:
        raise RuntimeError(str(e))


def cpu_threads():
    """Physical cores: CTranslate2 runs about 3x slower when it is also given the hyper-threads."""
    n = os.cpu_count() or 4
    return max(1, n // 2 if n >= 4 else n)


def load_model(path, device):
    from faster_whisper import WhisperModel

    tries = []
    if device in ("auto", "cuda"):
        # int8 weights + float16 maths: on a GTX 1650 about 2.5x faster than float16 and 6x faster than the CPU
        tries += [("cuda", "int8_float16"), ("cuda", "float16")]
    if device in ("auto", "cpu"):
        tries += [("cpu", "int8")]
    last = None
    for dev, ctype in tries:
        try:
            m = WhisperModel(path, device=dev, compute_type=ctype, cpu_threads=cpu_threads())
            return m, dev, ctype
        except Exception as e:  # missing CUDA libraries, out of memory, unsupported type...
            last = e
    raise RuntimeError("Could not load the speech model: %s" % last)


# ---------------------------------------------------------------------------------------------- passes

SR = 16000
PIECE_GAP = 0.5      # seconds of silence put between the speech pieces Whisper hears


class SpeechLayout(object):
    """Where the speech is in the rendered audio, and the audio Whisper hears.

    faster-whisper's own VAD filter glues the speech pieces together with no gap, so a word that starts a
    piece is timed from the end of the previous one: captions began in the silence before the line, up to
    seconds early ("indha" at 6.75 s for speech at 8.74 s). Here the pieces are joined with half a second of
    silence, Whisper times words across a real pause, and every time is mapped back to the rendered audio."""

    def __init__(self, audio):
        import numpy as np
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        chunks = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=400, speech_pad_ms=200))
        self.spans, pieces, t = [], [], 0.0
        gap = np.zeros(int(PIECE_GAP * SR), dtype=audio.dtype)
        for c in chunks:
            a = audio[c["start"]:c["end"]]
            self.spans.append((t, t + len(a) / float(SR), c["start"] / float(SR), c["end"] / float(SR)))
            pieces += [a, gap]
            t += (len(a) + len(gap)) / float(SR)
        self.audio = np.concatenate(pieces) if pieces else None
        self.voiced = voiced_regions(audio, get_speech_timestamps, VadOptions)

    def real(self, x, is_start):
        """A time in the joined audio -> the rendered audio. A start in a gap belongs to the next piece,
        an end in a gap to the previous one."""
        for i, (n0, n1, o0, o1) in enumerate(self.spans):
            if x < n0:
                return o0 if (is_start or i == 0) else self.spans[i - 1][3]
            if x <= n1:
                return o0 + (x - n0)
        return self.spans[-1][3]


def voiced_regions(audio, get_speech_timestamps, VadOptions):
    """Speech found by Silero VAD (no padding), each stretched by up to 0.4 s over the loud audio right
    next to it (VAD misses soft word onsets / endings). [[start, end], ...] in seconds."""
    import numpy as np
    fine = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=150, speech_pad_ms=0))
    hop = SR // 100
    n = len(audio) // hop
    if not fine or n < 2:
        return [[c["start"] / float(SR), c["end"] / float(SR)] for c in fine]
    frames = audio[:n * hop].astype(np.float64).reshape(n, hop)
    db = 10.0 * np.log10(np.mean(frames * frames, axis=1) + 1e-12)
    loud = db > (np.percentile(db, 99) - 30.0)
    loud = np.convolve(loud.astype(np.int32), np.ones(5, dtype=np.int32), mode="same") > 0   # bridge 40 ms dips
    out = []
    for c in fine:
        a, b = c["start"] // hop, min(n, c["end"] // hop)
        k = a
        while k > 0 and a - k < 40 and loud[k - 1]:
            k -= 1
        m = b
        while m < n and m - b < 40 and loud[m]:
            m += 1
        if out and k / 100.0 <= out[-1][1]:
            out[-1][1] = max(out[-1][1], m / 100.0)
        else:
            out.append([k / 100.0, m / 100.0])
    return out


def snap_words(words, regions):
    """Whisper lets a word begin in the pause before it (its end is the reliable part). Each word is put on
    the stretch of real speech it ends in - the one before when only its tail bleeds into that stretch - and
    trimmed to it; a word that overlaps no speech joins its nearer neighbour."""
    if not regions:
        return words
    n = len(words)
    voiced = [False] * n
    for i, w in enumerate(words):
        hits = []
        for a, b in regions:
            if b <= w["s"]:
                continue
            if a >= w["e"]:
                break
            hits.append((min(w["e"], b) - max(w["s"], a), (a, b)))
        best = None
        if hits:
            total = sum(o for o, _r in hits)
            best = hits[-1][1] if hits[-1][0] >= min(0.12, 0.5 * total) else max(hits[:-1])[1]
        if best:
            w["s"], w["e"] = max(w["s"], best[0]), min(w["e"], best[1])
            voiced[i] = True
    for i in range(n):
        if voiced[i]:
            continue
        p = next((j for j in range(i - 1, -1, -1) if voiced[j]), None)
        q = next((j for j in range(i + 1, n) if voiced[j]), None)
        dp = words[i]["s"] - words[p]["e"] if p is not None else 1e9
        dq = words[q]["s"] - words[i]["e"] if q is not None else 1e9
        if min(dp, dq) > 1.5:
            continue                     # nowhere near detected speech (a shout over music): leave it
        t = words[q]["s"] if dq <= dp else words[p]["e"]
        words[i]["s"] = words[i]["e"] = t
    for i in range(1, n):
        if words[i]["s"] < words[i - 1]["s"]:
            words[i]["s"] = words[i - 1]["s"]
        if words[i]["e"] < words[i]["s"]:
            words[i]["e"] = words[i]["s"]
    for w in words:
        w["s"], w["e"] = round(w["s"], 3), round(w["e"], 3)
    return words


SENTENCE_END = u".?!।…"


def crt_for(language, task):
    """Tamil / Hindi script compresses well, so clean text scores above Whisper's default 2.4 compression limit;
    every window was then retried with random sampling (slow - minutes - and different each run)."""
    return 3.2 if (task == "transcribe" and language not in (None, "en", "es", "fr", "de", "it", "pt")) else 2.4


def whisper_pass(model, layout, language, task, prompt, duration_hint, label, p0, p1):
    """One Whisper run over the speech pieces. Returns (words, segments) in rendered-audio time."""
    emit("STATUS", label % {"lang": LABELS.get(language, language or "")})
    if layout.audio is None:
        return [], []
    segs, info = model.transcribe(
        layout.audio, language=language, task=task, beam_size=5, word_timestamps=True, vad_filter=False,
        condition_on_previous_text=False, hallucination_silence_threshold=2.0, initial_prompt=prompt or None,
        temperature=[0.0, 0.2, 0.4], compression_ratio_threshold=crt_for(language, task))
    duration = info.duration or duration_hint or 0
    words, segments = [], []
    for s in segs:
        segments.append({"s": round(layout.real(s.start, True), 3), "e": round(layout.real(s.end, False), 3),
                         "text": s.text.strip()})
        for w in (s.words or []):
            txt = w.word.strip()
            if txt:
                a, b = layout.real(w.start, True), layout.real(w.end, False)
                item = {"w": txt, "s": round(a, 3), "e": round(max(a, b), 3), "p": round(w.probability, 3)}
                # Whisper marks a new word with a leading space; a piece without one continues the
                # previous word ("1" ".4" ".1" -> "1.4.1", "don" "'t" -> "don't")
                if words and not w.word.startswith(" "):
                    item["j"] = 1
                words.append(item)
        if duration:
            emit("PROGRESS", "%.3f" % (p0 + (p1 - p0) * min(1.0, s.end / duration)))
    return words, segments


def merge_pieces(words):
    """Joins the word pieces Whisper splits so each item is one written word."""
    out = []
    for w in words:
        if out and w.get("j"):
            out[-1]["w"] += w["w"]
            out[-1]["e"] = max(out[-1]["e"], w["e"])
        else:
            out.append({"w": w["w"], "s": w["s"], "e": w["e"]})
    return out


def phrases(words, gap=0.6):
    """Spoken words cut at pauses and sentence ends: each phrase is translated on its own so the
    translation keeps the timing of the speech."""
    out, cur = [], []
    for w in words:
        if cur and (w["s"] - cur[-1]["e"] >= gap or cur[-1]["w"][-1:] in u".?!।"):
            out.append(cur)
            cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


def sentence_units(words, gap=1.5, max_words=20):
    """Phrases joined back into sentences for the translator (a whole sentence translates far better than its
    pieces: "Life or death, / it's in this soil"), kept apart across a long pause or a sentence end."""
    units, cur, n = [], [], 0
    for p in phrases(words):
        if cur and (cur[-1][-1]["w"][-1:] in SENTENCE_END or p[0]["s"] - cur[-1][-1]["e"] > gap or n + len(p) > max_words):
            units.append(cur)
            cur, n = [], 0
        cur.append(p)
        n += len(p)
    if cur:
        units.append(cur)
    return units


def spread_over(text, spans):
    """A translated sentence -> words timed over the speech it translates: spread by length across the spoken
    phrases' spans, never into the pauses between them."""
    toks = text.split()
    if not toks:
        return []
    durs = [max(0.15, e - s) for s, e in spans]
    total_t = sum(durs)
    total_c = float(sum(len(t) + 1 for t in toks))

    def at(f):
        x = f * total_t
        for k, ((s, e), d) in enumerate(zip(spans, durs)):
            if x <= d or k == len(spans) - 1:
                return k, s + min(x, d) * (e - s) / d
            x -= d

    out, c = [], 0
    for tok in toks:
        k, a = at(c / total_c)
        c += len(tok) + 1
        k2, b = at(c / total_c)
        if k2 != k:                                   # the word would cross a pause: it stays in its phrase
            b = spans[k][1]
        out.append({"w": tok, "s": round(a, 3), "e": round(max(a + 0.05, a + (b - a) * 0.9), 3)})
    return out


def missed_speech(words, voiced, segments, min_len=0.8, hole=1.5):
    """Stretches of detected speech that a pass left (almost) without words, and lines that swallowed speech: far
    less text per second of speech than this clip's typical line (one line for 97 s - 142 s holding a sentence)."""
    def credited(w):
        # a word timed over seconds was stretched over speech Whisper skipped ("dikhna" 99.2 s - 109.7 s): only
        # its ends count as heard
        if w["e"] - w["s"] <= 1.4:
            return [(w["s"], w["e"])]
        return [(w["s"], w["s"] + 0.7), (w["e"] - 0.7, w["e"])]

    heard_spans = sorted(x for w in words for x in credited(w))
    out = []
    for a, b in voiced:
        if b - a < min_len:
            continue
        t, holes = a, []
        for s, e in heard_spans:
            if e <= a or s >= b:
                continue
            if s - t > 0:
                holes.append((t, s))
            t = max(t, e)
        if b - t > 0:
            holes.append((t, b))
        # a stretch of speech with no word: 1.5 s inside a longer stretch, or a whole short one
        out += [(s, e) for s, e in holes if e - s >= hole or (e - s >= min_len and (s, e) == (a, b))]
    rates = []
    for s in segments:
        heard = sum(max(0.0, min(b, s["e"]) - max(a, s["s"])) for a, b in voiced)
        if heard >= 1.0:
            rates.append((len(s["text"].replace(" ", "")) / heard, heard, s))
    if len(rates) >= 3:
        typical = sorted(r for r, _h, _s in rates)[len(rates) // 2]
        out += [(s["s"], s["e"]) for r, heard, s in rates if heard >= 3.0 and r < typical * 0.4]
    return out


def listen_again(model, audio, lang, spans, p0, p1):
    """Each stretch on its own, without the prompt: out of the long pass's 30-second windows Whisper hears what it
    jumped over there. Lines Whisper itself rates as silence or as unsure are left out (no invented words)."""
    words, segs = [], []
    total = float(len(audio)) / SR
    for k, (a, b) in enumerate(spans):
        a0, b0 = max(0.0, a - 0.25), min(total, b + 0.25)
        res, _info = model.transcribe(
            audio[int(a0 * SR):int(b0 * SR)], language=lang, task="transcribe", beam_size=5, word_timestamps=True,
            vad_filter=False, condition_on_previous_text=False, hallucination_silence_threshold=2.0,
            temperature=[0.0, 0.2, 0.4], compression_ratio_threshold=crt_for(lang, "transcribe"))
        first = True
        for s in res:
            if s.no_speech_prob > 0.6 or s.avg_logprob < -1.0:
                continue
            segs.append({"s": round(a0 + s.start, 3), "e": round(a0 + s.end, 3), "text": s.text.strip()})
            for w in (s.words or []):
                txt = w.word.strip()
                if not txt:
                    continue
                item = {"w": txt, "s": round(a0 + w.start, 3), "e": round(a0 + max(w.start, w.end), 3),
                        "p": round(w.probability, 3)}
                if not first and not w.word.startswith(" "):
                    item["j"] = 1
                first = False
                words.append(item)
        emit("PROGRESS", "%.3f" % (p0 + (p1 - p0) * (k + 1) / float(len(spans))))
    return words, segs


def fill_missed(model, layout, audio, lang, words, segments):
    """Whisper sometimes jumps over a stretch of speech - with a prompt (the spoken-Tamil hint) whole minutes of it,
    without one a line now and then, hidden in one word stretched over ten seconds. Those stretches, and any line
    of the pass that runs across them (it swallowed them), are heard again on their own and replaced by what
    that second listen heard."""
    gaps = missed_speech(words, layout.voiced, segments)
    if sum(b - a for a, b in gaps) < 1.0:
        return words, segments
    bad = list(gaps)
    for s in segments:
        if any(s["s"] < b and s["e"] > a for a, b in gaps):
            bad.append((s["s"], s["e"]))
    spans = []
    for a, b in sorted(bad):
        if spans and a <= spans[-1][1] + 0.3:
            spans[-1] = (spans[-1][0], max(spans[-1][1], b))
        else:
            spans.append((a, b))
    emit("STATUS", "Listening again to speech the first pass skipped...")
    w2, s2 = listen_again(model, audio, lang, spans, 0.5, 0.65)

    def mid(x):
        return (x["s"] + x["e"]) / 2.0

    # a stretch is replaced only when the second listen heard words in it
    redo = [(a, b) for a, b in spans if any(a - 0.3 <= mid(w) <= b + 0.3 for w in w2)]

    def inside(t):
        return any(a - 0.3 <= t <= b + 0.3 for a, b in redo)

    first = [dict(w, src=1) for w in words if not inside(mid(w))]
    second = [dict(w, src=2) for w in w2 if inside(mid(w))]
    merged = sorted(first + second, key=lambda w: w["s"])
    for i, w in enumerate(merged):                    # a piece continues a word only from its own pass
        if w.get("j") and (i == 0 or merged[i - 1]["src"] != w["src"]):
            del w["j"]
        del w["src"]
    segs = sorted([s for s in segments if not inside(mid(s))] + [s for s in s2 if inside(mid(s))],
                  key=lambda s: s["s"])
    return merged, segs


class NeedMT(Exception):
    pass


class MTError(RuntimeError):
    """The translator failed (not the speech model): reported as it is, never retried as a GPU problem."""


def release(model):
    """Frees the speech model (RAM on the CPU, graphics memory on the GPU) once its passes are done."""
    try:
        model.model.unload_model()
    except Exception:
        pass


class Translator(object):
    """MADLAD-400 3B MT (CTranslate2 int8, downloaded once by dala_setup_mt.py), on the CPU: the speech model
    already fills a 4 GB graphics card, and a clip's sentences translate in seconds."""

    def __init__(self, cache):
        import ctranslate2
        import dala_models
        import tokenizers
        if not mt_ready(cache):
            raise NeedMT()
        path = dala_models.model_dir(cache, MT_NAME)
        try:
            self.tok = tokenizers.Tokenizer.from_file(os.path.join(path, "tokenizer.json"))
            self.tr = ctranslate2.Translator(path, device="cpu", compute_type="int8", intra_threads=cpu_threads())
        except MemoryError:
            raise MTError("Not enough free memory for the translator (it needs about 3.5 GB of RAM). Close other "
                          "programs, or caption in the spoken language, and try again.")
        except Exception as e:
            raise MTError("Could not load the translation model (%s). Press Generate again to repair it." % e)

    def translate(self, texts, tgt):
        if not texts:
            return []
        # the target language tag goes in front of the source ("<2en> ..."); the tokenizer adds </s>
        batch = [self.tok.encode(u"<2%s> %s" % (tgt, " ".join(t.split()))).tokens for t in texts]
        try:
            res = self.tr.translate_batch(batch, beam_size=4, max_decoding_length=256, repetition_penalty=1.1)
        except MemoryError:
            raise MTError("Not enough free memory for the translator. Close other programs and try again.")
        out = []
        for r in res:
            ids = [self.tok.token_to_id(t) for t in r.hypotheses[0] if t not in ("</s>", "<s>", "<pad>")]
            text = self.tok.decode([i for i in ids if i is not None], skip_special_tokens=True)
            # web-text habits the model learnt: "today &apos;s", "today 's", "that place ."
            text = re.sub(r"\s+([.,!?;:%])", r"\1", html.unescape(text))
            text = re.sub(r"(\w) ['’](s|re|ll|ve|d|m|t)\b", r"\1'\2", text)
            out.append(" ".join(text.split()))
        return out


def add_loudness(words, audio):
    """Each word's loudness (RMS level in dB over its time): the caption director reads it to find the words
    and lines that are said with weight."""
    import numpy as np
    n = len(audio)
    for w in words:
        a = int(max(0.0, w["s"]) * SR)
        b = min(n, int(max(w["e"], w["s"] + 0.06) * SR))
        if b - a < SR // 100:
            continue
        seg = audio[a:b].astype("float64")
        w["db"] = round(float(20.0 * np.log10(np.sqrt(np.mean(seg * seg)) + 1e-7)), 1)
    return words


def run(args, model):
    import dala_translit as TL
    import dala_spoken as SP
    from faster_whisper import decode_audio
    audio = decode_audio(args.audio, sampling_rate=SR)       # decoded once for every pass
    layout = SpeechLayout(audio)
    src_hint = SOURCE_LANG.get(args.source)
    prob = 1.0
    if src_hint is None:
        # From = Detect: Whisper's language detector on the speech parts (much faster than a full pass)
        emit("STATUS", "Detecting the spoken language...")
        found, prob, _all = model.detect_language(audio, vad_filter=True, language_detection_segments=3)
        src_hint_detected = found
    else:
        src_hint_detected = src_hint
    lang = src_hint_detected
    # pass 1: what was said, in its own script (with the spoken-spelling hint for Tamil)
    words, segments = whisper_pass(model, layout, lang, "transcribe", PROMPTS.get(lang),
                                   args.duration, "Listening (%(lang)s)...", 0.05, 0.5)
    words, segments = fill_missed(model, layout, audio, lang, words, segments)
    src_words = snap_words(merge_pieces(words), layout.voiced)
    raw_words = [dict(w) for w in src_words]                 # as Whisper wrote them: what the translator reads
    # spoken Tamil / everyday Hindi instead of the formal written register (word by word: timings stay)
    spoken = args.spoken == "1"
    if spoken and lang == "ta":
        src_words = SP.tamil_words(src_words)
        for s in segments:
            s["text"] = SP.tamil_text(s["text"])
    elif spoken and lang == "hi":
        src_words = SP.hindi_words(src_words)
        for s in segments:
            s["text"] = SP.hindi_text(s["text"])
    src_text = " ".join(s["text"] for s in segments)
    mixed = lang in ("ta", "hi") and TL.latin_share(src_text) >= 0.2
    shown = lang
    if lang in ("ta", "hi") and (mixed or args.source in ("tanglish", "hinglish")):
        shown = "tanglish" if lang == "ta" else "hinglish"
    target = args.target
    if target == "en" and lang == "en":
        out_words, how = src_words, "transcript"
    elif target == "ta" and lang == "ta":
        out_words, how = src_words, "transcript"
    elif target == "tanglish" and lang == "ta":
        out_words = [{"w": TL.tanglish(w["w"]), "s": w["s"], "e": w["e"]} for w in src_words]
        how = "romanized"
    elif target == "hinglish" and lang == "hi":
        out_words = [{"w": TL.hinglish(w["w"]), "s": w["s"], "e": w["e"]} for w in src_words]
        how = "romanized"
    else:
        # a translation (into English too): MADLAD-400 on the transcript, a whole sentence at a time. Whisper's own
        # "translate" pass listened a second time, was weaker on spoken Tamil and invented lines on Hindi film audio
        base = TARGET_BASE[target]
        if lang not in MT_LANGS:
            raise RuntimeError("Translating from %s to %s is not supported." % (LABELS.get(lang, lang), LABELS[target]))
        release(model)                                         # the speech model's memory, before 3 GB more
        emit("STATUS", "Loading the translator...")
        mt = Translator(args.cache)
        emit("STATUS", "Translating %s to %s..." % (LABELS.get(lang, lang), LABELS[target]))
        emit("PROGRESS", "0.700")
        units = sentence_units(raw_words)
        out_words = []
        for i in range(0, len(units), 8):                      # a few sentences per batch: steady progress
            chunk = units[i:i + 8]
            done = mt.translate([" ".join(w["w"] for p in u for w in p) for u in chunk], base)
            for u, t in zip(chunk, done):
                # the translator writes formal Tamil / Hindi: make it the spoken kind before romanising
                if spoken and base == "ta":
                    t = SP.tamil_text(t)
                elif spoken and base == "hi":
                    t = SP.hindi_text(t)
                if target == "tanglish":
                    t = TL.tanglish(t)
                elif target == "hinglish":
                    t = TL.hinglish(t)
                out_words += spread_over(t, [(p[0]["s"], p[-1]["e"]) for p in u])
            emit("PROGRESS", "%.3f" % (0.7 + 0.25 * min(1.0, (i + len(chunk)) / float(len(units)))))
        how = "mt"
    add_loudness(out_words, audio)
    emit("PROGRESS", "0.980")
    return {
        "source": {"lang": lang, "shown": shown, "label": LABELS.get(shown, shown), "detected": src_hint is None,
                   "probability": round(prob if src_hint is None else 1.0, 3), "text": src_text, "segments": segments},
        "target": target, "target_label": LABELS[target], "method": how,
        "language": lang, "duration": float(len(audio)) / SR, "words": out_words,
        "speech": [[round(a, 3), round(b, 3)] for a, b in layout.voiced],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--audio")
    ap.add_argument("--out")
    ap.add_argument("--model", default="large-v3", choices=sorted(MODEL_REPOS))
    ap.add_argument("--source", default="auto", choices=sorted(SOURCE_LANG))
    ap.add_argument("--target", default="en", choices=["en", "ta", "tanglish", "hinglish"])
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--cache", default=default_cache())
    ap.add_argument("--duration", type=float, default=0)
    ap.add_argument("--spoken", default="1", choices=["0", "1"], help="1: spoken Tamil / everyday Hindi (dala_spoken.py)")
    args = ap.parse_args()

    if args.check:
        import faster_whisper  # noqa: F401  (raises if the engine is not installed)
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import dala_models
        # a model counts only when every file is there with the right size and it was checksum-verified
        have = [n for n in MODEL_REPOS if dala_models.status(args.cache, n)["state"] == "ok"]
        gpu = {"devices": 0, "cublas": False}
        try:
            import ctranslate2
            gpu["devices"] = ctranslate2.get_cuda_device_count()
            if gpu["devices"] and os.name == "nt":
                add_cuda_dll_dirs()
                import ctypes
                ctypes.WinDLL("cublas64_12.dll")
                gpu["cublas"] = True
        except Exception:
            pass
        emit("OK", json.dumps({"faster_whisper": faster_whisper.__version__, "models": have, "cache": args.cache,
                               "gpu": gpu, "cuda_dir": private_cuda_dir(), "mt": mt_ready(args.cache)}))
        return 0

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if mt_needed(args.source, args.target) and not mt_ready(args.cache):
        emit("NEEDMT")                         # set the translator up first, before a pass that would be repeated
        return 3
    add_cuda_dll_dirs()
    t0 = time.time()
    emit("STATUS", "Loading the speech model...")
    path = ensure_model(args.model, args.cache)
    model, dev, ctype = load_model(path, args.device)
    emit("DEVICE", dev, ctype)
    try:
        result = run(args, model)
    except NeedMT:
        emit("NEEDMT")
        return 3
    except Exception as e:
        if dev == "cpu" or "not supported" in str(e) or isinstance(e, MTError):
            raise
        # CUDA can load fine and still fail on the first real batch (cuBLAS missing / out of memory).
        emit("STATUS", "GPU failed (%s); retrying on the CPU..." % str(e).splitlines()[0][:120])
        del model
        model, dev, ctype = load_model(path, "cpu")
        emit("DEVICE", dev, ctype)
        args.device = "cpu"
        try:
            result = run(args, model)
        except NeedMT:
            emit("NEEDMT")
            return 3
    result.update({"model": args.model, "device": dev, "compute_type": ctype, "seconds": round(time.time() - t0, 2)})
    tmp = args.out + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, args.out)
    emit("DONE", args.out)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        emit("ERROR", "Cancelled.")
        sys.exit(130)
    except Exception as exc:  # reported to the panel as one line
        emit("ERROR", (str(exc) or exc.__class__.__name__).replace("\n", " ")[:400])
        sys.exit(1)
