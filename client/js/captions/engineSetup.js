/**
 * CFX Suite - Auto Captions speech-engine installer (ES5; runs in the CEP panel and under plain Node for tests)
 *
 * Auto Captions never uses the customer's own Python (any version, any packages, maybe none at all). The
 * engine is a private, self-contained runtime in %LOCALAPPDATA%\DalaSuite\engine (no admin rights, nothing
 * added to PATH, nothing registered with Windows):
 *   1. the official Python 3.11.9 embeddable package from python.org (11 MB, SHA-256 checked)
 *   2. pip, from its PyPI wheel (SHA-256 checked)
 *   3. faster-whisper and its dependencies from whisper/requirements-engine.txt: every package pinned to
 *      the tested version and SHA-256 hash, prebuilt wheels only (nothing is compiled on the customer's PC)
 *   4. a start-up check of the engine (whisper/dala_transcribe.py --check)
 * Everything is built in engine.part and only renamed to engine once the check passes, so a failed or
 * cancelled install never leaves a half-working engine behind; the next attempt starts clean.
 * All work runs in child processes / async downloads: After Effects and the panel stay responsive.
 *
 *   var setup = CFXEngineSetup.create({ fs, path, os, cp, https, crypto, url }, process.env, extRoot);
 *   setup.status()                                   -> { state: 'ready'|'missing'|'outdated', python, ... }
 *   var job = setup.install({ onProgress(f, label), onLog(line) }, function (err, info) {...});  job.cancel();
 *   setup.installGpu(callbacks, cb)                  -> cuBLAS 12 into %LOCALAPPDATA%\DalaSuite\cuda12
 *   setup.pythonEnv()                                -> environment for running the engine's Python
 * Errors are { code, message, detail }: code = network | disk | permission | corrupt | pip | runtime |
 * cancelled | unsupported.
 */
(function (root) {
    'use strict';

    var ENGINE_VERSION = 1;    // bump whenever requirements-engine.txt changes: older engines are reinstalled
    var PYTHON = {
        version: '3.11.9',
        url: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
        sha256: '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b',
        size: 11249023,
        pth: 'python311._pth'
    };
    var PIP = {
        file: 'pip-26.2.2-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl',
        sha256: 'fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70',
        size: 1819850
    };
    var NEED_FREE_BYTES = 1.5e9;     // engine (~0.6 GB) + download cache + room for the first speech model

    function err(code, message, detail) { return { code: code, message: message, detail: detail ? String(detail) : '' }; }

    function create(N, env, extRoot, overrides) {
        var o = overrides || {};
        var py = o.python || PYTHON, pip = o.pip || PIP;
        var local = env.LOCALAPPDATA;
        if (!local || !N.path.isAbsolute(local)) local = N.path.join(N.os.homedir(), 'AppData', 'Local');
        var P = {
            base: N.path.join(local, 'DalaSuite'),
            engine: N.path.join(local, 'DalaSuite', 'engine'),
            staging: N.path.join(local, 'DalaSuite', 'engine.part'),
            downloads: N.path.join(local, 'DalaSuite', 'downloads'),
            pipCache: N.path.join(local, 'DalaSuite', 'downloads', 'pip-cache'),
            cuda: N.path.join(local, 'DalaSuite', 'cuda12')
        };
        P.python = N.path.join(P.engine, 'python.exe');
        P.marker = N.path.join(P.engine, 'dala-engine.json');
        var whisperDir = N.path.join(extRoot, 'whisper');
        var sysRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';

        // ------------------------------------------------------------ small helpers

        function exists(p) { try { return N.fs.existsSync(p); } catch (e) { return false; } }
        function mkdirs(p) {
            if (exists(p)) return;
            mkdirs(N.path.dirname(p));
            try { N.fs.mkdirSync(p); } catch (e) { if (!exists(p)) throw e; }
        }
        function readJson(p) { try { return JSON.parse(N.fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

        /** The environment the engine's Python runs with: no PYTHONHOME / PYTHONPATH / user site leaking in
         *  from a Python the customer installed, no pip settings that point elsewhere; proxies are kept. */
        function pythonEnv() {
            var e = {}, k;
            for (k in env) {
                if (!env.hasOwnProperty(k)) continue;
                if (/^PYTHON/i.test(k) || /^PIP_/i.test(k) || /^VIRTUAL_ENV$/i.test(k) || /^CONDA_/i.test(k)) continue;
                e[k] = env[k];
            }
            e.PYTHONIOENCODING = 'utf-8';
            e.PYTHONUTF8 = '1';
            e.PYTHONNOUSERSITE = '1';
            e.PYTHONDONTWRITEBYTECODE = '1';
            e.PIP_DISABLE_PIP_VERSION_CHECK = '1';
            e.PIP_NO_INPUT = '1';
            e.PIP_CONFIG_FILE = 'NUL';          // ignore pip.ini files (index / target / user settings)
            e.PIP_CACHE_DIR = P.pipCache;
            e.HF_HUB_DISABLE_TELEMETRY = '1';
            e.HF_HUB_DISABLE_SYMLINKS_WARNING = '1';
            return e;
        }

        /** Deletes a folder tree without blocking the panel (cmd's rmdir runs in its own process). */
        function removeTree(p, cb) {
            if (!exists(p)) { cb(null); return; }
            N.cp.execFile(N.path.join(sysRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'rmdir', '/s', '/q', p], { windowsHide: true }, function () {
                cb(exists(p) ? err('permission', 'Could not delete the old files in ' + p + '. Close any program using them and try again.') : null);
            });
        }

        /** fs.rename with retries: antivirus scanners briefly lock freshly written files on Windows. */
        function renameRetry(a, b, cb, tries) {
            tries = tries || 0;
            N.fs.rename(a, b, function (e) {
                if (!e) { cb(null); return; }
                if (tries < 20 && /EPERM|EBUSY|EACCES/.test(e.code || '')) { setTimeout(function () { renameRetry(a, b, cb, tries + 1); }, 500); return; }
                cb(err('permission', 'Windows would not let CFX Suite finish the install (a file is in use - often an antivirus scan). Try again in a minute.', e.message));
            });
        }

        function classify(e, what) {
            var c = (e && e.code) || '';
            if (/ENOSPC/.test(c)) return err('disk', 'Not enough free disk space for ' + what + '.', e.message);
            if (/EACCES|EPERM/.test(c)) return err('permission', 'Windows blocked writing ' + what + ' to ' + P.base + '.', e.message);
            var detail = String((e && e.message) || '').split(/\r?\n/)[0];
            if (/^HTTP/.test(c)) return err('network', 'The download server refused ' + what + ' (' + detail + '). Try again later.', detail);
            return err('network', 'Could not download ' + what + '. Check the internet connection (and any firewall or proxy) and try again.', detail);
        }

        // ------------------------------------------------------------ download (Node https, then curl.exe)

        function sha256File(file, cb) {
            var h = N.crypto.createHash('sha256'), s = N.fs.createReadStream(file);
            s.on('data', function (d) { h.update(d); });
            s.on('error', function (e) { cb(e); });
            s.on('end', function () { cb(null, h.digest('hex')); });
        }

        function httpsGet(url, dest, onBytes, state, cb, hops) {
            hops = hops || 0;
            var done = false;
            function finish(e) { if (!done) { done = true; state.req = null; cb(e); } }
            var req;
            try {
                // (options object, not https.get(url, options, cb): older After Effects ship Node versions before 10.9)
                var u = N.url.parse(url);
                var opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path, headers: { 'User-Agent': 'DalaSuite-AutoCaptions' } };
                req = N.https.get(opts, function (res) {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) {
                        res.resume();
                        done = true;
                        httpsGet(N.url.resolve(url, res.headers.location), dest, onBytes, state, cb, hops + 1);
                        return;
                    }
                    if (res.statusCode !== 200) { res.resume(); finish({ code: 'HTTP', message: 'HTTP ' + res.statusCode + ' for ' + url }); return; }
                    var total = +res.headers['content-length'] || 0, got = 0;
                    var out = N.fs.createWriteStream(dest);
                    res.on('data', function (d) { got += d.length; if (onBytes) onBytes(got, total); });
                    res.on('error', finish);
                    out.on('error', finish);
                    out.on('finish', function () { out.close(function () { finish(got > 0 ? null : { code: 'EMPTY', message: 'empty download' }); }); });
                    res.pipe(out);
                });
            } catch (e) { finish(e); return; }
            state.req = req;
            req.setTimeout(45000, function () { req.abort(); finish({ code: 'ETIMEDOUT', message: 'the download stalled for 45 s' }); });
            req.on('error', finish);
        }

        /** Windows' own curl.exe (Windows 10 1803+): a second route when Node's request is blocked. */
        function curlGet(url, dest, state, cb) {
            var exe = N.path.join(sysRoot, 'System32', 'curl.exe');
            if (!exists(exe)) { cb({ code: 'NOCURL', message: 'curl.exe not found' }); return; }
            var child = N.cp.execFile(exe, ['-L', '--fail', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '30', '-o', dest, url],
                { windowsHide: true, timeout: 15 * 60000, env: env }, function (e, so, se) {
                    state.child = null;
                    cb(e ? { code: 'ECURL', message: String(se || e.message).trim() } : null);
                });
            state.child = child;
        }

        function download(item, dest, onBytes, state, cb) {
            var attempt = 0;
            function verify(next) {
                sha256File(dest, function (e, hex) {
                    if (e) { next(e); return; }
                    if (hex !== item.sha256) { next({ code: 'HASH', message: 'checksum mismatch (got ' + hex + ')' }); return; }
                    next(null);
                });
            }
            function tryOnce() {
                if (state.cancelled) { cb(err('cancelled', 'Cancelled.')); return; }
                attempt++;
                var useCurl = attempt > 3;
                var get = useCurl ? function (k) { curlGet(item.url, dest, state, k); } : function (k) { httpsGet(item.url, dest, onBytes, state, k); };
                get(function (e) {
                    if (state.cancelled) { cb(err('cancelled', 'Cancelled.')); return; }
                    if (!e) {
                        verify(function (e2) {
                            if (!e2) { cb(null); return; }
                            if (attempt < 4) { tryOnce(); return; }
                            cb(err('corrupt', 'The download of ' + item.url.split('/').pop() + ' was damaged (checksum mismatch). Try again; if it keeps happening, a proxy or antivirus is changing downloads.', e2.message));
                        });
                        return;
                    }
                    if (attempt < 4) { setTimeout(tryOnce, attempt * 1500); return; }
                    cb(classify(e, item.url.split('/').pop()));
                });
            }
            tryOnce();
        }

        // ------------------------------------------------------------ processes

        /** Runs a program, streaming its output lines. cb(code, tailLines) */
        function run(exe, args, state, onLine, cb, opts) {
            var child;
            try {
                child = N.cp.spawn(exe, args, { windowsHide: true, env: (opts && opts.env) || pythonEnv(), cwd: (opts && opts.cwd) || P.base });
            } catch (e) { cb(-1, ['Could not start ' + exe + ': ' + e.message]); return; }
            state.child = child;
            var tail = [], buf = { out: '', err: '' }, finished = false;
            function take(kind, d) {
                buf[kind] += String(d);
                var lines = buf[kind].split(/\r?\n/);
                buf[kind] = lines.pop();
                for (var i = 0; i < lines.length; i++) {
                    var l = lines[i];
                    if (!l.trim()) continue;
                    tail.push(l); if (tail.length > 40) tail.shift();
                    if (onLine) onLine(l);
                }
            }
            child.stdout.on('data', function (d) { take('out', d); });
            child.stderr.on('data', function (d) { take('err', d); });
            child.on('error', function (e) { if (!finished) { finished = true; state.child = null; cb(-1, ['Could not start ' + exe + ': ' + e.message]); } });
            child.on('close', function (code) {
                if (finished) return;
                finished = true;
                state.child = null;
                if (buf.out.trim()) tail.push(buf.out);
                if (buf.err.trim()) tail.push(buf.err);
                cb(code, tail);
            });
        }

        function extract(zip, dir, state, cb) {
            var tar = N.path.join(sysRoot, 'System32', 'tar.exe');
            function viaPowerShell() {
                var q = function (s) { return "'" + String(s).replace(/'/g, "''") + "'"; };
                var ps = N.path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
                run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
                    'Expand-Archive -LiteralPath ' + q(zip) + ' -DestinationPath ' + q(dir) + ' -Force'], state, null, function (code, tail) {
                    cb(code === 0 && exists(N.path.join(dir, 'python.exe')) ? null : err('runtime', 'Could not unpack the Python runtime.', tail.join(' | ')));
                }, { env: env });
            }
            if (!exists(tar)) { viaPowerShell(); return; }
            run(tar, ['-xf', zip, '-C', dir], state, null, function (code) {
                if (code === 0 && exists(N.path.join(dir, 'python.exe'))) cb(null); else viaPowerShell();
            }, { env: env });
        }

        /** Last meaningful pip error line for the message box. */
        function pipError(tail) {
            var i, best = '';
            for (i = tail.length - 1; i >= 0; i--) {
                var l = tail[i].trim();
                if (/^ERROR:|Error|error:/.test(l)) { best = l.replace(/^ERROR:\s*/, ''); break; }
            }
            return best || tail.slice(-3).join(' ');
        }

        function pipFailure(tail, what) {
            var text = tail.join('\n'), detail = pipError(tail);
            if (/No space left|ENOSPC|\[Errno 28\]/i.test(text)) return err('disk', 'Not enough free disk space to install ' + what + '.', detail);
            if (/Permission denied|Access is denied|\[WinError 5\]|\[Errno 13\]/i.test(text)) return err('permission', 'Windows blocked writing ' + what + ' (often an antivirus). Allow CFX Suite / python.exe in ' + P.base + ' and try again.', detail);
            if (/THESE PACKAGES DO NOT MATCH THE HASHES/i.test(text)) return err('corrupt', 'A downloaded package was damaged (hash mismatch). Try again; if it keeps happening, a proxy or antivirus is changing downloads.', detail);
            if (/ConnectionError|Max retries exceeded|NewConnectionError|getaddrinfo|ProxyError|SSLError|ReadTimeout|timed out|Could not fetch|No matching distribution/i.test(text)) {
                return err('network', 'Could not download ' + what + ' from PyPI (pypi.org / files.pythonhosted.org). Check the internet connection (and any firewall or proxy) and try again.', detail);
            }
            return err('pip', 'Installing ' + what + ' failed.', detail);
        }

        /** Engine start-up check: dala_transcribe.py --check. cb(null, info) or cb(error) */
        function checkPython(python, state, cb) {
            run(python, [N.path.join(whisperDir, 'dala_transcribe.py'), '--check'], state, null, function (code, tail) {
                var m = null, i;
                for (i = 0; i < tail.length; i++) { var mm = tail[i].match(/^OK (.*)$/); if (mm) m = mm; }
                if (code === 0 && m) { try { cb(null, JSON.parse(m[1])); return; } catch (e) {} }
                var text = tail.join(' | ');
                // a DLL that cannot load because its full path passes Windows' 260-character limit is not a missing
                // runtime (seen with a very long profile / AppData path)
                if (/filename or extension is too long|path too long|WinError 206/i.test(text)) {
                    cb(err('runtime', 'The engine folder path is too long for Windows (' + P.base + '). Move your AppData folder to a shorter path, or turn on Windows long paths, then press Repair.', text));
                    return;
                }
                if (/DLL load failed|vcruntime|msvcp|VCRUNTIME|api-ms-win/i.test(text)) {
                    cb(err('runtime', 'Windows is missing the Microsoft Visual C++ Runtime the speech engine needs. Install "vc_redist.x64.exe" from https://aka.ms/vs/17/release/vc_redist.x64.exe, then press Repair.', text));
                    return;
                }
                cb(err('runtime', 'The speech engine was installed but does not start.', text));
            });
        }

        function freeSpace(dir, cb) {
            if (N.fs.statfs) {
                N.fs.statfs(dir, function (e, s) { cb(e ? -1 : s.bavail * s.bsize); });
                return;
            }
            var ps = N.path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            var lit = "'" + String(dir).replace(/'/g, "''") + "'";
            N.cp.execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', '(New-Object System.IO.DriveInfo((Resolve-Path -LiteralPath ' + lit + ').Drive.Root)).AvailableFreeSpace'],
                { windowsHide: true, timeout: 20000, env: env }, function (e, so) { cb(e ? -1 : (+String(so).trim() || -1)); });
        }

        // ------------------------------------------------------------ public

        function status() {
            if (!exists(P.python)) return { state: 'missing', paths: P };
            var mk = readJson(P.marker);
            if (!mk) return { state: 'missing', paths: P };
            if ((mk.engineVersion || 0) < ENGINE_VERSION) return { state: 'outdated', python: P.python, marker: mk, paths: P };
            return { state: 'ready', python: P.python, marker: mk, paths: P };
        }

        function install(cbs, cb) {
            cbs = cbs || {};
            var state = { cancelled: false, child: null, req: null };
            var progress = cbs.onProgress || function () {}, log = cbs.onLog || function () {};
            var finished = false;
            function done(e, info) {
                if (finished) return;
                finished = true;
                if (e) {
                    log('ERROR ' + e.code + ': ' + e.message + (e.detail ? ' [' + e.detail + ']' : ''));
                    // leave nothing half-built behind (the pip download cache is kept so a retry is quicker)
                    removeTree(P.staging, function () { cb(e); });
                    return;
                }
                cb(null, info);
            }
            function step(fn) { return function () { if (state.cancelled) { done(err('cancelled', 'Cancelled.')); return; } fn.apply(null, arguments); }; }

            if (process_platform(N) !== 'win32') { done(err('unsupported', 'Auto Captions\' speech engine installs on Windows only.')); return mkJob(state); }

            var zip = N.path.join(P.downloads, 'python-' + py.version + '-embed-amd64.zip');
            var pipWhl = N.path.join(P.downloads, pip.file);
            var reqFile = N.path.join(whisperDir, 'requirements-engine.txt');
            var total = 0, seen = 0;
            try {
                N.fs.readFileSync(reqFile, 'utf8').split(/\r?\n/).forEach(function (l) { if (/^[A-Za-z0-9]/.test(l)) total++; });
            } catch (eR) { done(err('runtime', 'The extension is incomplete: ' + reqFile + ' is missing. Reinstall CFX Suite.')); return mkJob(state); }

            progress(0.01, 'Preparing the speech engine install…');
            try { mkdirs(P.downloads); N.fs.writeFileSync(N.path.join(P.base, '.write-test'), 'ok'); N.fs.unlinkSync(N.path.join(P.base, '.write-test')); }
            catch (eW) { done(classify(eW, 'the speech engine')); return mkJob(state); }

            freeSpace(P.base, step(function (free) {
                if (free >= 0 && free < NEED_FREE_BYTES) {
                    done(err('disk', 'Not enough free disk space: the speech engine needs about 1.5 GB on the drive of ' + P.base + ' (' + (free / 1e9).toFixed(1) + ' GB free).'));
                    return;
                }
                removeTree(P.staging, step(function (eRm) {
                    if (eRm) { done(eRm); return; }
                    try { mkdirs(P.staging); } catch (eM) { done(classify(eM, 'the speech engine')); return; }
                    getPython();
                }));
            }));

            function cached(item, file, next) {
                if (!exists(file)) { next(false); return; }
                sha256File(file, function (e, hex) { next(!e && hex === item.sha256); });
            }

            function getPython() {
                cached(py, zip, step(function (ok) {
                    if (ok) { unpack(); return; }
                    progress(0.03, 'Downloading Python ' + py.version + ' (private copy for CFX Suite, 11 MB)…');
                    download(py, zip, function (a, b) { progress(0.03 + 0.07 * (b ? a / b : 0), 'Downloading Python ' + py.version + '… ' + Math.round(a / 1e6) + ' of ' + Math.round((b || py.size) / 1e6) + ' MB'); }, state, step(function (e) {
                        if (e) { done(e); return; }
                        unpack();
                    }));
                }));
            }

            function unpack() {
                progress(0.11, 'Unpacking Python…');
                extract(zip, P.staging, state, step(function (e) {
                    if (e) { done(e); return; }
                    try {
                        // the embeddable package ignores site-packages until its ._pth file allows it
                        N.fs.writeFileSync(N.path.join(P.staging, py.pth), 'python311.zip\r\n.\r\nLib\\site-packages\r\nimport site\r\n');
                        mkdirs(N.path.join(P.staging, 'Lib', 'site-packages'));
                    } catch (eP) { done(classify(eP, 'the Python runtime')); return; }
                    getPip();
                }));
            }

            function getPip() {
                cached(pip, pipWhl, step(function (ok) {
                    if (ok) { installPip(); return; }
                    progress(0.13, 'Downloading pip…');
                    download(pip, pipWhl, null, state, step(function (e) { if (e) { done(e); return; } installPip(); }));
                }));
            }

            function installPip() {
                progress(0.15, 'Installing pip…');
                var python = N.path.join(P.staging, 'python.exe');
                // pip runs straight from its checked wheel to install itself (no get-pip.py script from the internet),
                // started like "python -m pip" (pip refuses to replace itself when started as "pip" on Windows)
                var boot = 'import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module("pip", run_name="__main__", alter_sys=True)';
                run(python, ['-c', boot, pipWhl, 'install', '--no-index', '--no-warn-script-location', pipWhl], state, log, step(function (code, tail) {
                    if (code !== 0) { done(code === -1 ? err('runtime', 'The Python runtime does not start on this PC.', tail.join(' | ')) : pipFailure(tail, 'pip')); return; }
                    installPackages(python);
                }));
            }

            function installPackages(python) {
                progress(0.18, 'Downloading the speech engine (about 150 MB)…');
                var args = ['-m', 'pip', 'install', '--require-hashes', '--only-binary=:all:', '--no-warn-script-location',
                    '--progress-bar', 'off', '--prefer-binary', '-r', reqFile];
                run(python, args, state, function (line) {
                    log(line);
                    var m;
                    if ((m = line.match(/^\s*Collecting (\S+)/))) {
                        seen++;
                        progress(0.18 + 0.6 * Math.min(1, seen / Math.max(1, total)), 'Downloading the speech engine… ' + m[1].replace(/==.*/, '') + ' (' + seen + ' of ' + total + ')');
                    } else if ((m = line.match(/^\s*Downloading \S+ \(([\d.]+ [kMG]B)\)/))) {
                        progress(null, 'Downloading the speech engine… ' + (line.match(/Downloading (\S+?)-\d/) || [0, ''])[1] + ' ' + m[1] + ' (' + seen + ' of ' + total + ')');
                    } else if (/^Installing collected packages/.test(line)) {
                        progress(0.8, 'Installing the speech engine (this step can take a minute)…');
                    }
                }, step(function (code, tail) {
                    if (code !== 0) { done(pipFailure(tail, 'the speech engine')); return; }
                    verify(python);
                }));
            }

            function verify(python) {
                progress(0.9, 'Checking the speech engine…');
                checkPython(python, state, step(function (e, info) {
                    if (e) { done(e); return; }
                    try {
                        N.fs.writeFileSync(N.path.join(P.staging, 'dala-engine.json'), JSON.stringify({
                            engineVersion: ENGINE_VERSION, python: py.version, fasterWhisper: info.faster_whisper,
                            installed: new Date().toISOString()
                        }, null, 2));
                    } catch (eMk) { done(classify(eMk, 'the speech engine')); return; }
                    swapIn(info);
                }));
            }

            function swapIn(info) {
                progress(0.96, 'Finishing…');
                var old = P.engine + '.old';
                removeTree(old, step(function () {
                    var move = exists(P.engine) ? function (k) { renameRetry(P.engine, old, k); } : function (k) { k(null); };
                    move(step(function (e) {
                        if (e) { done(e); return; }
                        renameRetry(P.staging, P.engine, function (e2) {
                            if (e2) { done(e2); return; }
                            progress(1, 'Speech engine ready.');
                            removeTree(old, function () {
                                removeTree(P.pipCache, function () { done(null, { python: P.python, check: info }); });
                            });
                        });
                    }));
                }));
            }
            return mkJob(state);
        }

        /** cuBLAS 12 for GPU recognition, pinned and hash-checked, into %LOCALAPPDATA%\DalaSuite\cuda12. */
        function installGpu(cbs, cb) {
            cbs = cbs || {};
            var state = { cancelled: false, child: null, req: null };
            var progress = cbs.onProgress || function () {}, log = cbs.onLog || function () {};
            var st = status();
            if (st.state !== 'ready') { cb(err('runtime', 'Install the speech engine first.')); return mkJob(state); }
            var part = P.cuda + '.part', reqFile = N.path.join(whisperDir, 'requirements-gpu.txt');
            progress(0.02, 'Downloading the GPU library (one time, about 550 MB)…');
            removeTree(part, function () {
                if (state.cancelled) { cb(err('cancelled', 'Cancelled.')); return; }
                run(st.python, ['-m', 'pip', 'install', '--require-hashes', '--only-binary=:all:', '--no-deps', '--no-warn-script-location',
                    '--progress-bar', 'off', '--target', part, '-r', reqFile], state, function (line) {
                    log(line);
                    if (/^\s*Downloading/.test(line)) progress(0.1, 'Downloading the GPU library (about 550 MB)…');
                    else if (/^Installing collected/.test(line)) progress(0.8, 'Installing the GPU library…');
                }, function (code, tail) {
                    if (state.cancelled) { removeTree(part, function () { cb(err('cancelled', 'Cancelled.')); }); return; }
                    if (code !== 0) { var e = pipFailure(tail, 'the GPU library'); removeTree(part, function () { cb(e); }); return; }
                    removeTree(P.cuda, function () {
                        renameRetry(part, P.cuda, function (e2) {
                            removeTree(P.pipCache, function () { if (e2) cb(e2); else { progress(1, 'GPU library ready.'); cb(null); } });
                        });
                    });
                });
            });
            return mkJob(state);
        }

        /** Audio > Vocal Remover add-on (Demucs v4 + PyTorch CPU) into %LOCALAPPDATA%\DalaSuite\audio: pinned and
         *  hash-checked like the engine, built in audio.part and only swapped in once Demucs imports. */
        function installAudio(cbs, cb) {
            cbs = cbs || {};
            var state = { cancelled: false, child: null, req: null };
            var progress = cbs.onProgress || function () {}, log = cbs.onLog || function () {};
            var st = status();
            if (st.state !== 'ready') { cb(err('runtime', 'Install the speech engine first (it also runs the audio tools).')); return mkJob(state); }
            var dir = N.path.join(P.base, 'audio'), part = dir + '.part', reqFile = N.path.join(whisperDir, 'requirements-audio.txt');
            var total = 0, seen = 0;
            try { N.fs.readFileSync(reqFile, 'utf8').split(/\r?\n/).forEach(function (l) { if (/^[A-Za-z0-9]/.test(l)) total++; }); } catch (eR) {}
            progress(0.02, 'Preparing the vocal remover install…');
            freeSpace(P.base, function (free) {
                if (free >= 0 && free < 2.2e9) { cb(err('disk', 'Not enough free disk space: the vocal remover needs about 2 GB (' + (free / 1e9).toFixed(1) + ' GB free).')); return; }
                removeTree(part, function () {
                    if (state.cancelled) { cb(err('cancelled', 'Cancelled.')); return; }
                    run(st.python, ['-m', 'pip', 'install', '--require-hashes', '--only-binary=:all:', '--no-warn-script-location',
                        '--progress-bar', 'off', '--target', part, '-r', reqFile], state, function (line) {
                        log(line);
                        var m;
                        if ((m = line.match(/^\s*Collecting (\S+)/))) { seen++; progress(0.05 + 0.6 * Math.min(1, seen / Math.max(1, total)), 'Downloading the vocal remover… ' + m[1].replace(/==.*/, '') + ' (' + seen + ' of ' + total + ')'); }
                        else if ((m = line.match(/^\s*Downloading \S+ \(([\d.]+ [kMG]B)\)/))) progress(null, 'Downloading the vocal remover… ' + (line.match(/Downloading (\S+?)-\d/) || [0, ''])[1] + ' ' + m[1]);
                        else if (/^Installing collected/.test(line)) progress(0.7, 'Installing the vocal remover (this step can take a few minutes)…');
                    }, function (code, tail) {
                        if (state.cancelled) { removeTree(part, function () { cb(err('cancelled', 'Cancelled.')); }); return; }
                        if (code !== 0) { var e = pipFailure(tail, 'the vocal remover'); removeTree(part, function () { cb(e); }); return; }
                        try { N.fs.writeFileSync(N.path.join(part, '.dala-ok'), 'ok'); } catch (eW) {}
                        progress(0.9, 'Checking the vocal remover…');
                        removeTree(dir, function () {
                            renameRetry(part, dir, function (e2) {
                                if (e2) { cb(e2); return; }
                                run(st.python, [N.path.join(whisperDir, 'dala_audio.py'), 'check', '--imports'], state, null, function (c2, t2) {
                                    var ok = false, info = null, i;
                                    for (i = 0; i < t2.length; i++) { var mm = t2[i].match(/^OK (.*)$/); if (mm) { try { info = JSON.parse(mm[1]); } catch (eJ) {} } }
                                    ok = info && info.addon && info.imports;
                                    if (!ok) { removeTree(dir, function () { cb(err('runtime', 'The vocal remover was installed but does not start.', (info && info.importError) || t2.join(' | '))); }); return; }
                                    removeTree(P.pipCache, function () { progress(1, 'Vocal remover ready.'); cb(null, info); });
                                });
                            });
                        });
                    });
                });
            });
            return mkJob(state);
        }

        function mkJob(state) {
            return {
                cancel: function () {
                    state.cancelled = true;
                    try { if (state.req) state.req.abort(); } catch (e1) {}
                    try { if (state.child) state.child.kill(); } catch (e2) {}
                }
            };
        }

        return {
            paths: P, status: status, install: install, installGpu: installGpu, installAudio: installAudio, pythonEnv: pythonEnv,
            audioInstalled: function () { return exists(N.path.join(P.base, 'audio', '.dala-ok')) && exists(N.path.join(P.base, 'audio', 'demucs')); },
            /** Deletes the one-time translation converter once the translator is set up (async). */
            supported: process_platform(N) === 'win32',
            removeConverter: function (cb) { removeTree(N.path.join(P.base, 'mtconvert'), function () { if (cb) cb(); }); },
            check: function (cb) {
                var st = status();
                if (st.state === 'missing') { cb(err('runtime', 'The speech engine is not installed.')); return; }
                checkPython(st.python, { cancelled: false }, cb);
            },
            ENGINE_VERSION: ENGINE_VERSION, PYTHON: py
        };
    }

    function process_platform(N) {
        try { return N.os.platform(); } catch (e) { return 'win32'; }
    }

    var api = { create: create, ENGINE_VERSION: ENGINE_VERSION, PYTHON: PYTHON, PIP: PIP };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.CFXEngineSetup = root.DalaEngineSetup = api;
})(typeof window !== 'undefined' ? window : this);
