"""CFX Suite - model downloads for Auto Captions (Whisper, NLLB translator) and the Audio tools (Demucs).

Every model is pinned in models.json: the exact files, sizes and checksums (SHA-256, or the git blob SHA-1 for
small text files) at a fixed revision. A model counts as installed only when its folder holds every file with
the right size and a manifest (dala-model.json) written after the checksums matched - a progress bar reaching
100% proves nothing. Downloads:
  - resume (HTTP Range) after an interruption, retry network errors, and check free disk space first
  - never run twice for the same model (a lock file; a second window gets a clear message)
  - are hashed as they arrive and checked when each file completes; a damaged file is fetched again once
Layout: <cache>/models/<name>/<files>  (no Hugging Face cache: on PCs without symlink support it kept a second
full copy of every model, which also made the old progress read "5.97 GB of 3.09 GB").
A copy already on this PC is reused instead of downloaded: the Hugging Face cache other tools fill and the usual
download folders are searched (same name and size, then the checksum), and `adopt` takes a file the user points
at - only when its size and SHA-256 are the pinned ones. Status reports such a copy as "found".

    python dala_models.py status [--deep] [--cache DIR] [--names a,b]   JSON per model: ok | missing | incomplete | corrupt
    python dala_models.py download NAME [--cache DIR]                   STATUS / DOWNLOAD <done> <total> / DONE <dir> / ERROR
    python dala_models.py adopt NAME --file F [--cache DIR]             STATUS / DONE <dir> / ERROR
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = "dala-model.json"
CHUNK = 1 << 20


def emit(kind, *parts):
    sys.stdout.write(kind + (" " + " ".join(str(p) for p in parts) if parts else "") + "\n")
    sys.stdout.flush()


def default_cache():
    d = os.path.join(os.path.expanduser("~"), ".cache", "dala_whisper")
    if os.path.isdir(d): return d
    return os.path.join(os.path.expanduser("~"), ".cache", "cfx_whisper")


def catalog():
    with open(os.path.join(HERE, "models.json"), encoding="utf-8") as f:
        return json.load(f)["models"]


def model_dir(cache, name):
    return os.path.join(cache, "models", name)


def total_size(spec):
    return sum(f["size"] for f in spec["files"])


class ModelError(Exception):
    """A message for the panel (code: network | disk | permission | corrupt | busy)."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


# ---------------------------------------------------------------------------------------------- checks

def _hasher(fspec):
    return hashlib.sha256() if fspec.get("sha256") else hashlib.sha1()


def _expected(fspec):
    return fspec.get("sha256") or fspec.get("git_sha1")


def _start_hash(fspec):
    h = _hasher(fspec)
    if not fspec.get("sha256"):
        h.update(b"blob %d\0" % fspec["size"])        # git blob id of a small (non-LFS) file
    return h


def file_ok(path, fspec, deep):
    try:
        if os.path.getsize(path) != fspec["size"]:
            return False
    except OSError:
        return False
    if not deep:
        return True
    h = _start_hash(fspec)
    with open(path, "rb") as f:
        for buf in iter(lambda: f.read(CHUNK * 4), b""):
            h.update(buf)
    return h.hexdigest() == _expected(fspec)


def status(cache, name, deep=False):
    spec = catalog()[name]
    d = model_dir(cache, name)
    have, files = 0, []
    manifest = None
    try:
        with open(os.path.join(d, MANIFEST), encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        manifest = None
    corrupt = complete = 0
    for fs in spec["files"]:
        p = os.path.join(d, fs["name"])
        part = p + ".part"
        size = os.path.getsize(p) if os.path.exists(p) else (os.path.getsize(part) if os.path.exists(part) else 0)
        have += min(size, fs["size"])
        if not os.path.exists(p):
            files.append({"name": fs["name"], "state": "incomplete" if size else "missing"})
            continue
        ok = file_ok(p, fs, deep)
        files.append({"name": fs["name"], "state": "ok" if ok else "corrupt"})
        if ok:
            complete += 1
        else:
            corrupt += 1
    if corrupt:
        state = "corrupt"
    elif complete == len(spec["files"]) and manifest and manifest.get("revision") == spec.get("revision"):
        state = "ok"
    elif have == 0:
        state = "missing"
    else:
        state = "incomplete"                          # partly there, or never verified as a whole
    res = {"name": name, "state": state, "bytes": have, "total": total_size(spec), "dir": d, "files": files,
           "label": spec.get("label", name), "checked": "deep" if deep else "size"}
    if state != "ok":
        found = _find_copies(cache, spec, d)
        if found:
            res["found"] = found                      # a copy elsewhere on this PC (same names and sizes; the
                                                      # checksums are checked when it is reused)
    return res


# ---------------------------------------------------------------------------------------------- download

class _Lock(object):
    """One download per model across processes (a second panel / After Effects window)."""

    def __init__(self, path):
        self.path = path
        self.fh = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.fh = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.fh.close()
            raise ModelError("busy", "This model is already being downloaded (another After Effects window?). "
                                     "Wait for it to finish, then try again.")
        return self

    def __exit__(self, *a):
        try:
            if os.name == "nt":
                import msvcrt
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        self.fh.close()


def _url(spec, fs):
    if spec["source"] == "hf":
        return "https://huggingface.co/%s/resolve/%s/%s" % (spec["repo"], spec["revision"], fs["name"])
    return spec["base_url"] + fs["name"]


def _fetch(url, part, fspec, progress, done_before, total):
    """Downloads url into part, resuming; returns when the file is complete and checked."""
    h = _start_hash(fspec)
    have = 0
    if os.path.exists(part):
        have = os.path.getsize(part)
        if have > fspec["size"]:
            os.remove(part)
            have = 0
        else:
            with open(part, "rb") as f:                  # re-hash what is already there
                for buf in iter(lambda: f.read(CHUNK * 4), b""):
                    h.update(buf)
    tries = 0
    while have < fspec["size"]:
        req = urllib.request.Request(url, headers={"User-Agent": "DalaSuite/2.0.6"})
        if have:
            req.add_header("Range", "bytes=%d-" % have)
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                if have and r.status != 206:              # the server ignored the range: start over
                    have = 0
                    h = _start_hash(fspec)
                    mode = "wb"
                else:
                    mode = "ab" if have else "wb"
                with open(part, mode) as out:
                    last = 0.0
                    while True:
                        buf = r.read(CHUNK)
                        if not buf:
                            break
                        out.write(buf)
                        h.update(buf)
                        have += len(buf)
                        now = time.time()
                        if now - last > 0.4:
                            progress(done_before + have, total)
                            last = now
            tries = 0
        except urllib.error.HTTPError as e:
            if e.code == 416 and have >= fspec["size"]:
                break
            tries += 1
            if tries > 5 or e.code in (401, 403, 404):
                raise ModelError("network", "The download server answered %d for %s. Try again later." % (e.code, fspec["name"]))
            time.sleep(min(30, 2 ** tries))
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            if isinstance(e, OSError) and getattr(e, "errno", None) == 28:
                raise ModelError("disk", "The disk is full: not enough free space to finish downloading %s." % fspec["name"])
            if isinstance(e, PermissionError):
                raise ModelError("permission", "Windows blocked writing %s (%s)." % (part, e))
            tries += 1
            if tries > 6:
                raise ModelError("network", "The download of %s keeps failing (%s). Check the internet connection "
                                            "(and any firewall or proxy) and try again - it continues where it stopped."
                                 % (fspec["name"], getattr(e, "reason", e)))
            emit("STATUS", "Connection lost - retrying (%d of 6)..." % tries)
            time.sleep(min(30, 2 ** tries))
    progress(done_before + have, total)
    return h.hexdigest() == _expected(fspec)


def ensure(cache, name, quiet=False, verify=False):
    """The model's folder, downloading or repairing whatever is missing or damaged first. verify=True (Download /
    Repair in the panel) checks every checksum first instead of trusting sizes and the manifest."""
    spec = catalog()[name]
    d = model_dir(cache, name)
    st = status(cache, name, deep=verify)
    if st["state"] == "ok":
        _drop_legacy(cache, spec)
        return d
    if verify:
        try:
            os.remove(os.path.join(d, MANIFEST))         # no longer vouched for until it checks out again
        except OSError:
            pass
    label = spec.get("label", name)
    with _Lock(os.path.join(cache, "models", name + ".lock")):
        os.makedirs(d, exist_ok=True)
        reused = _migrate(cache, name, spec, d)
        reused |= _reuse_copies(cache, spec, d)
        total = total_size(spec)
        need = 0
        states = dict((f["name"], f["state"]) for f in st["files"])
        for fs in spec["files"]:
            p = os.path.join(d, fs["name"])
            if fs["name"] not in reused and (states.get(fs["name"]) != "ok" or not file_ok(p, fs, False)):
                part = p + ".part"
                need += fs["size"] - (os.path.getsize(part) if os.path.exists(part) else 0)
        try:
            free = shutil.disk_usage(d).free
        except OSError:
            free = None
        if free is not None and free < need + 200 * 1024 * 1024:
            raise ModelError("disk", "Not enough free disk space for the %s: it needs %.1f GB more, the drive has %.1f GB free."
                             % (label, need / 1e9, free / 1e9))
        if need:
            had = any(os.path.exists(os.path.join(d, fs["name"])) or os.path.exists(os.path.join(d, fs["name"]) + ".part")
                      for fs in spec["files"])
            emit("STATUS", ("Downloading the %s again (only what is missing or damaged)..." if had else
                            "Downloading the %s (first time only)...") % label)
        done = 0

        def progress(a, b):
            emit("DOWNLOAD", int(a), int(b))

        for fs in spec["files"]:
            p = os.path.join(d, fs["name"])
            if file_ok(p, fs, False) and file_ok(p, fs, True):
                done += fs["size"]
                if need:
                    progress(done, total)
                continue
            if os.path.exists(p):
                os.remove(p)                               # wrong size or damaged: fetch it again
            part = p + ".part"
            ok = False
            for attempt in range(2):
                try:
                    ok = _fetch(_url(spec, fs), part, fs, progress, done, total)
                except PermissionError as e:
                    raise ModelError("permission", "Windows blocked writing into %s (%s)." % (d, e))
                if ok:
                    break
                os.remove(part)                            # damaged in transit: once more from the start
                emit("STATUS", "%s arrived damaged - downloading it again..." % fs["name"])
            if not ok:
                raise ModelError("corrupt", "%s keeps arriving damaged (checksum mismatch). A proxy or antivirus may be "
                                            "changing downloads; try again on another connection." % fs["name"])
            os.replace(part, p)
            done += fs["size"]
        _write_manifest(d, name, spec)
    _drop_legacy(cache, spec)
    if not quiet:
        emit("STATUS", "%s ready." % label)
    return d


def _write_manifest(d, name, spec):
    with open(os.path.join(d, MANIFEST), "w", encoding="utf-8") as f:
        json.dump({"name": name, "revision": spec.get("revision"), "verified": time.strftime("%Y-%m-%dT%H:%M:%S"),
                   "files": {fs["name"]: fs["size"] for fs in spec["files"]}}, f, indent=1)


# ---------------------------------------------------------------------------------------------- reuse

def _search_dirs(cache, spec):
    """Folders where a copy of a model may already be on this PC: the Hugging Face cache that other tools fill
    (huggingface_hub, demucs-onnx...) and the usual download folders. Copies found there are checked byte by byte
    and copied, never moved: they belong to whoever put them there."""
    dirs = []
    if spec["source"] == "hf":
        key = "models--" + spec["repo"].replace("/", "--")
        hubs = []
        if os.environ.get("HF_HUB_CACHE"):
            hubs.append(os.environ["HF_HUB_CACHE"])
        if os.environ.get("HF_HOME"):
            hubs.append(os.path.join(os.environ["HF_HOME"], "hub"))
        hubs.append(os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub"))
        for h in hubs:
            snap = os.path.join(h, key, "snapshots")
            try:
                revs = sorted(os.listdir(snap))
            except OSError:
                continue
            for rev in revs:
                dirs.append(os.path.join(snap, rev))
    home = os.path.expanduser("~")
    for sub in ("Downloads", os.path.join("Downloads", "CFX Suite"), "Desktop", "Documents",
                os.path.join("Documents", "CFX Suite", "Models"), os.path.join("OneDrive", "Desktop"),
                os.path.join("OneDrive", "Documents"), os.path.join("OneDrive", "Documents", "CFX Suite", "Models")):
        dirs.append(os.path.join(home, sub))
    return dirs


def _find_copies(cache, spec, d):
    """{file name: path} for the model's missing files when a same-named, same-sized copy exists elsewhere on this
    PC (all of them, or None)."""
    found = {}
    for fs in spec["files"]:
        if file_ok(os.path.join(d, fs["name"]), fs, False):
            continue
        for sd in _search_dirs(cache, spec):
            src = os.path.join(sd, fs["name"])
            try:
                if os.path.getsize(src) == fs["size"]:
                    found[fs["name"]] = os.path.realpath(src)
                    break
            except OSError:
                pass
        if fs["name"] not in found:
            return None
    return found or None


def _copy_in(src, dst):
    shutil.copyfile(src, dst + ".part")
    os.replace(dst + ".part", dst)


def _reuse_copies(cache, spec, d):
    """Copies of the model's missing files found elsewhere on this PC are checked (SHA-256) and copied in instead
    of downloading them again. Returns the names of the files reused."""
    reused = set()
    for fs in spec["files"]:
        dst = os.path.join(d, fs["name"])
        if file_ok(dst, fs, False):
            continue
        for sd in _search_dirs(cache, spec):
            src = os.path.join(sd, fs["name"])
            try:
                if os.path.getsize(src) != fs["size"]:
                    continue
            except OSError:
                continue
            emit("STATUS", "Found %s in %s - checking it..." % (fs["name"], sd))
            if not file_ok(src, fs, True):
                continue                                   # same name and size, different file: keep looking
            emit("STATUS", "Reusing the %s already on this PC (verified)..." % fs["name"])
            try:
                _copy_in(src, dst)
                reused.add(fs["name"])
                break
            except OSError:
                pass
    return reused


def adopt(cache, name, src):
    """A model file the user points at (a copy already on this PC): checked against the pinned size and SHA-256,
    then copied into the model's folder. Raises ModelError("mismatch") for any other file."""
    spec = catalog()[name]
    label = spec.get("label", name)
    size = os.path.getsize(src)
    cands = [fs for fs in spec["files"] if fs["size"] == size]
    if not cands:
        raise ModelError("mismatch", "%s is not the %s: it is %.1f MB, the model file is %s." % (
            os.path.basename(src), label, size / 1e6, " / ".join("%.1f MB" % (f["size"] / 1e6) for f in spec["files"])))
    fs = next((f for f in cands if file_ok(src, f, True)), None)
    if fs is None:
        raise ModelError("mismatch", "%s has the right size but not the right contents (a different or damaged "
                                     "copy of the %s). Download the model instead." % (os.path.basename(src), label))
    d = model_dir(cache, name)
    with _Lock(os.path.join(cache, "models", name + ".lock")):
        os.makedirs(d, exist_ok=True)
        dst = os.path.join(d, fs["name"])
        same = False
        try:
            same = os.path.exists(dst) and os.path.samefile(src, dst)
        except OSError:
            same = False
        if not same:
            try:
                free = shutil.disk_usage(d).free
            except OSError:
                free = None
            if free is not None and free < fs["size"] + 50 * 1024 * 1024:
                raise ModelError("disk", "Not enough free disk space to copy the %s (%.0f MB)." % (label, fs["size"] / 1e6))
            emit("STATUS", "Copying the %s..." % label)
            try:
                _copy_in(src, dst)
            except PermissionError as e:
                raise ModelError("permission", "Windows blocked writing into %s (%s)." % (d, e))
        if all(file_ok(os.path.join(d, f["name"]), f, True) for f in spec["files"]):
            _write_manifest(d, name, spec)
    return d


def _migrate(cache, name, spec, d):
    """A model already downloaded by an earlier CFX Suite (Hugging Face cache layout) is moved here when its
    files check out, instead of being downloaded again. Returns the names of the files reused."""
    reused = set()
    if spec["source"] != "hf":
        return reused
    snap = os.path.join(cache, "models--" + spec["repo"].replace("/", "--"), "snapshots")
    if not os.path.isdir(snap):
        return reused
    for rev in os.listdir(snap):
        for fs in spec["files"]:
            dst = os.path.join(d, fs["name"])
            src = os.path.join(snap, rev, fs["name"])
            if os.path.exists(dst) or not os.path.exists(src):
                continue
            src_real = os.path.realpath(src)
            if file_ok(src_real, fs, True):
                emit("STATUS", "Reusing the %s already on this PC..." % fs["name"])
                try:
                    shutil.copyfile(src_real, dst + ".part")
                    os.replace(dst + ".part", dst)
                    reused.add(fs["name"])
                except OSError:
                    pass
    return reused


def _drop_legacy(cache, spec):
    """Once the model checks out in the new layout, the earlier CFX Suite's copy (Hugging Face cache layout,
    a second full copy on Windows without symlinks) is only wasted disk space."""
    if spec["source"] != "hf":
        return
    old = os.path.join(cache, "models--" + spec["repo"].replace("/", "--"))
    if os.path.isdir(old):
        shutil.rmtree(old, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "download", "adopt"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("--cache", default=default_cache())
    ap.add_argument("--deep", action="store_true")
    ap.add_argument("--names")
    ap.add_argument("--file", help="adopt: a copy of the model file already on this PC")
    a = ap.parse_args()
    if a.cmd == "adopt":
        if not a.name or a.name not in catalog() or not a.file:
            emit("ERROR", "adopt needs a model name and --file")
            return 2
        d = adopt(a.cache, a.name, a.file)
        st = status(a.cache, a.name, deep=True)
        if st["state"] != "ok":
            emit("ERROR", "The %s is still not complete (%s)." % (st["label"], st["state"]))
            return 1
        emit("DONE", d)
        return 0
    if a.cmd == "status":
        names = a.names.split(",") if a.names else list(catalog().keys())
        res = []
        for n in names:
            if a.deep:
                emit("STATUS", "Checking %s..." % catalog()[n].get("label", n))
            res.append(status(a.cache, n, a.deep))
        emit("OK", json.dumps(res))
        return 0
    if not a.name or a.name not in catalog():
        emit("ERROR", "Unknown model: %s" % a.name)
        return 2
    d = ensure(a.cache, a.name, verify=True)
    st = status(a.cache, a.name, deep=True)
    if st["state"] != "ok":
        emit("ERROR", "The %s did not verify after downloading (%s). Press Download again." % (st["label"], st["state"]))
        return 1
    emit("DONE", d)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ModelError as exc:
        emit("ERROR", str(exc))
        sys.exit(1)
    except KeyboardInterrupt:
        emit("ERROR", "Cancelled.")
        sys.exit(130)
    except Exception as exc:
        emit("ERROR", (str(exc) or exc.__class__.__name__).replace("\n", " ")[:400])
        sys.exit(1)
