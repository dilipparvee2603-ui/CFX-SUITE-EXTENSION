/**
 * Dala Suite - MUSIC STEMS panel (ES5): splits the selected song into Drums, Bass, Guitar, Piano and Other and adds
 * the five stems to the comp as audio layers lined up with the song (vocals are never extracted).
 * The split runs on the speech engine's private Python (engineSetup.js; onnxruntime + PyAV, nothing else to
 * install) with the HT-Demucs 6-stem ONNX model (whisper/dala_stems.py). The model is pinned in models.json and
 * comes from, in order: the copy already installed (re-verified every run), a copy found elsewhere on this PC
 * (Hugging Face cache, Downloads...; checked by SHA-256), a file the user points at (USE FILE), or a download
 * (resumed, verified). The audio is the selected layer's own file when it plays one file straight (only the part
 * that is used), otherwise that layer rendered alone (host captions.renderAudio).
 */
(function (root) {
    'use strict';
    var cs = null, N = null, setupApi = null, dom = {};
    var MODEL = 'htdemucs_6s', SIZE = '136 MB';
    var STEMS = [{ key: 'drums', title: 'Drums' }, { key: 'bass', title: 'Bass' }, { key: 'guitar', title: 'Guitar' },
        { key: 'piano', title: 'Piano' }, { key: 'other', title: 'Other' }];
    var S = { busy: false, job: null, engine: 'unknown', model: null, libs: null, range: 'layer', action: null };

    function $(id) { return document.getElementById(id); }
    function req(m) {
        try {
            if (typeof root.require === 'function') return root.require(m);
            if (root.cep_node && typeof root.cep_node.require === 'function') return root.cep_node.require(m);
        } catch (e) {}
        return null;
    }
    function nodeOk() {
        if (N) return true;
        var o = { fs: req('fs'), path: req('path'), os: req('os'), cp: req('child_process'), https: req('https'), crypto: req('crypto'), url: req('url') };
        for (var k in o) if (!o[k]) return false;
        N = o;
        return true;
    }
    function extRoot() {
        var p = '';
        try { p = cs.getSystemPath('extension'); } catch (e) { p = ''; }
        if (!p) p = decodeURIComponent(root.location.pathname).replace(/\/client\/[^\/]*$/, '');
        p = String(p).replace(/^file:\/+/i, '');
        if (/^\/[A-Za-z]:/.test(p)) p = p.substring(1);
        return p.replace(/\\/g, '/').replace(/\/+$/, '');
    }
    function setup() {
        if (setupApi) return setupApi;
        if (!nodeOk() || !root.DalaEngineSetup) return null;
        var proc = root.process || req('process');
        setupApi = root.DalaEngineSetup.create(N, (proc && proc.env) || {}, extRoot());
        return setupApi;
    }
    function script(name) { return extRoot() + '/whisper/' + name; }
    function toast(message, type) { if (window.DalaToast) window.DalaToast(message, type); }
    function host(call, cb) {
        if (!cs) { cb({ success: false, message: 'After Effects is not connected.' }); return; }
        cs.evalScript(call, function (raw) {
            var res;
            try { res = JSON.parse(raw); } catch (e) { res = { success: false, message: (raw && raw !== 'undefined') ? String(raw) : 'After Effects did not answer.' }; }
            cb(res);
        });
    }
    function q(obj) { return JSON.stringify(JSON.stringify(obj)); }
    function fmtBytes(b) { return b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB'; }
    function fmtTime(s) { s = Math.round(s); return s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor(s / 60 % 60) + ' min' : (s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s'); }

    // ------------------------------------------------------------------ progress / state

    function showProgress(f, label) {
        dom.progress.style.display = 'flex';
        if (f !== null && f !== undefined) dom.fill.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
        if (label) dom.label.textContent = label;
    }
    function hideProgress() { dom.progress.style.display = 'none'; }
    function setBusy(b) {
        S.busy = b;
        var btns = document.querySelectorAll('#st-card .btn, #st-card .subtab-btn');
        for (var i = 0; i < btns.length; i++) btns[i].disabled = b;
    }
    function note(t) { dom.note.textContent = t || ''; }
    function finish(msg, type) {
        S.job = null;
        setBusy(false);
        hideProgress();
        if (msg) { note(msg); toast(msg, type || 'info'); }
    }
    function badge(text, kind, title) {
        dom.engine.textContent = text;
        dom.engine.className = 'at-engine cap-engine' + (kind ? ' ' + kind : '');
        dom.engine.title = title || '';
    }
    function showSetup(text, button, action) {
        dom.setup.style.display = text ? 'flex' : 'none';
        dom.setupText.textContent = text || '';
        dom.install.textContent = button || '';
        dom.install.style.display = button ? '' : 'none';
        S.action = action || null;
    }

    /** Runs an engine script; streams STATUS / DOWNLOAD / PROGRESS / PARTS lines. done(code, lastError, doneLine) */
    function runPython(args, p0, p1, done, dlShare) {
        var share = dlShare || 0, downloaded = false;
        var st = setup().status(), child;
        try { child = N.cp.spawn(st.python, args, { windowsHide: true, env: setup().pythonEnv() }); }
        catch (e) { done(-1, 'Could not start the audio engine: ' + e.message); return; }
        if (S.job) S.job.child = child;
        var buf = '', errTail = '', lastError = '', doneLine = '', okLine = '', finished = false;
        function handle(line) {
            var m;
            if ((m = line.match(/^STATUS (.*)$/))) showProgress(null, m[1]);
            else if ((m = line.match(/^DOWNLOAD (\d+) (\d+)$/))) {
                var a = +m[1], b = +m[2];
                downloaded = true;
                showProgress(p0 + (p1 - p0) * (share || 1) * Math.min(1, a / b), 'Downloading the 6-stem model: ' + fmtBytes(a) + ' of ' + fmtBytes(b) + ' (' + Math.floor(Math.min(1, a / b) * 100) + '%)');
            }
            else if ((m = line.match(/^PROGRESS ([\d.]+)$/))) { var f = +m[1], base = (downloaded && share) ? share : 0; showProgress(p0 + (p1 - p0) * (base + (1 - base) * f), null); }
            else if ((m = line.match(/^PARTS (.*)$/))) { try { if (S.job) S.job.parts = JSON.parse(m[1]); } catch (eP) {} }
            else if ((m = line.match(/^ERROR (.*)$/))) lastError = m[1];
            else if ((m = line.match(/^DONE (.*)$/))) doneLine = m[1];
            else if ((m = line.match(/^OK (.*)$/))) okLine = m[1];
        }
        child.stdout.on('data', function (d) { buf += String(d); var ls = buf.split(/\r?\n/); buf = ls.pop(); for (var i = 0; i < ls.length; i++) handle(ls[i]); });
        child.stderr.on('data', function (d) { errTail = (errTail + String(d)).slice(-600); });
        child.on('error', function (e) { if (!finished) { finished = true; done(-1, 'Could not start the audio engine: ' + e.message); } });
        child.on('close', function (code) {
            if (finished) return;
            finished = true;
            if (buf) handle(buf);
            done(code, lastError || errTail.split(/\r?\n/).filter(Boolean).pop() || ('exit code ' + code), doneLine || okLine);
        });
    }

    // ------------------------------------------------------------------ engine + model state

    function refresh() {
        var su = setup();
        if (!su) { badge('UNAVAILABLE', 'bad'); showSetup('This panel cannot run its audio engine (Node.js is off). Restart After Effects.'); return; }
        if (!su.supported) { badge('WINDOWS ONLY', 'bad'); showSetup('Music Stems runs on Windows for now.'); return; }
        var st = su.status();
        if (st.state !== 'ready') {
            S.engine = st.state;
            badge('SETUP NEEDED', 'warn');
            showSetup(st.state === 'outdated' ? 'This version of Dala Suite needs a newer audio engine (one-time download, about 200 MB).'
                : 'Music Stems runs on Dala Suite\'s own engine (Python included, nothing else to install). Install it once: about 200 MB.',
                st.state === 'outdated' ? 'UPDATE ENGINE' : 'INSTALL ENGINE', 'engine');
            S.model = null;
            showModel();
            return;
        }
        S.engine = 'ready';
        badge('CHECKING…', '');
        check(false);
    }

    /** engine libraries + model state (dala_stems.py check). deep: also checksums and a test load */
    function check(deep, after) {
        var args = [script('dala_stems.py'), 'check'];
        if (deep) { args.push('--load'); setBusy(true); S.job = { child: null }; showProgress(0.1, 'Checking the 6-stem model (size, checksum, test load)…'); }
        runPython(args, 0.1, 0.9, function (code, msg, ok) {
            var r = null;
            try { r = JSON.parse(ok); } catch (e) { r = null; }
            if (!r) {
                badge('ENGINE ERROR', 'bad');
                showSetup('The audio engine did not start (' + msg + '). Repair it: it is downloaded again (about 200 MB).', 'REPAIR ENGINE', 'engine');
                if (deep) finish('The audio engine did not start: ' + msg, 'error');
                if (after) after(false);
                return;
            }
            S.libs = r.engine;
            S.model = r.model;
            if (!r.engine) {
                badge('ENGINE ERROR', 'bad');
                showSetup('A part of the audio engine is missing or damaged (' + (r.engineError || 'import failed') + '). Repair it: it is downloaded again (about 200 MB).', 'REPAIR ENGINE', 'engine');
            } else {
                badge('READY', '', 'ONNX Runtime ' + r.engine.onnxruntime + ' · PyAV ' + r.engine.av + ' · NumPy ' + r.engine.numpy + ' (CPU)');
                showSetup('');
            }
            showModel();
            if (deep) {
                var good = r.model.state === 'ok' && r.loads !== false;
                if (r.loads === false) showSetup('The model file checks out but did not load (' + (r.loadError || '') + '). Repair the engine.', 'REPAIR ENGINE', 'engine');
                finish(r.model.state === 'ok' ? (r.loads === false ? 'The 6-stem model did not load: ' + r.loadError : 'The 6-stem model is complete, verified (SHA-256) and loads.')
                    : modelText(), good ? 'success' : 'info');
            }
            if (after) after(true);
        });
    }

    function modelText() {
        var m = S.model;
        if (S.engine !== 'ready') return '6-stem model (' + SIZE + '): downloads on the first run, after the engine is installed.';
        if (!m) return '6-stem model: checking…';
        if (m.state === 'ok') return '6-stem model ready (' + SIZE + ', verified).';
        if (m.found) return 'A copy of the 6-stem model was found on this PC: it is checked and reused on the first run (no download).';
        if (m.state === 'missing') return '6-stem model not downloaded yet (' + SIZE + '): it downloads on the first run, or now. Already have htdemucs_6s_fp16weights.onnx? Press USE FILE.';
        if (m.state === 'incomplete') return '6-stem model download incomplete (' + fmtBytes(m.bytes) + ' of ' + fmtBytes(m.total) + '): it resumes where it stopped.';
        return 'The 6-stem model is damaged: it is downloaded again (only that file).';
    }
    function showModel() {
        var m = S.model;
        dom.modelNote.textContent = modelText();
        dom.modelNote.className = 'cap-model-state' + (m && m.state === 'ok' ? ' ok' : (m && m.state === 'corrupt' ? ' bad' : (m && m.state !== 'ok' ? ' warn' : '')));
        var need = S.engine === 'ready' && m && m.state !== 'ok';
        dom.modelGet.style.display = need ? '' : 'none';
        dom.modelGet.textContent = m && m.found ? 'REUSE' : (m && m.state === 'incomplete' ? 'RESUME' : (m && m.state === 'corrupt' ? 'REPAIR' : 'DOWNLOAD'));
        dom.modelFile.style.display = need && !m.found ? '' : 'none';
    }

    function needEngine() {
        if (S.engine === 'ready' && S.libs) return true;
        toast(S.engine === 'ready' ? 'Repair the audio engine first (button at the top).' : 'Install the audio engine first (button at the top).', 'error');
        return false;
    }

    /** downloads, resumes, repairs or reuses the model on its own */
    function getModel() {
        if (S.busy || !nodeOk() || !needEngine()) return;
        setBusy(true);
        S.job = { cancelled: false };
        var job = S.job;
        showProgress(0.02, 'Checking the 6-stem model…');
        runPython([script('dala_models.py'), 'download', MODEL], 0.02, 0.98, function (code, msg) {
            if (job.cancelled) { check(false); return; }
            if (code !== 0) { finish('The 6-stem model could not be downloaded: ' + msg + ' Press DOWNLOAD to try again (it resumes).', 'error'); check(false); return; }
            finish('6-stem model ready and verified.', 'success');
            check(false);
        }, 1);
    }

    /** a copy of the model the user already has (checked against the pinned size and SHA-256, then copied in) */
    function useFile() {
        if (S.busy || !nodeOk() || !needEngine()) return;
        host('$._dalaSuite.stems.pickModel()', function (res) {
            if (!res.success) { if (res.message !== 'cancelled') toast(res.message, 'error'); return; }
            setBusy(true);
            S.job = { cancelled: false };
            var job = S.job;
            showProgress(0.1, 'Checking ' + res.data.path.split(/[\\\/]/).pop() + '…');
            runPython([script('dala_stems.py'), 'adopt', '--model-file', res.data.path], 0.1, 0.95, function (code, msg) {
                if (job.cancelled) { check(false); return; }
                finish(code === 0 ? 'That file is the 6-stem model (verified): it is used from now on, nothing was downloaded.' : msg, code === 0 ? 'success' : 'error');
                check(false);
            });
        });
    }

    function onInstall() {
        if (S.busy) return;
        var su = setup();
        if (!su || S.action !== 'engine') return;
        setBusy(true);
        var log = [];
        showProgress(0.01, 'Preparing the engine install…');
        var handle = su.install({
            onProgress: function (f, l) { showProgress(f, l); },
            onLog: function (l) { log.push(l); if (log.length > 300) log.shift(); }
        }, function (e) {
            try { N.fs.writeFileSync(N.path.join(su.paths.base, 'install-log.txt'), new Date().toISOString() + '\r\n' + (e ? 'FAILED ' + e.code + ': ' + e.message + '\r\n' + (e.detail || '') + '\r\n\r\n' : '') + log.join('\r\n')); } catch (eW) {}
            if (e && e.code === 'cancelled') { finish('Install cancelled; nothing was changed.', 'info'); refresh(); return; }
            if (e) { finish(e.message, 'error'); dom.setupText.textContent = e.message; dom.install.textContent = 'TRY AGAIN'; return; }
            finish('Audio engine installed.', 'success');
            refresh();
        });
        S.job = { setup: handle };
    }

    function cleanParts(parts) {
        for (var i = 0; parts && i < parts.length; i++) { try { N.fs.unlinkSync(parts[i]); } catch (e) {} }
    }
    function cancel() {
        var j = S.job;
        if (!j) return;
        if (j.setup) { j.setup.cancel(); return; }
        j.cancelled = true;
        try { if (j.child) j.child.kill(); } catch (e) {}
        var parts = j.parts;
        setTimeout(function () { cleanParts(parts); }, 1500);       // after the engine has let go of them
        finish('Cancelled. Nothing was added to the comp.', 'info');
        check(false);                                               // a stopped download shows as "incomplete: resume"
    }

    // ------------------------------------------------------------------ split

    function mkdirs(p) {
        if (N.fs.existsSync(p)) return;
        mkdirs(N.path.dirname(p));
        try { N.fs.mkdirSync(p); } catch (e) { if (!N.fs.existsSync(p)) throw e; }
    }
    /** next to the song when that folder is writable, else Documents\Dala Suite\Stems, else Temp */
    function outDir(file) {
        var cands = [];
        if (file) cands.push(N.path.join(N.path.dirname(file), 'Dala Stems'));
        cands.push(N.path.join(N.os.homedir(), 'Documents', 'Dala Suite', 'Stems'));
        cands.push(N.path.join(N.os.tmpdir(), 'Dala Stems'));
        for (var i = 0; i < cands.length; i++) {
            try {
                mkdirs(cands[i]);
                var probe = N.path.join(cands[i], '.write-test');
                N.fs.writeFileSync(probe, 'ok');
                N.fs.unlinkSync(probe);
                return cands[i];
            } catch (e) {}
        }
        return null;
    }
    function tempDir() {
        var base = N.path.join(N.os.tmpdir(), 'DalaAudio');
        try { if (!N.fs.existsSync(base)) N.fs.mkdirSync(base); } catch (e) {}
        var d = N.path.join(base, String(Date.now()));
        N.fs.mkdirSync(d);
        return d;
    }
    function safeName(s) { return String(s).replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|]/g, '_').replace(/\s+$/, '') || 'audio'; }
    function fileName(p) { return String(N.path.basename(p)).replace(/[\\\/:*?"<>|]/g, '_'); }
    /** short tag of a folder (FNV-1a), so files from different folders never share a name in Documents */
    function hash(s) {
        var h = 0x811c9dc5;
        s = String(s).toLowerCase();
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
        return ('0000000' + h.toString(16)).slice(-8).slice(0, 6);
    }
    /** 75.5 -> "01-15.500" (file-name safe; milliseconds only when not whole) */
    function clock(s) {
        s = Math.max(0, s);
        var ms = Math.round(s * 1000) % 1000, t = Math.floor(Math.round(s * 1000) / 1000), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return (t >= 3600 ? Math.floor(t / 3600) + '-' : '') + p(Math.floor(t / 60) % 60) + '-' + p(t % 60) + (ms ? '.' + ('00' + ms).slice(-3) : '');
    }

    function extract() {
        if (S.busy || !nodeOk() || !needEngine()) return;
        setBusy(true);
        S.job = { cancelled: false, parts: null };
        var job = S.job, range = S.range, mute = dom.mute.checked;
        showProgress(0.02, 'Reading the selected layer…');
        host('$._dalaSuite.stems.source(' + q({ range: range }) + ')', function (res) {
            if (job.cancelled) return;
            if (!res.success) { finish(res.message, 'error'); return; }
            var src = res.data;
            function run(audio) {
                var dir = outDir(audio.direct ? audio.path : null);
                if (!dir) { finish('No folder could be written for the stems (the song\'s folder, Documents and Temp are all read-only?).', 'error'); return; }
                // After Effects does not lock the stems it plays: a name stands for one source and one span, so a
                // file is only replaced by the same content - the song's own file name (with its extension, plus
                // its folder when the stems go to the shared Documents folder) and the span in file time. Rendered
                // audio (precomps...) can change between runs: those always get a new file.
                var name;
                if (audio.direct) {
                    var whole = audio.start < 0.01 && Math.abs(audio.end - src.sourceDuration) < 0.05;
                    name = fileName(audio.path) + (N.path.dirname(dir) === N.path.dirname(audio.path) ? '' : ' [' + hash(N.path.dirname(audio.path)) + ']') +
                        (whole ? '' : ' ' + clock(audio.start) + ' to ' + clock(audio.end));
                } else {
                    name = safeName(src.name) + ' ' + clock(src.spanStart) + ' to ' + clock(src.spanEnd);
                }
                var args = [script('dala_stems.py'), 'split', '--audio', audio.path, '--out', dir, '--name', name];
                if (audio.direct) args.push('--overwrite');
                if (audio.start !== null) args.push('--start', String(audio.start), '--end', String(audio.end));
                var first = !(S.model && S.model.state === 'ok');
                showProgress(0.06, first ? 'Getting the 6-stem model ready…' : 'Loading the 6-stem model…');
                runPython(args, 0.06, 0.95, function (code, msg, doneLine) {
                    if (audio.tmp) {                                  // the rendered copy is not needed any more
                        try { N.fs.unlinkSync(audio.path); N.fs.rmdirSync(audio.tmp); } catch (eT) {}
                    }
                    if (job.cancelled) return;
                    if (code !== 0) { cleanParts(job.parts); finish('Splitting the stems failed: ' + msg, 'error'); check(false); return; }
                    var r;
                    try { r = JSON.parse(doneLine); } catch (e) { finish('The stems were made but their list could not be read.', 'error'); return; }
                    if (S.model) S.model.state = 'ok';
                    showModel();
                    var files = [];
                    for (var i = 0; i < STEMS.length; i++) files.push({ key: STEMS[i].key, title: STEMS[i].title, path: r.files[STEMS[i].key] });
                    showProgress(0.97, 'Adding the stems to the comp…');
                    host('$._dalaSuite.stems.importStems(' + q({ compId: src.compId, layerId: src.layerId, index: src.index, name: src.name, sourceName: src.sourceName,
                        files: files, at: src.spanStart, spanStart: src.spanStart, spanEnd: src.spanEnd, mute: mute }) + ')', function (res2) {
                        if (!res2.success) { finish(res2.message + ' (The stems are saved in ' + dir + '.)', 'error'); return; }
                        var quiet = [];
                        for (var k = 0; k < (r.silent || []).length; k++) for (var j = 0; j < STEMS.length; j++) if (STEMS[j].key === r.silent[k]) quiet.push(STEMS[j].title);
                        finish(res2.message + (quiet.length ? ' ' + quiet.join(' and ') + (quiet.length > 1 ? ' are' : ' is') + ' almost silent in this song (no such instrument?).' : '') +
                            ' Saved in ' + dir + ' (' + fmtTime(r.seconds) + ' on the CPU).', 'success');
                    });
                }, first ? 0.3 : 0);
            }
            if (src.file) { run({ path: src.file, start: src.fileStart, end: src.fileEnd, direct: true }); return; }
            // a precomp, or a stretched / time-remapped clip: rendered as it plays in the comp
            var dir = tempDir();
            showProgress(0.03, 'Rendering the audio of "' + src.name + '"…');
            host('$._dalaSuite.captions.renderAudio(' + q({ out: dir.replace(/\\/g, '/') + '/audio.aif', selectedOnly: true, pad: 0, rangeStart: src.spanStart, rangeEnd: src.spanEnd }) + ')', function (r2) {
                if (job.cancelled) return;
                if (!r2.success) { finish(r2.message, 'error'); return; }
                src.spanStart = r2.data.start;
                src.spanEnd = r2.data.start + r2.data.duration;
                run({ path: r2.data.path, start: null, end: null, direct: false, tmp: dir });
            });
        });
    }

    // ------------------------------------------------------------------ init

    function init() {
        if (!$('st-card')) return;
        try { cs = new root.CSInterface(); } catch (e) { cs = null; }
        nodeOk();
        dom = { engine: $('st-engine'), setup: $('st-setup'), setupText: $('st-setup-text'), install: $('st-install'), progress: $('st-progress'),
            fill: $('st-progress-fill'), label: $('st-progress-label'), note: $('st-note'), modelNote: $('st-model-note'), modelGet: $('st-model-get'),
            modelFile: $('st-model-file'), mute: $('st-mute') };
        var rb = $('st-range').querySelectorAll('[data-range]');
        for (var i = 0; i < rb.length; i++) {
            rb[i].addEventListener('click', function () {
                if (S.busy) return;
                S.range = this.getAttribute('data-range');
                for (var j = 0; j < rb.length; j++) rb[j].classList.toggle('active', rb[j] === this);
            });
        }
        $('st-extract').addEventListener('click', extract);
        $('st-recheck').addEventListener('click', function () { if (!S.busy && needEngine()) check(true); });
        $('st-cancel').addEventListener('click', cancel);
        dom.modelGet.addEventListener('click', getModel);
        dom.modelFile.addEventListener('click', useFile);
        dom.install.addEventListener('click', onInstall);
        var nav = document.querySelector('.nav-item[data-view="stems"]');
        function onOpen() { if (!S.busy) refresh(); }
        if (nav) nav.addEventListener('click', onOpen);
        var qs = $('quick-stems');
        if (qs) qs.addEventListener('click', function () { if (nav) nav.click(); });
    }

    root.DalaStemsUI = { refresh: refresh, extract: extract, state: function () { return S; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
