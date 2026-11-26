"""Dala Suite - Audio tools: Beat Marker and Vocal Remover (runs on the speech engine's private Python).

    python dala_audio.py check                                   OK {json}: vocal remover add-on + models
    python dala_audio.py beats --audio F --out J [--start S --end E] [--drums-out D.wav] [--method drums|mix]
                                                                 beat + drum-hit times (seconds from the file start)
    python dala_audio.py separate --audio F --out DIR --model htdemucs|htdemucs_ft [--name STEM]
Status lines on stdout like the other engine scripts: STATUS / DOWNLOAD / PROGRESS / DONE / ERROR.

Beat Marker needs nothing beyond the speech engine (PyAV decodes the audio, ONNX Runtime and NumPy do the rest),
the same steps as marking beats by eye on a drums-only track: the drums are extracted first (HT-Demucs FT drums,
ONNX - see "drums" below), then found on that drum track: onset strength (spectral flux of a log mel spectrogram)
-> tempo (autocorrelation, weighted towards musical tempos) -> beat positions by dynamic programming (Ellis 2007:
beats on strong onsets, spaced by the tempo), each snapped to the drum hit it falls on -> bar starts (the beat
phase of 4 with the strongest onsets). Drum hits (kicks, snares, accents) are the envelope's stand-out peaks.

Vocal Remover uses Demucs v4 (Meta, MIT licence) - htdemucs (fast) or htdemucs_ft (fine-tuned bag of four
models: better separation, about 4x slower) - from the add-on in %LOCALAPPDATA%\\DalaSuite\\audio (PyTorch CPU,
installed by the panel from requirements-audio.txt). Models come from models.json via dala_models.py
(resumed, checksum-verified). Output: "<name> - Vocals.wav" and "<name> - Instrumental.wav", 16-bit 44.1 kHz.
"""
import argparse
import json
import os
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def emit(kind, *parts):
    sys.stdout.write(kind + (" " + " ".join(str(p) for p in parts) if parts else "") + "\n")
    sys.stdout.flush()


def local_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(base, "DalaSuite")


def addon_dir():
    return os.path.join(local_dir(), "audio")


def decode(path, sr, channels):
    """Whole file -> float32 numpy array (channels, samples) at sr."""
    import av
    import numpy as np
    layout = "mono" if channels == 1 else "stereo"
    out = []
    with av.open(path) as f:
        st = next((s for s in f.streams if s.type == "audio"), None)
        if st is None:
            raise RuntimeError("The file has no audio track: " + path)
        rs = av.audio.resampler.AudioResampler(format="fltp", layout=layout, rate=sr)
        for frame in f.decode(st):
            for fr in rs.resample(frame):
                out.append(fr.to_ndarray())
        for fr in rs.resample(None):
            out.append(fr.to_ndarray())
    if not out:
        raise RuntimeError("No audio could be decoded from " + path)
    return np.concatenate(out, axis=1).astype("float32")


# ---------------------------------------------------------------------------------------------- beats

def mel_filters(sr, n_fft, n_mels=64, fmin=30.0, fmax=None):
    import numpy as np
    fmax = fmax or sr / 2.0
    mel = lambda f: 2595.0 * np.log10(1.0 + f / 700.0)
    inv = lambda m: 700.0 * (10 ** (m / 2595.0) - 1.0)
    pts = inv(np.linspace(mel(fmin), mel(fmax), n_mels + 2))
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    fb = np.zeros((n_mels, len(freqs)), "float32")
    for i in range(n_mels):
        lo, c, hi = pts[i], pts[i + 1], pts[i + 2]
        up = (freqs - lo) / max(c - lo, 1e-9)
        down = (hi - freqs) / max(hi - c, 1e-9)
        fb[i] = np.maximum(0.0, np.minimum(up, down))
    return fb


def onset_envelope(y, sr, hop, n_fft=2048, cymbals=0.5):
    """Onset strength: rise of a log mel spectrogram, averaged over mel bands (low notes - kick, bass - weigh
    as much as cymbals). Frame i is centred on sample i * hop. cymbals: weight of the bands above 2.5 kHz (0 for
    drum hits, so hi-hats and rides do not count as hits)."""
    import numpy as np
    win = np.hanning(n_fft).astype("float32")
    yp = np.pad(y, (n_fft // 2, n_fft // 2))
    n = 1 + max(0, (len(yp) - n_fft) // hop)
    if n < 4:
        return np.zeros(1, "float32")
    fb = mel_filters(sr, n_fft)
    # the beat lives in the kick / bass and the snare: low bands count 3x, mids 1.5x, cymbals 0.5x
    fmel = np.fft.rfftfreq(n_fft, 1.0 / sr)
    centres = (fb * fmel[None, :]).sum(1) / np.maximum(1e-9, fb.sum(1))
    bw = np.where(centres < 250, 3.0, np.where(centres < 2500, 1.5, cymbals)).astype("float32")
    bw /= bw.sum()
    env = np.zeros(n, "float32")
    prev = None
    step = 2048                                          # frames per block (keeps memory low on long songs)
    for s0 in range(0, n, step):
        idx = np.arange(n_fft)[None, :] + hop * np.arange(s0, min(n, s0 + step))[:, None]
        spec = np.abs(np.fft.rfft(yp[idx] * win, axis=1)) ** 2
        db = 10.0 * np.log10(np.maximum(1e-10, spec @ fb.T))
        db = np.maximum(db, db.max() - 80.0)
        if prev is not None:
            db = np.vstack([prev[None, :], db])
        d = (np.maximum(0.0, np.diff(db, axis=0)) * bw[None, :]).sum(axis=1)
        if prev is None:
            d = np.concatenate([[0.0], d])
        env[s0:s0 + len(d)] = d
        prev = db[-1]
    k = max(1, int(round(0.4 * sr / hop)))
    trend = np.convolve(env, np.ones(k) / k, mode="same")
    env = np.maximum(0.0, env - trend)
    sd = env.std()
    return env / sd if sd > 0 else env


def estimate_tempo(env, fps, lo=60.0, hi=200.0):
    import numpy as np
    n = len(env)
    e = env - env.mean()
    nf = 1 << int(np.ceil(np.log2(2 * n)))
    sp = np.fft.rfft(e, nf)
    ac = np.fft.irfft(sp * np.conj(sp), nf)[:n]           # autocorrelation (FFT: long songs stay fast)
    min_lag = int(round(fps * 60.0 / hi))
    max_lag = min(n - 1, int(round(fps * 60.0 / lo)))
    if max_lag <= min_lag + 2:
        return 120.0
    lags = np.arange(min_lag, max_lag + 1)
    bpm = 60.0 * fps / lags
    prior = np.exp(-0.5 * (np.log2(bpm / 120.0) / 0.9) ** 2)      # prefer musical tempos around 120
    score = ac[lags] * prior
    best = lags[int(np.argmax(score))]
    # parabolic refinement
    if min_lag < best < max_lag:
        a, b, c = score[best - min_lag - 1], score[best - min_lag], score[best - min_lag + 1]
        den = a - 2 * b + c
        off = 0.5 * (a - c) / den if den != 0 else 0.0
        best = best + max(-0.5, min(0.5, off))
    return 60.0 * fps / best


def track_beats(env, fps, bpm, tightness=100.0):
    import numpy as np
    period = fps * 60.0 / bpm
    n = len(env)
    # smooth the onset envelope with a window the size of one beat (Ellis)
    w = np.exp(-0.5 * (np.arange(-period, period + 1) * 32.0 / period) ** 2)
    local = np.convolve(env, w, mode="same")
    score = np.zeros(n)
    back = -np.ones(n, dtype=int)
    lo, hi = int(round(period / 2.0)), int(round(2.0 * period))
    offs = np.arange(-hi, -lo + 1)
    txcost = -tightness * (np.log(-offs / period)) ** 2
    for i in range(n):
        j = i + offs
        ok = j >= 0
        if ok.any():
            cand = score[j[ok]] + txcost[ok]
            k = int(np.argmax(cand))
            if cand[k] > 0:
                score[i] = local[i] + cand[k]
                back[i] = j[ok][k]
                continue
        score[i] = local[i]
    # last beat: the best-scoring frame near the end
    tail = score[max(0, n - int(2 * period)):]
    i = max(0, n - int(2 * period)) + int(np.argmax(tail))
    beats = []
    while i >= 0:
        beats.append(i)
        i = back[i]
    beats = np.array(beats[::-1])
    # drop weak beats at the edges (silence / fade)
    if len(beats) > 2:
        strength = local[beats]
        thr = 0.5 * np.median(strength)
        a, b = 0, len(beats)
        while a < b and strength[a] < thr:
            a += 1
        while b > a and strength[b - 1] < thr:
            b -= 1
        beats = beats[a:b]
    return beats, local


def bar_phase(beats, local):
    import numpy as np
    if len(beats) < 8:
        return 0
    s = local[beats]
    sums = [s[p::4].mean() for p in range(4)]
    return int(np.argmax(sums))


# ---------------------------------------------------------------------------------------------- drums (ONNX)
# HT-Demucs FT drums specialist exported to ONNX (StemSplitio/htdemucs-ft-drums-onnx, MIT). The graph takes a fixed
# 7.8 s stereo 44.1 kHz segment in [-1, 1] (it normalises internally) and returns 4 stems [drums, bass, other, vocals]
# of which only drums is meaningful. Long audio: segments with 25 % overlap, cross-faded (linear ramps), as in the
# model's reference infer.py; the ramps at the very start and end of the audio are flat so nothing fades out.

DRUMS_MODEL = "htdemucs_ft_drums"
DRUMS_FILE = "htdemucs_ft_drums_fp16weights.onnx"
DRUMS_SR = 44100
DRUMS_SEG = 343980


def drums_session(cache):
    import dala_models
    import onnxruntime as ort
    mdir = dala_models.ensure(cache, DRUMS_MODEL, quiet=True)
    # every run re-checks the checksum (166 MB hash, well under a second): a file damaged on disk after it was
    # verified would still load and give wrong drums
    if dala_models.status(cache, DRUMS_MODEL, deep=True)["state"] != "ok":
        emit("STATUS", "The drum model is damaged - downloading the damaged part again...")
        mdir = dala_models.ensure(cache, DRUMS_MODEL, quiet=True, verify=True)
    path = os.path.join(mdir, DRUMS_FILE)

    def load():
        so = ort.SessionOptions()
        # graph optimisation of this 24k-node export peaks at ~4.8 GB while the session loads and holds ~2.7 GB
        # while it runs (measured); without it the peak is ~1.2 GB - safe next to After Effects - with identical
        # output (max diff 1e-7), at the cost of ~15 s more start-up and ~10 % per segment
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        so.enable_cpu_mem_arena = False
        n = os.cpu_count() or 4
        so.intra_op_num_threads = max(1, n - 1 if n > 2 else n)     # leave After Effects a core
        return ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    try:
        sess = load()
    except Exception as e:
        # a model that does not load is re-checked byte by byte (and fetched again if damaged) once
        emit("STATUS", "The drum model did not load - checking it...")
        dala_models.ensure(cache, DRUMS_MODEL, quiet=True, verify=True)
        try:
            sess = load()
        except Exception as e2:
            raise RuntimeError("ONNX Runtime could not load the drum model (%s). Reinstall the audio engine "
                               "(Captions > Repair) and try again." % (str(e2) or str(e))[:200])
    i, o = sess.get_inputs()[0], sess.get_outputs()[0]
    if i.name != "mix" or list(i.shape)[-2:] != [2, DRUMS_SEG] or o.name != "stems":
        raise RuntimeError("The drum model file is not the expected HT-Demucs drums export.")
    return sess


def separate_drums(mix, sess, p0, p1):
    """mix: (2, n) float32 at 44.1 kHz -> drums (2, n). PROGRESS from p0 to p1."""
    import numpy as np
    n = mix.shape[1]
    overlap = DRUMS_SEG // 4
    stride = DRUMS_SEG - overlap
    chunks = max(1, -(-max(0, n - overlap) // stride))
    ramp = np.linspace(0.0, 1.0, overlap, dtype="float32")
    out = np.zeros((2, n), "float32")
    weight = np.zeros(n, "float32")
    for c in range(chunks):
        s = c * stride
        e = min(n, s + DRUMS_SEG)
        seg = mix[:, s:e]
        if seg.shape[1] < DRUMS_SEG:
            seg = np.pad(seg, ((0, 0), (0, DRUMS_SEG - seg.shape[1])))
        y = sess.run(["stems"], {"mix": seg[None].astype("float32")})[0][0, 0]
        if not np.isfinite(y).all():
            raise RuntimeError("The drum model returned invalid numbers (damaged model or out of memory).")
        w = np.ones(DRUMS_SEG, "float32")
        if c > 0:
            w[:overlap] = ramp
        if c < chunks - 1:
            w[-overlap:] = ramp[::-1]
        L = e - s
        out[:, s:e] += y[:, :L] * w[:L]
        weight[s:e] += w[:L]
        emit("PROGRESS", "%.3f" % (p0 + (p1 - p0) * (c + 1) / float(chunks)))
    return out / np.maximum(weight, 1e-6)


def level_db(y, hop, win):
    """Loudness (dB) around every analysis frame: RMS over win samples centred on sample i * hop."""
    import numpy as np
    c = np.concatenate([[0.0], np.cumsum(y.astype("float64") ** 2)])
    centres = np.arange(0, len(y) + hop, hop)
    a = np.clip(centres - win // 2, 0, len(y))
    b = np.clip(centres + win // 2, 0, len(y))
    ms = (c[b] - c[a]) / np.maximum(1, b - a)
    return 10.0 * np.log10(np.maximum(ms, 1e-12))


def pick_hits(env, fps, min_gap=0.09):
    """Drum hits: peaks of the drum onset envelope that stand out from their surroundings."""
    import numpy as np
    n = len(env)
    w = max(1, int(round(0.05 * fps)))
    k = max(3, int(round(1.5 * fps)))
    # local level: running median-ish (mean of the lower half) over 1.5 s, so loud sections do not swamp quiet ones
    pad = np.pad(env, (k // 2, k // 2), mode="edge")
    base = np.array([np.percentile(pad[i:i + k], 60) for i in range(0, n, max(1, w))])
    base = np.interp(np.arange(n), np.arange(0, n, max(1, w)), base)
    spread = np.percentile(env, 90) or 1.0
    hits = []
    for i in range(1, n - 1):
        lo, hi = max(0, i - w), min(n, i + w + 1)
        if env[i] < env[lo:hi].max() or env[i] <= env[i - 1]:
            continue
        if env[i] < base[i] + 0.35 * spread:
            continue
        if hits and (i - hits[-1]) / fps < min_gap:
            if env[i] > env[hits[-1]]:
                hits[-1] = i
            continue
        hits.append(i)
    hits = np.array(hits, dtype=int)
    st = env[hits] if len(hits) else np.zeros(0)
    ref = np.percentile(st, 90) if len(st) else 1.0
    st = np.minimum(1.0, st / (ref or 1.0))
    # ghost notes, cymbal bleed and other instruments leaking into the drum track stay well below a third of a
    # typical kick / snare (test songs: leaks <= 0.3, real hits >= 0.46)
    keep = st >= 0.33
    return hits[keep], st[keep]


def cmd_beats(a):
    import numpy as np
    sr = DRUMS_SR
    hop = 256                                             # 5.8 ms frames
    fps = sr / float(hop)
    emit("STATUS", "Reading the audio...")
    mix = decode(a.audio, sr, 2)
    s0 = max(0, int(round((a.start or 0.0) * sr)))
    s1 = mix.shape[1] if a.end is None else min(mix.shape[1], int(round(a.end * sr)))
    mix = mix[:, s0:s1]
    dur = mix.shape[1] / float(sr)
    if dur < 1.0:
        raise RuntimeError("The audio is too short to find a beat (%.1f s)." % dur)
    if float(np.abs(mix).max()) < 1e-4:
        raise RuntimeError("The audio is silent, so there is no beat to mark.")
    source = "mix"
    drums = None
    if a.method == "drums":
        emit("STATUS", "Checking the drum model...")
        sess = drums_session(a.cache)
        emit("STATUS", "Extracting the drums (%d s of audio, on the CPU)..." % round(dur))
        emit("PROGRESS", "0.02")
        drums = separate_drums(np.clip(mix, -1.0, 1.0), sess, 0.02, 0.85)
        del sess
        rms_mix = float(np.sqrt(np.mean(mix ** 2)))
        rms_drums = float(np.sqrt(np.mean(drums ** 2)))
        # a song without drums: the beat is found on the full mix instead (reported to the panel)
        source = "drums" if rms_drums > 0.05 * rms_mix and rms_drums > 1e-4 else "mix-nodrums"
        if a.drums_out and source == "drums":
            write_wav(a.drums_out, drums, sr)
        else:
            a.drums_out = None
    emit("STATUS", "Finding the beat...")
    y = (drums if source == "drums" else mix).mean(axis=0)
    env = onset_envelope(y, sr, hop, n_fft=2048)
    emit("PROGRESS", "0.9")
    bpm = float(a.bpm) if a.bpm else estimate_tempo(env, fps)
    beats, local = track_beats(env, fps, bpm)
    if len(beats) < 2:
        raise RuntimeError("No steady beat was found in this audio (speech or ambient sound?).")
    hits, hit_strength = pick_hits(onset_envelope(y, sr, hop, n_fft=2048, cymbals=0.0), fps)
    # the onset envelope is in decibels, so it does not know how loud the drums are: no beats where the track is
    # silent (gaps in an edit, intros) and no hits where the drums are only faint bleed
    lvl = level_db(y, hop, int(0.1 * sr))
    ref = np.percentile(lvl, 95)
    beats = beats[lvl[np.minimum(beats, len(lvl) - 1)] > ref - 40.0]
    if len(beats) < 2:
        raise RuntimeError("No steady beat was found in this audio (speech or ambient sound?).")
    if len(hits):
        loud = lvl[np.minimum(hits, len(lvl) - 1)] > ref - 18.0
        hits, hit_strength = hits[loud], hit_strength[loud]
    # a beat lands on the drum hit next to it (within 35 ms) when there is one: the tracker's grid is smooth,
    # the hit is where the transient really is
    if len(hits):
        snap = int(round(0.035 * fps))
        for k in range(len(beats)):
            j = int(np.argmin(np.abs(hits - beats[k])))
            if abs(hits[j] - beats[k]) <= snap:
                beats[k] = hits[j]
    # the spectral-flux peak comes a little before the audible transient; measured on test tracks
    lat = LATENCY
    times = np.maximum(0.0, beats / fps + lat)
    hit_times = np.maximum(0.0, hits / fps + lat)
    ibi = np.diff(times)
    bpm_tracked = 60.0 / float(np.median(ibi)) if len(ibi) else bpm
    phase = bar_phase(beats, local)
    strength = local[beats]
    strength = strength / (strength.max() or 1.0)
    off = s0 / float(sr)
    res = {"bpm": round(bpm_tracked, 2), "duration": round(dur, 3), "start": round(off, 4), "source": source,
           "beats": [round(float(t) + off, 4) for t in times], "strength": [round(float(v), 3) for v in strength],
           "barPhase": phase, "hits": [round(float(t) + off, 4) for t in hit_times],
           "hitStrength": [round(float(v), 3) for v in hit_strength], "drums": a.drums_out,
           "steadiness": round(float(1.0 - min(1.0, (ibi.std() / ibi.mean()) if len(ibi) > 1 else 0.0)), 3)}
    tmp = a.out + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(res, f)
    os.replace(tmp, a.out)
    emit("PROGRESS", "1")
    emit("DONE", a.out)
    return 0


LATENCY = 0.015


# ---------------------------------------------------------------------------------------------- separate

def need_addon():
    d = addon_dir()
    if not os.path.isdir(os.path.join(d, "demucs")) or not os.path.exists(os.path.join(d, ".dala-ok")):
        emit("NEEDADDON")
        sys.exit(3)
    sys.path.insert(0, d)


def write_wav(path, data, sr):
    import numpy as np
    x = np.clip(data.T, -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2")
    tmp = path + ".part"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


def cmd_separate(a):
    need_addon()
    import dala_models
    import numpy as np
    cache = a.cache
    emit("STATUS", "Checking the vocal remover model...")
    mdir = dala_models.ensure(cache, a.model, quiet=True)
    import torch
    import tqdm as _tqdm
    from pathlib import Path
    import demucs
    from demucs import pretrained, apply as dapply
    # demucs reads its bag definitions (<name>.yaml) from the folder that holds the weights
    src_yaml = os.path.join(os.path.dirname(demucs.__file__), "remote", a.model + ".yaml")
    dst_yaml = os.path.join(mdir, a.model + ".yaml")
    if not os.path.exists(dst_yaml):
        with open(src_yaml, "rb") as fi, open(dst_yaml + ".part", "wb") as fo:
            fo.write(fi.read())
        os.replace(dst_yaml + ".part", dst_yaml)
    n = os.cpu_count() or 4
    torch.set_num_threads(max(1, n // 2 if n >= 4 else n))
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    emit("DEVICE", dev)
    emit("STATUS", "Loading the vocal remover (%s)..." % a.model)
    model = pretrained.get_model(a.model, repo=Path(mdir))
    model.eval()
    sr = model.samplerate
    emit("STATUS", "Reading the audio...")
    wav = decode(a.audio, sr, 2)
    if wav.shape[1] < sr // 2:
        raise RuntimeError("The audio is too short to separate.")
    t = torch.from_numpy(wav)
    ref = t.mean(0)
    mean, std = ref.mean(), ref.std()
    if float(std) < 1e-6:
        raise RuntimeError("The audio is silent.")
    t = (t - mean) / std
    n_models = len(getattr(model, "models", [model]))
    state = {"done": 0, "total": 1, "model": 0}

    class Prog(_tqdm.tqdm):
        """demucs reports each chunk through tqdm: turned into PROGRESS lines for the panel."""

        def __init__(self, *args, **kw):
            kw["disable"] = True
            super().__init__(*args, **kw)
            self._it = args[0] if args else kw.get("iterable")
            self._n = kw.get("total") or (len(self._it) if hasattr(self._it, "__len__") else 1)

        def __iter__(self):
            for i, x in enumerate(self._it):
                yield x
                frac = (state["model"] + (i + 1) / float(self._n)) / float(n_models)
                emit("PROGRESS", "%.3f" % min(0.99, frac))
            state["model"] = min(n_models - 1, state["model"] + 1)

    dapply.tqdm.tqdm = Prog
    emit("STATUS", "Separating the vocals (%s, %s)..." % (a.model, "GPU" if dev == "cuda" else "CPU"))
    t0 = time.time()
    with torch.no_grad():
        out = dapply.apply_model(model, t[None], device=dev, shifts=1, split=True, overlap=0.25, progress=True, num_workers=0)[0]
    out = out * std + mean
    names = list(model.sources)
    vi = names.index("vocals")
    vocals = out[vi].numpy()
    inst = (out.sum(0) - out[vi]).numpy()
    os.makedirs(a.out, exist_ok=True)
    stem = a.name or os.path.splitext(os.path.basename(a.audio))[0]
    pv = os.path.join(a.out, "%s - Vocals.wav" % stem)
    pi = os.path.join(a.out, "%s - Instrumental.wav" % stem)
    write_wav(pv, vocals, sr)
    write_wav(pi, inst, sr)
    res = {"vocals": pv, "instrumental": pi, "seconds": round(time.time() - t0, 1), "device": dev, "model": a.model,
           "duration": round(wav.shape[1] / float(sr), 3)}
    with open(os.path.join(a.out, "dala-stems.json"), "w", encoding="utf-8") as f:
        json.dump(res, f)
    emit("PROGRESS", "1")
    emit("DONE", json.dumps(res))
    return 0


def cmd_check(a):
    import dala_models
    d = addon_dir()
    ok = os.path.isdir(os.path.join(d, "demucs")) and os.path.exists(os.path.join(d, ".dala-ok"))
    res = {"addon": ok, "addonDir": d, "models": {}}
    for n in ("htdemucs", "htdemucs_ft", DRUMS_MODEL):
        res["models"][n] = dala_models.status(a.cache, n)["state"]
    try:
        import onnxruntime  # noqa: F401  (Beat Marker runs on the speech engine's onnxruntime)
        res["onnxruntime"] = onnxruntime.__version__
    except Exception as e:
        res["onnxruntime"] = None
        res["onnxError"] = str(e)[:300]
    if ok and a.imports:
        sys.path.insert(0, d)
        try:
            import torch  # noqa: F401
            import demucs.pretrained  # noqa: F401
            res["imports"] = True
        except Exception as e:
            res["imports"] = False
            res["importError"] = str(e)[:300]
    emit("OK", json.dumps(res))
    return 0


def main():
    import dala_models
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["check", "beats", "separate"])
    ap.add_argument("--audio")
    ap.add_argument("--out")
    ap.add_argument("--model", default="htdemucs", choices=["htdemucs", "htdemucs_ft"])
    ap.add_argument("--name")
    ap.add_argument("--bpm", type=float)
    ap.add_argument("--start", type=float, help="beats: analyse from this time in the file (seconds)")
    ap.add_argument("--end", type=float, help="beats: analyse up to this time in the file (seconds)")
    ap.add_argument("--method", default="drums", choices=["drums", "mix"], help="beats: find the beat on the extracted drums or the full mix")
    ap.add_argument("--drums-out", help="beats: also save the extracted drums as a WAV file")
    ap.add_argument("--imports", action="store_true")
    ap.add_argument("--cache", default=dala_models.default_cache())
    a = ap.parse_args()
    if a.cmd == "check":
        return cmd_check(a)
    if not a.audio or not os.path.exists(a.audio):
        raise RuntimeError("Audio file not found: %s" % a.audio)
    if a.cmd == "beats":
        return cmd_beats(a)
    return cmd_separate(a)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except KeyboardInterrupt:
        emit("ERROR", "Cancelled.")
        sys.exit(130)
    except Exception as exc:
        msg = (str(exc) or exc.__class__.__name__).replace("\n", " ")[:400]
        if "No space left" in msg or "Errno 28" in msg:
            msg = "The disk is full: free some space and try again."
        emit("ERROR", msg)
        sys.exit(1)
