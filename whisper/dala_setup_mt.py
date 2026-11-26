"""Dala Suite - one-time download of the offline translator used by Auto Captions.

The translator is Google's MADLAD-400 3B MT (Apache 2.0) as a CTranslate2 int8 model, converted by Nextcloud
(Nextcloud-AI/madlad400-3b-mt-ct2-int8 on Hugging Face, about 3 GB). It runs on the speech engine's own
ctranslate2 + tokenizers, so nothing is installed or converted here: the files pinned in models.json
("madlad-3b") are downloaded with resume and checked file by file by dala_models.py into
~/.cache/dala_whisper/models/madlad-3b. Earlier versions' NLLB-200 translator and its one-time converter
(PyTorch) are deleted once this one is in place.

Status lines on stdout, like dala_transcribe.py:  STATUS <text> | DOWNLOAD <done> <total> | DONE <dir> | ERROR <msg>

    python dala_setup_mt.py [--cache DIR]
"""
import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dala_models  # noqa: E402

NAME = "madlad-3b"


def emit(kind, *parts):
    sys.stdout.write(kind + (" " + " ".join(str(p) for p in parts) if parts else "") + "\n")
    sys.stdout.flush()


def local_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(base, "DalaSuite")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=dala_models.default_cache())
    args = ap.parse_args()
    d = dala_models.ensure(args.cache, NAME)
    st = dala_models.status(args.cache, NAME)
    if st["state"] != "ok":
        emit("ERROR", "The translation model did not verify after downloading (%s). Try again." % st["state"])
        return 1
    # no longer used: the NLLB-200 translator of 2.0.2 - 2.0.3, its 2.5 GB download and its converter
    for old in (os.path.join(args.cache, "dala-nllb-600m-int8"), os.path.join(args.cache, "models", "nllb-src"),
                os.path.join(local_dir(), "mtconvert"), os.path.join(local_dir(), "mt-download")):
        if os.path.isdir(old):
            shutil.rmtree(old, ignore_errors=True)
    emit("DONE", d)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except dala_models.ModelError as exc:
        emit("ERROR", str(exc))
        sys.exit(1)
    except KeyboardInterrupt:
        emit("ERROR", "Cancelled.")
        sys.exit(130)
    except Exception as exc:
        emit("ERROR", (str(exc) or exc.__class__.__name__).replace("\n", " ")[:400])
        sys.exit(1)
