/**
 * Dala Suite - Audio tools panel (ES5): Beat Marker and Vocal Remover.
 * Both run on the speech engine's private Python (engineSetup.js). Beat Marker extracts the drums with an ONNX model
 * (HT-Demucs FT drums, on the engine's onnxruntime; downloaded once, verified) and marks the selected layer or the
 * composition over the work area (dala_audio.py beats; host audio.beatSource / addBeats / importDrums).
 * Vocal Remover needs a one-time add-on
 * (Demucs v4 + PyTorch CPU, installed by engineSetup.installAudio) and its model files (dala_models.py: pinned,
 * resumed, checksum-verified). The audio is the selected layer's own file when it plays one file straight;
 * a precomp or a time-remapped clip is rendered first (host captions.renderAudio, its in / out span).
 */
(function (root) {
    'use strict';
    var cs = null, N = null, setupApi = null, dom = {};
    var S = { busy: false, job: null, every: 1, tempo: 'auto', target: 'layer', model: 'htdemucs', engine: 'unknown', addon: false, models: {}, action: null };
    var SIZES = { htdemucs: '84 MB', htdemucs_ft: '337 MB', htdemucs_ft_drums: '166 MB' };
    var DRUMS = 'htdemucs_ft_drums';

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

    // ------------------------------------------------------------------ progress / state

    function showProgress(f, label) {
        dom.progress.style.display = 'flex';
        if (f !== null && f !== undefined) dom.fill.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
        if (label) dom.label.textContent = label;
    }
    function hideProgress() { dom.progress.style.display = 'none'; }
    function setBusy(b) {
        S.busy = b;
        var btns = document.querySelectorAll('#au-card .btn');
        for (var i = 0; i < btns.length; i++) btns[i].disabled = b;
    }
    function note(t) { dom.note.textContent = t || ''; }
    function finish(msg, type) {
        S.job = null;
        setBusy(false);
        hideProgress();
        if (msg) { note(msg); toast(msg, type || 'info'); }
    }

    function badge(text, kind) {
        dom.engine.textContent = text;
        dom.engine.className = 'at-engine cap-engine' + (kind ? ' ' + kind : '');
    }
    function showSetup(text, button, action) {
        dom.setup.style.display = text ? 'flex' : 'none';
        dom.setupText.textContent = text || '';
        dom.install.textContent = button || '';
        dom.install.style.display = button ? '' : 'none';
        S.action = action || null;
    }

    /** Runs an engine script; streams STATUS / DOWNLOAD / PROGRESS lines. done(code, lastError, doneLine) */
    function runPython(args, p0, p1, label, done, dlShare) {
        // dlShare: part of the bar a first-time model download takes; the work's own progress continues after it
        var share = dlShare || 0, downloaded = false;
        var st = setup().status(), child;
        try { child = N.cp.spawn(st.python, args, { windowsHide: true, env: setup().pythonEnv() }); }
        catch (e) { done(-1, 'Could not start the audio engine: ' + e.message); return; }
        if (S.job) S.job.child = child;
        var buf = '', errTail = '', lastError = '', doneLine = '', okLine = '', finished = false;
        function handle(line) {
            var m;
            if ((m = line.match(/^STATUS (.*)$/))) showProgress(null, m[1]);
            else if ((m = line.match(/^DOWNLOAD (\d+) (\d+)$/))) { var a = +m[1], b = +m[2]; downloaded = true; showProgress(p0 + (p1 - p0) * (share || 0.4) * Math.min(1, a / b), (label || 'Downloading') + ' ' + fmtBytes(a) + ' of ' + fmtBytes(b)); }
            else if ((m = line.match(/^PROGRESS ([\d.]+)$/))) { var f = +m[1], base = (downloaded && share) ? share : 0; showProgress(p0 + (p1 - p0) * (base + (1 - base) * f), null); }
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

    // ------------------------------------------------------------------ engine / add-on state

    function refresh() {
        var su = setup();
        if (!su) { badge('UNAVAILABLE', 'bad'); showSetup('This panel cannot run its audio engine (Node.js is off). Restart After Effects.'); return; }
        if (!su.supported) { badge('WINDOWS ONLY', 'bad'); showSetup('The audio tools run on Windows for now.'); return; }
        var st = su.status();
        if (st.state === 'missing') {
            S.engine = 'missing';
            badge('SETUP NEEDED', 'warn');
            showSetup('The audio tools run on Dala Suite\'s own engine (Python included, nothing else to install). Install it once: about 200 MB.', 'INSTALL ENGINE', 'engine');
            showModels();
            return;
        }
        S.engine = 'ready';
        S.addon = su.audioInstalled();
        badge('READY', '');
        if (!S.addon) showSetup('Beat Marker is ready (its drum model downloads on the first run). Vocal Remover needs a one-time add-on: about 230 MB to download, 1.4 GB on disk.', 'INSTALL VOCAL REMOVER', 'addon');
        else showSetup('');
        modelStatus(false);
    }

    function modelLine() {
        var m = S.models[S.model];
        var nm = S.model === 'htdemucs' ? 'Fast model' : 'Best model';
        if (!S.addon) return nm + ' (' + SIZES[S.model] + ') downloads on first use, after the add-on is installed.';
        if (!m) return nm + ': checking…';
        if (m === 'ok') return nm + ' ready (' + SIZES[S.model] + ', verified).';
        if (m === 'missing') return nm + ' not downloaded yet (' + SIZES[S.model] + '): it downloads on the first run.';
        if (m === 'incomplete') return nm + ' download incomplete: it resumes on the next run.';
        return nm + ' is damaged: press Recheck models, then Separate to repair it.';
    }

    function drumLine() {
        var m = S.models[DRUMS];
        if (S.engine !== 'ready') return 'Drum model (' + SIZES[DRUMS] + '): downloads on the first run, after the engine is installed.';
        if (!m) return 'Drum model: checking…';
        if (m === 'ok') return 'Drum model ready (' + SIZES[DRUMS] + ', verified).';
        if (m === 'missing') return 'Drum model not downloaded yet (' + SIZES[DRUMS] + '): it downloads on the first run, or now.';
        if (m === 'incomplete') return 'Drum model download incomplete: it resumes where it stopped.';
        return 'Drum model is damaged: it is downloaded again (only the damaged file).';
    }
    function showModels() {
        dom.modelNote.textContent = modelLine();
        dom.drumNote.textContent = drumLine();
        var m = S.models[DRUMS];
        dom.drumGet.style.display = (S.engine === 'ready' && m && m !== 'ok') ? '' : 'none';
        dom.drumGet.textContent = m === 'incomplete' ? 'RESUME' : (m === 'corrupt' ? 'REPAIR' : 'DOWNLOAD');
    }

    function modelStatus(deep) {
        if (S.engine !== 'ready') { showModels(); return; }
        var args = [script('dala_models.py'), 'status', '--names', DRUMS + ',htdemucs,htdemucs_ft'];
        if (deep) args.push('--deep');
        if (deep) { setBusy(true); S.job = { child: null }; showProgress(0.1, 'Checking the drum and vocal remover models (sizes and checksums)…'); }
        runPython(args, 0.1, 0.9, '', function (code, msg, ok) {
            var list = null;
            try { list = JSON.parse(ok); } catch (e) { list = null; }
            if (list) for (var i = 0; i < list.length; i++) S.models[list[i].name] = list[i].state;
            showModels();
            if (deep) {
                var bad = [];
                if (list) for (var j = 0; j < list.length; j++) if (list[j].state === 'corrupt' || list[j].state === 'incomplete') bad.push(list[j].label);
                finish(list ? (bad.length ? 'Needs repair: ' + bad.join(', ') + '. Press Download / Repair (or run the tool) to fetch only the missing or damaged files again.' : 'Models checked: every downloaded file is complete and verified.') : 'Could not check the models: ' + msg, bad.length ? 'info' : 'success');
            }
        });
    }

    /** downloads (or resumes / repairs) the drum model on its own, verified like every model */
    function downloadDrums() {
        if (S.busy || !nodeOk() || !needEngine()) return;
        setBusy(true);
        S.job = { cancelled: false };
        var job = S.job;
        showProgress(0.02, 'Checking the drum model…');
        runPython([script('dala_models.py'), 'download', DRUMS], 0.02, 0.98, 'Downloading the drum model…', function (code, msg) {
            if (job.cancelled) { modelStatus(false); return; }
            if (code !== 0) { finish('The drum model could not be downloaded: ' + msg + ' Press Download to try again (it resumes).', 'error'); modelStatus(false); return; }
            S.models[DRUMS] = 'ok';
            showModels();
            finish('Drum model downloaded and verified.', 'success');
        }, 1);
    }

    function onInstall() {
        if (S.busy) return;
        var su = setup(), action = S.action;
        if (!su || !action) return;
        setBusy(true);
        var log = [];
        showProgress(0.01, action === 'engine' ? 'Preparing the engine install…' : 'Preparing the vocal remover install…');
        var handle = (action === 'engine' ? su.install : su.installAudio)({
            onProgress: function (f, l) { showProgress(f, l); },
            onLog: function (l) { log.push(l); if (log.length > 300) log.shift(); }
        }, function (e) {
            try { N.fs.writeFileSync(N.path.join(su.paths.base, 'install-log.txt'), new Date().toISOString() + '\r\n' + (e ? 'FAILED ' + e.code + ': ' + e.message + '\r\n' + (e.detail || '') + '\r\n\r\n' : '') + log.join('\r\n')); } catch (eW) {}
            if (e && e.code === 'cancelled') { finish('Install cancelled; nothing was changed.', 'info'); refresh(); return; }
            if (e) { finish(e.message, 'error'); dom.setupText.textContent = e.message; dom.install.textContent = 'TRY AGAIN'; return; }
            finish(action === 'engine' ? 'Audio engine installed.' : 'Vocal remover installed.', 'success');
            refresh();
        });
        S.job = { setup: handle };
    }

    function cancel() {
        var j = S.job;
        if (!j) return;
        if (j.setup) { j.setup.cancel(); return; }
        j.cancelled = true;
        try { if (j.child) j.child.kill(); } catch (e) {}
        finish('Cancelled.', 'info');
        modelStatus(false);                                 // a stopped download shows as "incomplete: resume"
    }

    // ------------------------------------------------------------------ source audio

    function tempDir() {
        var base = N.path.join(N.os.tmpdir(), 'DalaAudio');
        try { if (!N.fs.existsSync(base)) N.fs.mkdirSync(base); } catch (e) {}
        var d = N.path.join(base, String(Date.now()));
        N.fs.mkdirSync(d);
        return d;
    }

    /** cb(err, { sel, path, offset }) - offset: comp time of the audio file's start */
    function sourceAudio(cb) {
        host('$._dalaSuite.audio.selection()', function (res) {
            if (!res.success) { cb(res.message); return; }
            var sel = res.data;
            if (sel.file) { cb(null, { sel: sel, path: sel.file, offset: sel.startTime, rendered: false }); return; }
            var dir = tempDir();
            showProgress(0.03, 'Rendering the audio of "' + sel.name + '"…');
            host('$._dalaSuite.captions.renderAudio(' + q({ out: dir.replace(/\\/g, '/') + '/audio.aif', selectedOnly: true, rangeStart: sel.inPoint, rangeEnd: sel.outPoint }) + ')', function (r2) {
                if (!r2.success) { cb(r2.message); return; }
                cb(null, { sel: sel, path: r2.data.path, offset: r2.data.start, rendered: true, dir: dir });
            });
        });
    }

    function needEngine() {
        if (S.engine === 'ready') return true;
        toast('Install the audio engine first (button at the top).', 'error');
        return false;
    }

    // ------------------------------------------------------------------ beat marker

    /** The audio Beat Marker analyses, for the work area. cb(err, a) with a.path (file to read), a.start / a.end
     *  (span of that file to analyse, seconds; null = whole file) and a.offset (comp time of the file's start).
     *  Composition: the comp's mix, rendered. Selected layer: its own file when it plays one file straight,
     *  otherwise (precomp, time remap) that layer rendered alone. */
    function beatAudio(src, cb) {
        if (src.target === 'layer' && src.file) { cb(null, { path: src.file, start: src.fileStart, end: src.fileEnd, offset: src.startTime, rendered: false }); return; }
        var dir = tempDir();
        showProgress(0.03, src.target === 'comp' ? 'Rendering the comp\'s audio (work area)…' : 'Rendering the audio of "' + src.name + '"…');
        host('$._dalaSuite.captions.renderAudio(' + q({ out: dir.replace(/\\/g, '/') + '/audio.aif', selectedOnly: src.target !== 'comp', pad: 0,
            rangeStart: src.spanStart, rangeEnd: src.spanEnd }) + ')', function (r2) {
            if (!r2.success) { cb(r2.message); return; }
            cb(null, { path: r2.data.path, start: null, end: null, offset: r2.data.start, rendered: true });
        });
    }

    function drumsFile(src, audio) {
        var name = String(src.target === 'comp' ? src.compName : (src.sourceName || src.name)).replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|]/g, '_');
        var dir = stemDir({ path: audio.path, rendered: audio.rendered });
        if (!dir) return null;
        var p = N.path.join(dir, name + ' [drums].wav'), n = 2;
        // a drums file still used by the project is kept (After Effects may hold it open): the next one gets a number
        while (N.fs.existsSync(p)) {
            try { N.fs.unlinkSync(p); break; } catch (e) { p = N.path.join(dir, name + ' [drums] ' + (n++) + '.wav'); }
        }
        return p;
    }

    function beats() {
        if (S.busy || !nodeOk() || !needEngine()) return;
        setBusy(true);
        S.job = { cancelled: false };
        var job = S.job, target = S.target, every = S.every, addDrums = dom.addDrums.checked;
        showProgress(0.02, target === 'comp' ? 'Reading the composition…' : 'Reading the selected layer…');
        host('$._dalaSuite.audio.beatSource(' + q({ target: target }) + ')', function (res) {
            if (job.cancelled) return;
            if (!res.success) { finish(res.message, 'error'); return; }
            var src = res.data;
            beatAudio(src, function (err, audio) {
                if (job.cancelled) return;
                if (err) { finish(err, 'error'); return; }
                var out = N.path.join(tempDir(), 'beats.json');
                var drums = addDrums ? drumsFile(src, audio) : null;
                var args = [script('dala_audio.py'), 'beats', '--audio', audio.path, '--out', out];
                if (audio.start !== null && audio.start !== undefined) args.push('--start', String(Math.max(0, audio.start)), '--end', String(audio.end));
                if (drums) args.push('--drums-out', drums);
                runPython(args, 0.08, 0.92, 'Downloading the drum model (first time only)…', function (code, msg) {
                    if (job.cancelled) return;
                    if (code !== 0) { finish('Beat marking failed: ' + msg, 'error'); modelStatus(false); return; }
                    S.models[DRUMS] = 'ok';
                    showModels();
                    var r;
                    try { r = JSON.parse(N.fs.readFileSync(out, 'utf8')); } catch (e) { finish('Could not read the beat analysis.', 'error'); return; }
                    var t, bpm = r.bpm, phase = r.barPhase, i, kind = 'beat', ev = every;
                    if (every === 'hits') {
                        t = r.hits.slice(); kind = 'hit'; ev = 1; phase = 0;
                    } else {
                        t = r.beats.slice();
                        if (S.tempo === 'double') {
                            var d = [];
                            for (i = 0; i < t.length; i++) { d.push(t[i]); if (i + 1 < t.length && t[i + 1] - t[i] < 1.6 * 60 / bpm) d.push((t[i] + t[i + 1]) / 2); }
                            t = d; bpm *= 2; phase *= 2;
                        } else if (S.tempo === 'half') {
                            var h = [];
                            for (i = phase % 2; i < t.length; i += 2) h.push(t[i]);
                            t = h; bpm /= 2; phase = Math.floor(phase / 2);
                        }
                    }
                    if (!t.length) { finish(kind === 'hit' ? 'No clear drum hits were found in the work area.' : 'No beat was found in the work area.', 'error'); return; }
                    var times = t.map(function (x) { return x + audio.offset; });
                    var ph = ev === 4 ? phase % 4 : (ev === 2 ? phase % 2 : 0);
                    showProgress(0.95, 'Adding markers…');
                    host('$._dalaSuite.audio.addBeats(' + q({ target: target, compId: src.compId, index: src.index, name: src.name, times: times, every: ev, phase: ph, bpm: bpm, kind: kind }) + ')', function (res2) {
                        var extra = '';
                        if (res2.success && r.source === 'mix-nodrums') extra += ' No drums were found in this audio, so the beat was taken from the full mix: check it by ear.';
                        else if (res2.success && r.steadiness < 0.8 && kind === 'beat') extra += ' The tempo varies in this audio, so check the markers by ear.';
                        if (!res2.success || !drums || !r.drums) { finish(res2.message + extra, res2.success ? 'success' : 'error'); return; }
                        host('$._dalaSuite.audio.importDrums(' + q({ target: target, compId: src.compId, index: src.index, name: src.name, file: r.drums,
                            at: audio.offset + (r.start || 0), source: target === 'comp' ? src.compName : (src.sourceName || src.name) }) + ')', function (res3) {
                            finish(res2.message + extra + (res3.success ? ' ' + res3.message : ' (The drums track could not be added: ' + res3.message + ')'), 'success');
                        });
                    });
                }, 0.35);
            });
        });
    }

    function clearBeats() {
        if (S.busy) return;
        host('$._dalaSuite.audio.clearBeats(' + q({ target: S.target }) + ')', function (r2) {
            note(r2.message);
            toast(r2.message, r2.success ? 'success' : 'info');
        });
    }

    // ------------------------------------------------------------------ vocal remover

    function stemDir(src) {
        var cands = [];
        if (!src.rendered) cands.push(N.path.join(N.path.dirname(src.path), 'Dala Stems'));
        cands.push(N.path.join(N.os.homedir(), 'Documents', 'Dala Suite', 'Stems'));
        cands.push(N.path.join(N.os.tmpdir(), 'Dala Stems'));
        for (var i = 0; i < cands.length; i++) {
            try {
                if (!N.fs.existsSync(cands[i])) {
                    var parts = cands[i].split(/[\\\/]/), acc = parts[0];
                    for (var k = 1; k < parts.length; k++) { acc = acc + '\\' + parts[k]; if (!N.fs.existsSync(acc)) N.fs.mkdirSync(acc); }
                }
                var probe = N.path.join(cands[i], '.write-test');
                N.fs.writeFileSync(probe, 'ok');
                N.fs.unlinkSync(probe);
                return cands[i];
            } catch (e) {}
        }
        return null;
    }

    function separate() {
        if (S.busy || !nodeOk() || !needEngine()) return;
        if (!S.addon) { toast('Install the vocal remover add-on first (button at the top).', 'error'); return; }
        setBusy(true);
        S.job = { cancelled: false };
        var job = S.job, model = S.model;
        showProgress(0.02, 'Reading the selected layer…');
        sourceAudio(function (err, src) {
            if (job.cancelled) return;
            if (err) { finish(err, 'error'); return; }
            var outDir = stemDir(src);
            if (!outDir) { finish('No folder could be written for the stems (Documents, the source folder and Temp are all read-only?).', 'error'); return; }
            var name = String(src.sel.sourceName || src.sel.name).replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|]/g, '_');
            runPython([script('dala_audio.py'), 'separate', '--audio', src.path, '--out', outDir, '--model', model, '--name', name], 0.05, 0.93,
                'Downloading the vocal remover model…', function (code, msg, doneLine) {
                    if (job.cancelled) return;
                    if (code === 3) { S.addon = false; finish('The vocal remover add-on is missing: install it with the button at the top.', 'error'); refresh(); return; }
                    if (code !== 0) { finish('Vocal separation failed: ' + msg, 'error'); return; }
                    var r;
                    try { r = JSON.parse(doneLine); } catch (e) { finish('The separation finished but its result could not be read.', 'error'); return; }
                    S.models[model] = 'ok';
                    dom.modelNote.textContent = modelLine();
                    showProgress(0.96, 'Importing the stems…');
                    host('$._dalaSuite.audio.importStems(' + q({ compId: src.sel.compId, index: src.sel.index, name: src.sel.name, files: [r.vocals, r.instrumental],
                        addToComp: dom.addComp.checked, mute: dom.mute.checked, at: src.offset, model: model }) + ')', function (res) {
                        finish((res.success ? res.message + ' Saved in ' + outDir + ' (' + Math.round(r.seconds) + ' s on the ' + (r.device === 'cuda' ? 'GPU' : 'CPU') + ').' : res.message), res.success ? 'success' : 'error');
                    });
                }, 0.4);
        });
    }

    // ------------------------------------------------------------------ init

    function group(id, attr, key, after) {
        var btns = $(id).querySelectorAll('[data-' + attr + ']');
        for (var i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', function () {
                var v = this.getAttribute('data-' + attr);
                S[key] = (key === 'every' && v !== 'hits') ? +v : v;
                for (var j = 0; j < btns.length; j++) btns[j].classList.toggle('active', btns[j] === this);
                if (after) after();
            });
        }
    }

    function init() {
        if (!$('au-card')) return;
        try { cs = new root.CSInterface(); } catch (e) { cs = null; }
        nodeOk();
        dom = { engine: $('au-engine'), setup: $('au-setup'), setupText: $('au-setup-text'), install: $('au-install'), progress: $('au-progress'),
            fill: $('au-progress-fill'), label: $('au-progress-label'), note: $('au-note'), modelNote: $('au-model-note'), addComp: $('au-addcomp'), mute: $('au-mute'),
            addDrums: $('au-adddrums'), drumNote: $('au-drum-note'), drumGet: $('au-drum-get') };
        group('au-target', 'target', 'target');
        group('au-every', 'every', 'every');
        dom.drumGet.addEventListener('click', downloadDrums);
        group('au-tempo', 'tempo', 'tempo');
        group('au-model', 'model', 'model', showModels);
        $('au-beats').addEventListener('click', beats);
        $('au-beats-clear').addEventListener('click', clearBeats);
        $('au-separate').addEventListener('click', separate);
        $('au-recheck').addEventListener('click', function () { if (!S.busy && needEngine()) modelStatus(true); });
        $('au-cancel').addEventListener('click', cancel);
        dom.install.addEventListener('click', onInstall);
        var nav = document.querySelector('.nav-item[data-view="audio"]'), checked = false;
        function onOpen() { if (!checked || !S.busy) { checked = true; if (!S.busy) refresh(); } }
        if (nav) nav.addEventListener('click', onOpen);
        var qa = $('quick-audio');
        if (qa) qa.addEventListener('click', onOpen);
    }

    root.DalaAudioUI = { refresh: refresh, beats: beats, separate: separate, clearBeats: clearBeats, state: function () { return S; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
