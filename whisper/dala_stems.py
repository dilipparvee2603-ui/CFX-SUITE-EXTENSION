"""Dala Suite - Music Stems: drums, bass, guitar, piano and other from a song (runs on the speech engine's Python).

    python dala_stems.py check [--model-file F]          OK {json}: engine libraries, the 6-stem model's state
    python dala_stems.py split --audio F --out DIR --name NAME [--start S --end E] [--overwrite]
                                                         five WAV stems of file time S..E (whole file by default)
    python dala_stems.py adopt --model-file F            reuse a copy of the model already on this PC (verified)
Status lines on stdout like the other engine scripts: STATUS / DOWNLOAD / PROGRESS / PARTS / DONE / ERROR / OK.

The model is HT-Demucs 6-stem (Meta, MIT) exported to ONNX by StemSplit (StemSplitio/htdemucs-6s-onnx, fp16
weights, 136 MB, pinned in models.json). It returns six stems in the order drums, bass, other, vocals, guitar,
piano; Dala keeps the five instrumental ones (vocals is never written). The graph takes a fixed 7.8 s stereo
44.1 kHz segment (it normalises internally); long audio is cut into segments with 25 % overlap and cross-faded
(linear ramps, flat at the very start and end), as in the model's reference infer.py.

Everything streams: the audio is decoded a few seconds at a time (PyAV) and each stem is written to its WAV as
soon as a stretch of it is final, so memory stays at about 1.5 GB whatever the length. Output: 32-bit float WAV,
44.1 kHz stereo (no clipping, and the five stems plus the vocals add back up to the mix), exactly as long as the
requested span: sample 0 of every stem is file time S, so a stem placed at the layer's in point lines up.
"""
import argparse
import json
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

MODEL = "htdemucs_6s"
MODEL_FILE = "htdemucs_6s_fp16weights.onnx"
SR = 44100
SEG = 343980                                    # 7.8 s: the graph's fixed input length
OVERLAP = SEG // 4
STRIDE = SEG - OVERLAP
SOURCES = ("drums", "bass", "other", "vocals", "guitar", "piano")       # the graph's output order
STEMS = ("drums", "bass", "guitar", "piano", "other")                  # what Dala writes, in layer order
TITLES = {"drums": "Drums", "bass": "Bass", "guitar": "Guitar", "piano": "Piano", "other": "Other"}


def emit(kind, *parts):
    sys.stdout.write(kind + (" " + " ".join(str(p) for p in parts) if parts else "") + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------------------------- model

def model_path(cache):
    """The verified model file, reusing a copy already on this PC or downloading it (resumed, checked)."""
    import dala_models
    mdir = dala_models.ensure(cache, MODEL, quiet=True)
    # every run re-checks the checksum (136 MB, well under a second): a file damaged on disk after it was verified
    # would still load and give wrong stems
    if dala_models.status(cache, MODEL, deep=True)["state"] != "ok":
        emit("STATUS", "The stems model is damaged - downloading it again...")
        mdir = dala_models.ensure(cache, MODEL, quiet=True, verify=True)
    return os.path.join(mdir, MODEL_FILE)


def session(cache):
    import dala_models
    import onnxruntime as ort
    path = model_path(cache)

    def load():
        so = ort.SessionOptions()
        # like the drum model: graph optimisation of these big Demucs exports costs gigabytes while the session
        # loads; without it the peak stays near 1.2 GB (safe next to After Effects) with the same output
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        so.enable_cpu_mem_arena = False
        n = os.cpu_count() or 4
        so.intra_op_num_threads = max(1, n - 1 if n > 2 else n)     # leave After Effects a core
        return ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    emit("STATUS", "Loading the 6-stem model (about 15 s)...")
    try:
        sess = load()
    except Exception as e:
        # a model that does not load is re-checked byte by byte (and fetched again if damaged) once
        emit("STATUS", "The stems model did not load - checking it...")
        dala_models.ensure(cache, MODEL, quiet=True, verify=True)
        try:
            sess = load()
        except Exception as e2:
            raise RuntimeError("ONNX Runtime could not load the stems model (%s). Repair the audio engine with the "
                               "button at the top and try again." % (str(e2) or str(e))[:200])
    check_graph(sess)
    return sess


def check_graph(sess):
    """The model must be the 6-stem HT-Demucs export: one stereo 7.8 s input, six stereo stems out."""
    ins, outs = sess.get_inputs(), sess.get_outputs()
    shape = list(ins[0].shape) if ins else []
    oshape = list(outs[0].shape) if outs else []
    if (len(ins) != 1 or ins[0].name != "mix" or shape[-2:] != [2, SEG] or len(outs) != 1 or outs[0].name != "stems"
            or len(oshape) != 4):
        raise RuntimeError("The stems model file is not the expected HT-Demucs 6-stem export.")


# ---------------------------------------------------------------------------------------------- audio in

def probe(path):
    """(duration of the file in seconds or None, description of its first audio track)"""
    import av
    with av.open(path) as f:
        st = next((s for s in f.streams if s.type == "audio"), None)
        if st is None:
            raise RuntimeError("This file has no audio track: " + os.path.basename(path))
        dur = f.duration / 1e6 if f.duration else None
        lay = st.codec_context.layout.name if st.codec_context.layout else "%d ch" % st.codec_context.channels
        return dur, "%s %s Hz %s" % (st.codec_context.name, st.codec_context.sample_rate, lay)


INT_SCALE = {"u8": 128.0, "s16": 32768.0, "s32": 2147483648.0, "s64": 9223372036854775808.0}


def frame_samples(fr):
    """A decoded frame as planar float32 (channels, n), whatever its sample format."""
    import numpy as np
    a = fr.to_ndarray()
    ch = len(fr.layout.channels)
    if not fr.format.is_planar:
        a = a.reshape(-1, ch).T
    name = fr.format.name.rstrip("p")
    if name == "u8":
        return ((a.astype("float32") - 128.0) / 128.0)
    if name in INT_SCALE:
        return (a.astype("float64") / INT_SCALE[name]).astype("float32")
    return a.astype("float32", copy=False)


def read_span(path, start, end):
    """Yields float32 (2, n) blocks of the file's first audio track (the one After Effects plays), resampled to
    44.1 kHz stereo, covering file time [start, end) exactly: sample 0 is file time `start`; silence is added where
    the track has no audio (before it begins, after it ends). File time 0 is the container's start, as in After
    Effects. Mono is doubled to both sides, surround is folded down to stereo.
    Every decoded frame is placed by its own timestamp (at the track's own rate, before resampling): a gap between
    frames is filled with silence and an overlap trimmed, so a seek lands on the same sample as a read from the
    start (an Opus track in MP4 has a 1 ms gap after its first frame, for one). Differences smaller than the
    container's timestamp precision (1 ms in Matroska) are rounding, not gaps, and are left alone."""
    import av
    import numpy as np
    want = int(round((end - start) * SR))
    sent = 0
    with av.open(path) as f:
        st = next((s for s in f.streams if s.type == "audio"), None)
        if st is None:
            raise RuntimeError("This file has no audio track: " + os.path.basename(path))
        st.thread_type = "AUTO"
        origin = (f.start_time or 0) / 1e6
        if start > 3.0:
            # seek a little early (to a packet before `start`), then cut to the exact sample below
            f.seek(int((origin + start - 3.0) * 1e6), backward=True, any_frame=False)
        rs = av.audio.resampler.AudioResampler(format="fltp", layout="stereo", rate=SR)
        skip = None                                       # output samples to drop at the front
        nat = None                                        # the track's own rate
        nxt = None                                        # native sample position the next frame should start at
        tol = 2

        def take(arr):
            nonlocal skip, sent
            if skip > 0:
                cut = min(skip, arr.shape[1])
                arr = arr[:, cut:]
                skip -= cut
            if arr.shape[1] == 0 or sent >= want:
                return None
            arr = arr[:, :want - sent]
            sent += arr.shape[1]
            return arr

        def resample(a, layout):
            fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(a), format="fltp", layout=layout)
            fr.sample_rate = nat
            for o in rs.resample(fr):
                b = take(o.to_ndarray().astype("float32", copy=False))
                if b is not None:
                    yield b

        for frame in f.decode(st):
            if not frame.samples:
                continue
            a = frame_samples(frame)
            layout = frame.layout.name
            t = (frame.time if frame.time is not None else None)
            if nat is None:
                nat = frame.sample_rate
                tb = float(st.time_base) if st.time_base else 0.0
                tol = max(2, int(round(1.5 * tb * nat)))
                t0 = (t if t is not None else origin) - origin
                nxt = int(round(t0 * nat))
                skip = int(round((start - t0) * SR))
                if skip < 0:                              # the track starts after `start`: silence first
                    lead = min(-skip, want)
                    sent += lead
                    yield np.zeros((2, lead), "float32")
                    skip = 0
            elif t is not None:
                pos = int(round((t - origin) * nat))
                if pos - nxt > tol:                       # a gap: silence until this frame
                    for b in resample(np.zeros((a.shape[0], pos - nxt), "float32"), layout):
                        yield b
                    nxt = pos
                elif nxt - pos > tol:                     # an overlap: drop what was already played
                    a = a[:, nxt - pos:]
            if a.shape[1]:
                for b in resample(a, layout):
                    yield b
                nxt += a.shape[1]
            if sent >= want:
                return
        if nat is not None:
            for o in rs.resample(None):
                b = take(o.to_ndarray().astype("float32", copy=False))
                if b is not None:
                    yield b
    if sent < want:                                       # the track ends early: pad to the requested length
        yield np.zeros((2, want - sent), "float32")


class Feeder(object):
    """Hands out the 7.8 s windows of the span from the streamed blocks, keeping only what is still needed."""

    def __init__(self, blocks):
        import numpy as np
        self.np = np
        self.blocks = blocks
        self.buf = np.zeros((2, 0), "float32")
        self.pos = 0                                      # span sample of buf[:, 0]
        self.done = False

    def window(self, s, n):
        np = self.np
        while not self.done and self.pos + self.buf.shape[1] < s + n:
            try:
                b = next(self.blocks)
            except StopIteration:
                self.done = True
                break
            self.buf = np.concatenate([self.buf, b], axis=1)
        a = self.buf[:, s - self.pos:s - self.pos + n]
        if a.shape[1] < n:
            a = np.pad(a, ((0, 0), (0, n - a.shape[1])))
        return a

    def release(self, s):
        """Drops everything before span sample s."""
        cut = s - self.pos
        if cut > 0:
            self.buf = self.buf[:, cut:]
            self.pos = s


# ---------------------------------------------------------------------------------------------- audio out

class FloatWav(object):
    """Streaming 32-bit float WAV (WAVE_FORMAT_IEEE_FLOAT), written to path + '.part'; the sizes in the header are
    filled in by close()."""

    def __init__(self, path, channels, rate):
        self.path, self.part = path, path + ".part"
        self.ch = channels
        self.n = 0
        self.f = open(self.part, "wb")
        self.f.write(self._header(0))

    def _header(self, frames):
        data = frames * self.ch * 4
        fmt = struct.pack("<HHIIHH", 3, self.ch, SR, SR * self.ch * 4, self.ch * 4, 32)
        fact = struct.pack("<4sII", b"fact", 4, frames)
        return (struct.pack("<4sI4s", b"RIFF", 4 + (8 + len(fmt)) + len(fact) + 8 + data, b"WAVE") +
                struct.pack("<4sI", b"fmt ", len(fmt)) + fmt + fact + struct.pack("<4sI", b"data", data))

    def write(self, x):
        """x: (channels, n) float32"""
        import numpy as np
        self.f.write(np.ascontiguousarray(x.T, dtype="<f4").tobytes())
        self.n += x.shape[1]

    def close(self):
        self.f.seek(0)
        self.f.write(self._header(self.n))
        self.f.close()

    def discard(self):
        try:
            self.f.close()
        except Exception:
            pass
        try:
            os.remove(self.part)
        except OSError:
            pass


def final_name(path, overwrite):
    """Where a finished stem goes. After Effects does not lock the files it imported, so an existing file is only
    replaced when the panel says the name stands for the same source and span (overwrite: the same content);
    otherwise - or when it cannot be removed - the next free 'name (2).wav', 'name (3).wav'... is used, so a stem
    another layer plays never changes under it."""
    base, ext = os.path.splitext(path)
    cand, k = path, 2
    while os.path.exists(cand):
        if overwrite:
            try:
                os.remove(cand)
                break
            except OSError:
                pass
        cand = "%s (%d)%s" % (base, k, ext)
        k += 1
    return cand


# ---------------------------------------------------------------------------------------------- split

def cmd_split(a):
    import shutil
    import numpy as np
    start = max(0.0, a.start or 0.0)
    emit("STATUS", "Reading the audio...")
    dur, desc = probe(a.audio)
    # the panel asks for the layer's own span (its in to out point in file time); stems keep exactly that length,
    # with silence where the file's audio is shorter, so they line up with the layer from start to end
    end = a.end if a.end is not None else dur
    if end is None:
        raise RuntimeError("The length of this audio file could not be read. Render it to WAV and try again.")
    if dur is not None:
        end = min(end, dur + 1.0)
    span = end - start
    if span < 0.5:
        raise RuntimeError("The audio is too short to split into stems (%.2f s)." % max(0.0, span))
    total = int(round(span * SR))
    os.makedirs(a.out, exist_ok=True)
    need = total * 2 * 4 * len(STEMS) + 50 * 1024 * 1024
    try:
        free = shutil.disk_usage(a.out).free
    except OSError:
        free = None
    if free is not None and free < need:
        raise RuntimeError("Not enough free disk space for the stems: they need %.1f GB, %s has %.1f GB free."
                           % (need / 1e9, a.out, free / 1e9))
    emit("STATUS", "Checking the stems model...")
    sess = session(a.cache)
    chunks = max(1, -(-max(0, total - OVERLAP) // STRIDE))
    emit("STATUS", "Splitting %s into stems on the CPU (%d parts)..." % (fmt_time(span), chunks))
    emit("PROGRESS", "0.01")
    idx = [SOURCES.index(s) for s in STEMS]
    paths = dict((s, os.path.join(a.out, "%s - %s.wav" % (a.name, TITLES[s]))) for s in STEMS)
    outs = dict((s, FloatWav(paths[s], 2, SR)) for s in STEMS)
    emit("PARTS", json.dumps([w.part for w in outs.values()]))
    t0 = time.time()
    try:
        feed = Feeder(read_span(a.audio, start, end))
        ramp = np.linspace(0.0, 1.0, OVERLAP, dtype="float32")
        acc = np.zeros((len(STEMS), 2, SEG), "float32")
        wacc = np.zeros(SEG, "float32")
        energy = np.zeros(len(STEMS), "float64")
        mix_energy = 0.0
        peak = 0.0
        for c in range(chunks):
            s = c * STRIDE
            L = min(SEG, total - s)
            x = feed.window(s, SEG)
            ready = STRIDE if c < chunks - 1 else L       # this much of the span is final after this part
            mix_energy += float(np.sum(x[:, :ready].astype("float64") ** 2))
            y = sess.run(["stems"], {"mix": x[None].astype("float32")})[0]
            if y.shape[1:] != (len(SOURCES), 2, SEG):
                raise RuntimeError("The stems model returned an unexpected shape %s." % (y.shape,))
            y = y[0][idx]
            if not np.isfinite(y).all():
                raise RuntimeError("The stems model returned invalid numbers (damaged model or out of memory).")
            w = np.ones(SEG, "float32")
            if c > 0:
                w[:OVERLAP] = ramp
            if c < chunks - 1:
                w[-OVERLAP:] = ramp[::-1]
            acc[:, :, :L] += y[:, :, :L] * w[:L]
            wacc[:L] += w[:L]
            out = acc[:, :, :ready] / np.maximum(wacc[:ready], 1e-6)
            for k, st in enumerate(STEMS):
                outs[st].write(out[k])
                energy[k] += float(np.sum(out[k].astype("float64") ** 2))
            peak = max(peak, float(np.abs(out).max()))
            acc = np.concatenate([acc[:, :, ready:], np.zeros((len(STEMS), 2, ready), "float32")], axis=2)
            wacc = np.concatenate([wacc[ready:], np.zeros(ready, "float32")])
            feed.release(s + STRIDE)
            emit("PROGRESS", "%.3f" % (0.01 + 0.97 * (c + 1) / float(chunks)))
        del sess
    except BaseException:
        for w in outs.values():
            w.discard()
        raise
    files, silent = {}, []
    for k, st in enumerate(STEMS):
        w = outs[st]
        w.close()
        dst = final_name(paths[st], a.overwrite)
        os.replace(w.part, dst)
        files[st] = dst
        # a stem 45 dB below the song (no piano in a rock song...) is reported, but still delivered
        if energy[k] < max(1e-9, mix_energy) * 10 ** (-45 / 10.0):
            silent.append(st)
    res = {"files": files, "order": list(STEMS), "start": round(start, 6), "duration": round(total / float(SR), 6),
           "seconds": round(time.time() - t0, 1), "silent": silent, "peak": round(peak, 4), "source": desc,
           "sampleRate": SR}
    with open(os.path.join(a.out, "dala-music-stems.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1)
    emit("PROGRESS", "1")
    emit("DONE", json.dumps(res))
    return 0


def fmt_time(s):
    s = int(round(s))
    return "%d:%02d" % (s // 60, s % 60) if s < 3600 else "%d:%02d:%02d" % (s // 3600, s // 60 % 60, s % 60)


# ---------------------------------------------------------------------------------------------- check / adopt

def cmd_check(a):
    import dala_models
    res = {"model": dala_models.status(a.cache, MODEL), "sizeBytes": dala_models.total_size(dala_models.catalog()[MODEL])}
    try:
        import numpy
        import av
        import onnxruntime
        res["engine"] = {"numpy": numpy.__version__, "av": av.__version__, "onnxruntime": onnxruntime.__version__}
    except Exception as e:
        res["engine"] = None
        res["engineError"] = (str(e) or e.__class__.__name__)[:300]
    if a.load and res["engine"] and res["model"]["state"] == "ok":
        try:
            emit("STATUS", "Loading the stems model...")
            check_graph(session(a.cache))
            res["loads"] = True
        except Exception as e:
            res["loads"] = False
            res["loadError"] = str(e)[:300]
    emit("OK", json.dumps(res))
    return 0


def cmd_adopt(a):
    import dala_models
    if not a.model_file or not os.path.isfile(a.model_file):
        raise RuntimeError("Model file not found: %s" % a.model_file)
    emit("STATUS", "Checking %s..." % os.path.basename(a.model_file))
    d = dala_models.adopt(a.cache, MODEL, a.model_file)
    emit("DONE", d)
    return 0


def main():
    import dala_models
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["check", "split", "adopt"])
    ap.add_argument("--audio")
    ap.add_argument("--out")
    ap.add_argument("--name")
    ap.add_argument("--start", type=float, help="split: from this file time (seconds)")
    ap.add_argument("--end", type=float, help="split: up to this file time (seconds)")
    ap.add_argument("--model-file", help="adopt: a copy of htdemucs_6s_fp16weights.onnx already on this PC")
    ap.add_argument("--load", action="store_true", help="check: also load the model")
    ap.add_argument("--overwrite", action="store_true", help="split: replace stems of the same name (same source and span)")
    ap.add_argument("--cache", default=dala_models.default_cache())
    a = ap.parse_args()
    if a.cmd == "check":
        return cmd_check(a)
    if a.cmd == "adopt":
        return cmd_adopt(a)
    if not a.audio or not os.path.exists(a.audio):
        raise RuntimeError("Audio file not found: %s" % a.audio)
    if not a.out or not a.name:
        raise RuntimeError("split needs --out and --name")
    return cmd_split(a)


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
        if exc.__class__.__name__ == "ModelError":
            emit("MODELERROR", getattr(exc, "code", ""))
        emit("ERROR", msg)
        sys.exit(1)
