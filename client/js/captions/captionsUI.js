/**
 * CFX Suite - Auto Captions panel controller (ES5)
 *
 * From [spoken language] <-> To [caption language], like Google Translate:
 *   Test audio          renders the selected audio layer / precomp (or the whole comp) for the work area,
 *                       recognises the speech and shows what was said and the caption lines - no layers
 *   Generate captions   builds one caption per line in the style picked on the CAPTION STYLE tab: Woodl Style
 *                       (one text layer per caption) or a style family (Text Preset 1 / 2), whose look for each
 *                       line the director chooses (captionDirector.js); when the audio has not changed since
 *                       Test audio, the (edited) caption lines are used as they are
 *   Clear created layers  deletes only the caption layers Dala built
 * Spoken Tamil / Hindi (option, on): captions in film Tamil / everyday Hindi, not the formal written register.
 * Speech recognition: whisper/dala_transcribe.py (faster-whisper, offline). Every translation (Tamil / Hindi /
 * English, into English too) is made from the transcript by MADLAD-400 3B (whisper/dala_setup_mt.py downloads it
 * once, about 3 GB, the first time a translation is asked for).
 */
(function (root) {
    'use strict';

    var STORE_KEY = 'cfxSuite.captions.v2';
    var FROM = [
        { id: 'auto', label: 'Detect language' },
        { id: 'ta', label: 'Tamil' },
        { id: 'en', label: 'English' },
        { id: 'tanglish', label: 'Tanglish', sub: 'Tamil + English' },
        { id: 'hinglish', label: 'Hinglish', sub: 'Hindi + English' }
    ];
    var TO = [
        { id: 'ta', label: 'Tamil' },
        { id: 'en', label: 'English' },
        { id: 'tanglish', label: 'Tanglish', sub: 'Tamil + English' },
        { id: 'hinglish', label: 'Hinglish', sub: 'Hindi + English' }
    ];
    var NAMES = { auto: 'Detect language', ta: 'Tamil', en: 'English', hi: 'Hindi', tanglish: 'Tanglish', hinglish: 'Hinglish' };
    // fonts with the letters of non-Latin scripts (Windows ships these): Tamil captions
    var SCRIPT_FONTS = { ta: ['NirmalaUI-Bold', 'NirmalaText-Bold'] };

    var cs = null, dom = {}, N = null;
    var S = {
        opts: { from: 'auto', to: 'en', model: 'large-v3', position: 'center', size: 100, words: 7, selOnly: true, punct: true, replace: true, gpu: true,
            style: 'woodl', styleMode: 'smart', spoken: true, sync: 'auto' },
        styles: null,      // captions/styles/index.json
        families: {},      // loaded style families (Text Preset 1 / 2) by id
        python: null, engine: null, engineState: null, checking: false, installing: false, setupAction: null,
        busy: false, job: null,
        preview: null,     // last recognition: { key, result, audio, info, plan, planKey }
        detected: null     // last detected spoken language id (ta / en / hi / tanglish / hinglish)
    };

    // ------------------------------------------------------------------ node / paths

    function nodeDiagnostic() {
        var r = (typeof root.require === 'function') ? 'root.req' :
                (typeof window !== 'undefined' && typeof window.require === 'function') ? 'win.req' :
                (typeof require === 'function') ? 'req' :
                (root.cep_node && typeof root.cep_node.require === 'function') ? 'cep_node' : 'none';
        var missing = [];
        ['fs', 'path', 'os', 'child_process', 'https', 'crypto', 'url'].forEach(function(m) {
            try { if (!req(m)) missing.push(m); } catch (e) { missing.push(m + ':' + e.message); }
        });
        var setup = root.CFXEngineSetup || root.DalaEngineSetup;
        return "Loader: " + r + " | Missing: " + (missing.length ? missing.join(',') : 'none') + " | SetupClass: " + (setup ? 'OK' : 'MISSING');
    }

    function req(m) {
        try {
            if (typeof root.require === 'function') return root.require(m);
            if (typeof window !== 'undefined' && typeof window.require === 'function') return window.require(m);
            if (typeof require === 'function') return require(m);
            if (root.cep_node && typeof root.cep_node.require === 'function') return root.cep_node.require(m);
            if (typeof window !== 'undefined' && window.cep && window.cep.node && typeof window.cep.node.require === 'function') return window.cep.node.require(m);
        } catch (e) {}
        return null;
    }
    function nodeOk() {
        if (N) return true;
        var fs = req('fs'), path = req('path'), os = req('os'), cp = req('child_process'), https = req('https'), crypto = req('crypto'), url = req('url');
        if (fs && path && os && cp && https && crypto && url) N = { fs: fs, path: path, os: os, cp: cp, https: https, crypto: crypto, url: url };
        return !!N;
    }
    function extRoot() {
        var p = '';
        try { p = cs.getSystemPath('extension'); } catch (e) { p = ''; }
        if (!p || p === '/DalaSuite' || p === '/CFXSuite' || p === '/com.cfx.suite') p = decodeURIComponent(root.location.pathname).replace(/\/client\/[^\/]*$/, '');
        p = String(p).replace(/^file:\/+/i, '');
        if (/^\/[A-Za-z]:/.test(p)) p = p.substring(1);
        return p.replace(/\\/g, '/').replace(/\/+$/, '');
    }
    function $(id) { return document.getElementById(id); }

    function loadOpts() {
        try {
            var saved = JSON.parse(root.localStorage.getItem(STORE_KEY) || 'null');
            if (saved) {
                for (var k in saved.opts || {}) if (saved.opts.hasOwnProperty(k) && S.opts.hasOwnProperty(k)) S.opts[k] = saved.opts[k];
            }
        } catch (e) {}
    }
    function saveOpts() {
        try { root.localStorage.setItem(STORE_KEY, JSON.stringify({ opts: S.opts })); } catch (e) {}
    }

    function toast(message, type) { if (window.DalaToast) window.DalaToast(message, type); }

    function host(fn, arg, cb) {
        var call = '$._cfxSuite.captions.' + fn + '(' + (arg === undefined ? '' : JSON.stringify(JSON.stringify(arg))) + ')';
        if (!cs) { cb({ success: false, message: 'After Effects is not connected.' }); return; }
        cs.evalScript(call, function (raw) {
            var res;
            try { res = JSON.parse(raw); }
            catch (e) { res = { success: false, message: (raw && raw !== 'undefined') ? String(raw) : 'After Effects did not answer (is the CFX Suite host script loaded?)' }; }
            cb(res);
        });
    }

    function fmtBytes(b) { return b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB'; }

    // ------------------------------------------------------------------ speech engine (private runtime)
    // The engine is CFX Suite's own Python + faster-whisper in %LOCALAPPDATA%\DalaSuite\engine, installed by
    // engineSetup.js. The customer's own Python (if any) is never used, so no Python install, PATH setting,
    // version or package on their PC can break Auto Captions.

    function scriptPath(name) { return extRoot() + '/whisper/' + (name || 'dala_transcribe.py'); }

    var setupApi = null;
    function engineSetup() {
        if (setupApi) return setupApi;
        var setupClass = root.CFXEngineSetup || root.DalaEngineSetup;
        if (!nodeOk() || !setupClass) return null;
        var proc = root.process || (typeof window !== 'undefined' && window.process) || req('process') || (typeof process !== 'undefined' ? process : null);
        setupApi = setupClass.create(N, (proc && proc.env) || {}, extRoot());
        return setupApi;
    }

    /** cb(null, info) when the engine starts; otherwise cb('no-node' | 'engine-missing' | {code, message, detail}). */
    function checkEngine(cb, force) {
        if (S.engine && !force) { cb(null, S.engine); return; }
        if (!nodeOk()) { cb('no-node'); return; }
        var setup = engineSetup();
        if (!setup) { cb('no-setup'); return; }
        if (!setup.supported) { cb('unsupported'); return; }
        var st = setup.status();
        if (st.state === 'missing') { S.engine = null; cb('engine-missing'); return; }
        setup.check(function (e, info) {
            if (e) { S.engine = null; cb(e); return; }
            S.python = st.python; S.engine = info; S.engineState = st.state;
            if (info.mt) setup.removeConverter();     // the translator is converted: its 300 MB converter can go
            cb(null, info);
        });
    }

    function setEngineBadge(text, kind, title) {
        dom.engine.textContent = text;
        dom.engine.className = 'at-engine cap-engine' + (kind ? ' ' + kind : '');
        if (title) dom.engine.title = title;
    }

    /** The setup box: a message and one button (action: install | gpu | check | null = no button). */
    function showSetup(text, button, action, detail) {
        dom.setup.style.display = 'flex';
        dom.setupText.textContent = text;
        dom.setupText.title = detail || '';
        dom.install.textContent = button || '';
        dom.install.style.display = button ? '' : 'none';
        S.setupAction = action || null;
    }

    function refreshEngine(force) {
        if (S.checking || S.installing) return;
        S.checking = true;
        setEngineBadge('CHECKING…', 'warn');
        checkEngine(function (err, info) {
            S.checking = false;
            if (err === 'no-node') {
                setEngineBadge('UNAVAILABLE', 'bad');
                showSetup('Node.js runtime is unavailable (' + nodeDiagnostic() + '). Please restart After Effects so CEP command line switches apply.', 'CHECK AGAIN', 'check');
                return;
            }
            if (err === 'no-setup') {
                setEngineBadge('UNAVAILABLE', 'bad');
                showSetup('CFX Suite could not initialize the speech engine module (' + nodeDiagnostic() + '). Please reload CFX Suite.', 'CHECK AGAIN', 'check');
                return;
            }
            if (err === 'unsupported') {
                setEngineBadge('WINDOWS ONLY', 'bad');
                showSetup('Auto Captions runs on Windows for now: its offline speech engine is not available for macOS yet.', '', null);
                return;
            }
            if (err === 'engine-missing') {
                setEngineBadge('SETUP NEEDED', 'warn');
                showSetup('Auto Captions needs its speech engine: a one-time download of about 200 MB that installs itself (Python is included; nothing else to set up). The first caption run then downloads a speech model.', 'INSTALL SPEECH ENGINE', 'install');
                return;
            }
            if (err) {
                setEngineBadge('REPAIR NEEDED', 'bad');
                showSetup(err.message + ' Press Repair to reinstall it (your speech models are kept).', 'REPAIR SPEECH ENGINE', 'install', err.detail);
                return;
            }
            var gpuReady = info.gpu && info.gpu.devices > 0 && info.gpu.cublas;
            var gpuPossible = info.gpu && info.gpu.devices > 0 && !info.gpu.cublas;
            setEngineBadge('WHISPER · ' + (gpuReady && S.opts.gpu ? 'GPU' : 'CPU'), '',
                'Offline speech recognition (faster-whisper ' + info.faster_whisper + '). Models on this PC: ' + (info.models.length ? info.models.join(', ') : 'none yet') + (info.mt ? '; translator ready' : ''));
            updateModelRow(false);
            if (S.engineState === 'outdated') {
                showSetup('A newer speech engine is available for this version of CFX Suite (one-time download, about 200 MB).', 'UPDATE SPEECH ENGINE', 'install');
            } else if (gpuPossible && S.opts.gpu) {
                showSetup('Your NVIDIA GPU can transcribe about 6x faster after a one-time download of its CUDA library (about 550 MB). Captions also work on the CPU without it.', 'ENABLE GPU', 'gpu');
            } else {
                dom.setup.style.display = 'none';
                S.setupAction = null;
            }
        }, force);
    }

    /** Keeps the last install's output for support: %LOCALAPPDATA%\DalaSuite\install-log.txt */
    function saveInstallLog(lines, e) {
        var setup = engineSetup();
        if (!setup) return '';
        var file = N.path.join(setup.paths.base, 'install-log.txt');
        try {
            N.fs.writeFileSync(file, new Date().toISOString() + '\r\n' + (e ? 'FAILED ' + e.code + ': ' + e.message + '\r\n' + (e.detail || '') + '\r\n\r\n' : '') + lines.join('\r\n'));
            return file;
        } catch (eW) { return ''; }
    }

    function onInstallClick() {
        if (S.busy || S.installing) return;
        var action = S.setupAction;
        if (action === 'check' || !action) { S.engine = null; refreshEngine(true); return; }
        var setup = engineSetup();
        if (!setup) { refreshEngine(true); return; }
        var isGpu = action === 'gpu', log = [];
        S.installing = true;
        setBusy(true);
        setEngineBadge(isGpu ? 'INSTALLING GPU' : 'INSTALLING…', 'warn');
        dom.setupText.textContent = isGpu ? 'Installing the GPU library. You can keep working in After Effects.' :
            'Installing the speech engine. You can keep working in After Effects; this takes a few minutes on a normal connection.';
        showProgress(0.01, isGpu ? 'Preparing the GPU library…' : 'Preparing the speech engine install…');
        var handle = (isGpu ? setup.installGpu : setup.install)({
            onProgress: function (f, label) { showProgress(f, label); },
            onLog: function (l) { log.push(l); if (log.length > 400) log.shift(); }
        }, function (e) {
            S.installing = false;
            S.job = null;
            setBusy(false);
            hideProgress();
            var logFile = saveInstallLog(log, e);
            if (e && e.code === 'cancelled') {
                toast('Install cancelled. Nothing was changed; press the button to start again.', 'info');
                S.engine = null;
                refreshEngine(true);
                return;
            }
            if (e) {
                setEngineBadge(isGpu ? 'GPU SETUP FAILED' : 'SETUP FAILED', 'bad');
                showSetup(e.message + (logFile ? ' (Details: ' + logFile + ')' : ''), 'TRY AGAIN', action, e.detail);
                toast(e.message, 'error');
                return;
            }
            toast(isGpu ? 'GPU acceleration is ready.' : 'Speech engine installed. Auto Captions is ready.', 'success');
            S.engine = null;
            refreshEngine(true);
        });
        S.job = { cancelled: false, setup: handle };
    }

    /** Runs an engine step with streamed STATUS / DOWNLOAD / PROGRESS lines. done(code, lastError) */
    function runPython(args, label, p0, p1, done) {
        var child;
        try { child = N.cp.spawn(S.python, args, { windowsHide: true, env: engineSetup().pythonEnv() }); }
        catch (eSpawn) { done(-1, 'Could not start the speech engine: ' + eSpawn.message); return; }
        if (S.job) S.job.child = child;
        var buf = '', errTail = '', lastError = '', device = '', finished = false;
        child.stdout.on('data', function (d) {
            buf += String(d);
            var lines = buf.split(/\r?\n/);
            buf = lines.pop();
            for (var i = 0; i < lines.length; i++) handle(lines[i]);
        });
        child.stderr.on('data', function (d) { errTail = (errTail + String(d)).slice(-600); });
        function handle(line) {
            var m;
            if ((m = line.match(/^STATUS (.*)$/))) showProgress(null, m[1]);
            else if ((m = line.match(/^DOWNLOAD (\d+) (\d+)$/))) {
                var a = +m[1], b = +m[2];
                showProgress(p0 + (p1 - p0) * 0.5 * Math.min(1, a / b), label + ' ' + fmtBytes(a) + ' of ' + fmtBytes(b) + ' (first time only)');
            } else if ((m = line.match(/^PROGRESS ([\d.]+)$/))) {
                showProgress(p0 + (p1 - p0) * (+m[1]), null);
            } else if ((m = line.match(/^DEVICE (\S+)/))) device = m[1];
            else if ((m = line.match(/^ERROR (.*)$/))) lastError = m[1];
        }
        child.on('error', function (e) { if (!finished) { finished = true; done(-1, 'Could not start the speech engine: ' + e.message + '. Press Repair in the Auto Captions panel.'); } });
        child.on('close', function (code) {
            if (finished) return;
            finished = true;
            if (buf) handle(buf);
            done(code, lastError || errTail.split(/\r?\n/).filter(Boolean).pop() || ('exit code ' + code), device);
        });
    }

    // ------------------------------------------------------------------ speech model: status / recheck / download
    // A model counts as installed only when every file is there with the right size and its checksums matched
    // (whisper/dala_models.py). Recheck re-hashes every file; Download resumes, repairs or fetches it.

    var MODEL_NAMES = { small: 'Fast model', medium: 'Balanced model', 'large-v3': 'Best model' };

    function setModelRow(text, kind, getLabel) {
        if (!dom.modelState) return;
        dom.modelState.textContent = text;
        dom.modelState.className = 'cap-model-state' + (kind ? ' ' + kind : '');
        dom.modelGet.textContent = getLabel || 'DOWNLOAD';
        dom.modelGet.style.display = getLabel === null ? 'none' : '';
    }

    function describeModel(m) {
        var nm = MODEL_NAMES[m.name] || m.name, size = fmtBytes(m.total);
        if (m.state === 'ok') return [nm + ' ready (' + size + ')' + (m.checked === 'deep' ? ', every file verified.' : '.'), 'ok', null];
        if (m.state === 'missing') return [nm + ' not downloaded yet (' + size + '). It downloads on the first run, or now.', 'warn', 'DOWNLOAD'];
        if (m.state === 'incomplete') return [nm + ' download incomplete (' + fmtBytes(m.bytes) + ' of ' + size + '). Press Resume.', 'warn', 'RESUME'];
        return [nm + ' is damaged (' + m.files.filter(function (f) { return f.state !== 'ok'; }).map(function (f) { return f.name; }).join(', ') + '). Press Repair.', 'bad', 'REPAIR'];
    }

    /** Model state for the chosen accuracy; deep = re-hash every file (Recheck). */
    function updateModelRow(deep) {
        if (!dom.modelState || !S.python || S.busy) return;
        var args = [scriptPath('dala_models.py'), 'status', '--names', S.opts.model];
        if (deep) {
            args.push('--deep');
            setBusy(true);
            S.job = { cancelled: false };
            showProgress(0.2, 'Checking the ' + (MODEL_NAMES[S.opts.model] || 'model').toLowerCase() + ': every file and checksum…');
        } else setModelRow('Model: checking…', '', null);
        var child;
        try { child = N.cp.spawn(S.python, args, { windowsHide: true, env: engineSetup().pythonEnv() }); }
        catch (e) { if (deep) { setBusy(false); hideProgress(); } setModelRow('Model state unknown: ' + e.message, 'bad', 'DOWNLOAD'); return; }
        if (deep) S.job.child = child;
        var out = '';
        child.stdout.on('data', function (d) { out += String(d); });
        child.on('error', function () {});
        child.on('close', function () {
            if (deep) { var cancelled = S.job && S.job.cancelled; S.job = null; setBusy(false); hideProgress(); if (cancelled) return; }
            var m = out.match(/^OK (.*)$/m), list = null;
            try { list = m ? JSON.parse(m[1]) : null; } catch (eJ) { list = null; }
            if (!list || !list.length) { setModelRow('Model state unknown (the engine did not answer).', 'bad', 'DOWNLOAD'); return; }
            var d2 = describeModel(list[0]);
            setModelRow(d2[0], d2[1], d2[2]);
            if (deep) toast(d2[0], list[0].state === 'ok' ? 'success' : 'info');
        });
    }

    /** Downloads / resumes / repairs the chosen model (checksums verified before it counts as installed). */
    function downloadModel() {
        if (S.busy) return;
        checkEngine(function (err) {
            if (err) { toast('Install the speech engine first (button above).', 'error'); return; }
            setBusy(true);
            S.job = { cancelled: false };
            var job = S.job;
            showProgress(0.02, 'Preparing the download…');
            // runPython maps a download onto the first half of its range (recognition normally follows): 0.02 .. 1.98
            // makes this download-only run fill the whole bar
            runPython([scriptPath('dala_models.py'), 'download', S.opts.model], 'Downloading the speech model…', 0.02, 1.98, function (code, msg) {
                if (job.cancelled) return;
                S.job = null;
                setBusy(false);
                hideProgress();
                if (code !== 0) { toast('Download failed: ' + msg, 'error'); dom.lastNote.textContent = msg; updateModelRow(false); return; }
                toast((MODEL_NAMES[S.opts.model] || 'Model') + ' downloaded and verified.', 'success');
                S.engine = null;
                checkEngine(function () { updateModelRow(false); }, true);
            });
        });
    }

    // ------------------------------------------------------------------ language bar

    function labelFor(list, id) {
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
        return NAMES[id] || id;
    }

    function fromButtonText() {
        if (S.opts.from === 'auto' && S.detected) return NAMES[S.detected] + '<small>detected</small>';
        return labelFor(FROM, S.opts.from);
    }

    function renderDropdown(box, list, current, onPick, extraLabel) {
        var btnLabel = box.querySelector('.cap-dd-label'), menu = box.querySelector('.cap-dd-menu'), i;
        // the name in its own span so a narrow panel shortens it with "..." (the full name is the tooltip)
        var html = extraLabel || labelFor(list, current), cut = html.indexOf('<small>');
        btnLabel.innerHTML = '<span class="cap-dd-main">' + (cut < 0 ? html : html.slice(0, cut)) + '</span>' + (cut < 0 ? '' : html.slice(cut));
        box.querySelector('.cap-dd-btn').title = btnLabel.querySelector('.cap-dd-main').textContent;
        menu.innerHTML = '';
        for (i = 0; i < list.length; i++) {
            var it = list[i], b = document.createElement('button');
            b.type = 'button';
            b.className = 'cap-dd-item' + (it.id === current ? ' active' : '');
            b.setAttribute('data-id', it.id);
            b.innerHTML = '<svg class="cap-dd-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' +
                '<span></span>' + (it.sub ? '<span class="cap-dd-sub"></span>' : '');
            b.querySelector('span').textContent = it.label;
            if (it.sub) b.querySelector('.cap-dd-sub').textContent = it.sub;
            b.addEventListener('click', function (ev) {
                ev.stopPropagation();
                box.classList.remove('open');
                onPick(this.getAttribute('data-id'));
            });
            menu.appendChild(b);
        }
    }

    function renderLangBar() {
        renderDropdown(dom.from, FROM, S.opts.from, function (id) {
            if (S.busy) return;
            S.opts.from = id;
            if (id !== 'auto') S.detected = null;
            saveOpts(); renderLangBar(); invalidatePreview();
        }, fromButtonText());
        renderDropdown(dom.to, TO, S.opts.to, function (id) {
            if (S.busy) return;
            S.opts.to = id;
            saveOpts(); renderLangBar(); invalidatePreview(true);
        });
        dom.srcTitle.textContent = S.opts.from === 'auto' ? (S.detected ? NAMES[S.detected] : 'Spoken') : labelFor(FROM, S.opts.from);
        dom.outTitle.textContent = labelFor(TO, S.opts.to);
    }

    /** Swap, like Google Translate: the caption language becomes the spoken one and back. */
    function swapLanguages() {
        if (S.busy) return;
        var from = S.opts.from === 'auto' ? (S.detected || null) : S.opts.from;
        if (!from) { toast('Press Test audio first so the spoken language is known, or pick it in From.', 'info'); return; }
        var toMap = { ta: 'ta', en: 'en', hi: 'hinglish', tanglish: 'tanglish', hinglish: 'hinglish' };
        var newTo = toMap[from] || 'en';
        S.opts.from = S.opts.to;
        S.opts.to = newTo;
        S.detected = null;
        saveOpts(); renderLangBar(); invalidatePreview(true);
    }

    function toggleDropdown(box) {
        var open = box.classList.contains('open');
        dom.from.classList.remove('open'); dom.to.classList.remove('open');
        if (!open && !S.busy) box.classList.add('open');
    }

    // ------------------------------------------------------------------ panes

    function setSourcePane(text, meta) {
        dom.srcText.innerHTML = '';
        if (!text) {
            var ph = document.createElement('span');
            ph.className = 'cap-placeholder';
            ph.textContent = 'Select the dialogue layer or precomp, then press Test audio.';
            dom.srcText.appendChild(ph);
        } else {
            dom.srcText.textContent = text;
        }
        dom.srcMeta.textContent = meta || '';
    }

    function captionLine(c) { return c.lines.join(' '); }

    function showPlan(plan) {
        dom.outText.value = plan.captions.map(captionLine).join('\n');
        dom.outMeta.textContent = plan.captions.length + ' caption' + (plan.captions.length === 1 ? '' : 's');
        S.preview.shownText = dom.outText.value;
    }

    /** Language or option changes make the shown captions out of date. */
    function invalidatePreview(clearOutput) {
        if (S.preview) S.preview.stale = true;
        if (clearOutput) { dom.outText.value = ''; dom.outMeta.textContent = ''; }
    }

    // ------------------------------------------------------------------ progress / state

    function showProgress(f, label) {
        dom.progress.style.display = 'flex';
        if (f !== null && f !== undefined) dom.progressFill.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
        if (label) dom.progressLabel.textContent = label;
    }
    function hideProgress() { dom.progress.style.display = 'none'; }

    function setBusy(b) {
        S.busy = b;
        dom.idle.style.display = b ? 'none' : '';     // the progress bar takes the buttons' place
        dom.clear.disabled = b;
        dom.install.disabled = b;
        dom.swap.disabled = b;
        dom.outText.readOnly = b;
        refreshSync();
    }

    function fail(msg) {
        S.job = null;
        setBusy(false);
        hideProgress();
        toast(msg, 'error');
        dom.lastNote.textContent = msg;
    }

    // ------------------------------------------------------------------ run: audio -> words -> captions

    function tempDir() {
        var base = N.path.join(N.os.tmpdir(), 'CFXCaptions');
        try { if (!N.fs.existsSync(base)) N.fs.mkdirSync(base); } catch (e) {}
        try {
            var now = Date.now();
            N.fs.readdirSync(base).forEach(function (n) {
                var p = N.path.join(base, n);
                try {
                    if (now - N.fs.statSync(p).mtime.getTime() > 864e5) {
                        // fs.rmSync needs Node 14.14 (After Effects 2020 ships Node 8): Windows' own rmdir, in the background
                        if (N.fs.rmSync) N.fs.rmSync(p, { recursive: true, force: true });
                        else N.cp.execFile('cmd.exe', ['/d', '/c', 'rmdir', '/s', '/q', p], { windowsHide: true }, function () {});
                    }
                } catch (e2) {}
            });
        } catch (e3) {}
        var d = N.path.join(base, String(Date.now()));
        N.fs.mkdirSync(d);
        return d;
    }

    /** Same sound + same languages + same model = same words (After Effects stamps metadata into every
     *  render, so only the AIFF COMM + SSND chunks are hashed). */
    function audioKey(audioPath) {
        try {
            var crypto = req('crypto'), buf = N.fs.readFileSync(audioPath), md5 = crypto.createHash('md5');
            var p = 12, n = 0;
            if (buf.toString('ascii', 0, 4) === 'FORM') {
                while (p + 8 <= buf.length) {
                    var id = buf.toString('ascii', p, p + 4), size = buf.readUInt32BE(p + 4);
                    if (id === 'COMM' || id === 'SSND') { md5.update(buf.slice(p, Math.min(buf.length, p + 8 + size))); n++; }
                    p += 8 + size + (size & 1);
                }
            }
            if (!n) md5.update(buf);
            return [md5.digest('hex'), S.opts.from, S.opts.to, S.opts.model, S.opts.spoken ? 'spoken' : 'written'].join('|');
        } catch (e) { return null; }
    }

    function planKey() { return [S.opts.words, S.opts.punct].join('|'); }

    function makePlan(result, audio, fps) {
        var words = result.words || [];
        // the audio was rendered with context around the work area: keep the words spoken inside it
        if (audio.workStart !== undefined) {
            var lo = audio.workStart - audio.start, hi = audio.workEnd - audio.start;
            words = words.filter(function (w) { var m = (w.s + w.e) / 2; return m >= lo && m <= hi; });
        }
        var o = { fps: fps, uppercase: false, punctuation: S.opts.punct ? 'keep' : 'none', maxWords: S.opts.words };
        if (result.method === 'mt') {
            // translated a sentence at a time, its words timed over the phrases it translates (pauses kept): the
            // word order differs from the speech, so a caption may run a little longer than a spoken one
            o.maxDuration = 6;
            o.capsBreak = true;
        }
        return root.DalaCaptionPlanner.plan(words, o);
    }

    function sourceText(result, audio) {
        var segs = (result.source && result.source.segments) || [];
        if (audio.workStart !== undefined) {
            var lo = audio.workStart - audio.start, hi = audio.workEnd - audio.start;
            segs = segs.filter(function (g) { return g.e > lo && g.s < hi; });
        }
        return segs.map(function (g) { return g.text; }).join('\n');
    }

    /** start(build): Test audio (build = false) or Generate captions (build = true). */
    function start(build) {
        if (S.busy) return;
        if (!nodeOk()) { toast('Node.js is not available in this panel; restart After Effects.', 'error'); return; }
        var edited = build && S.preview && !S.preview.stale && dom.outText.value !== S.preview.shownText ? dom.outText.value : null;
        setBusy(true);
        showProgress(0.01, 'Checking the speech engine…');
        checkEngine(function (err, engine) {
            if (err) {
                setBusy(false); hideProgress(); refreshEngine(true);
                toast(err === 'engine-missing' ? 'Install the speech engine first (button above).' :
                    err === 'no-node' ? 'Restart After Effects: this panel cannot start its speech engine.' :
                    err === 'unsupported' ? 'Auto Captions runs on Windows for now.' :
                    'The speech engine needs a repair (button above).', 'error');
                return;
            }
            host('info', undefined, function (res) {
                if (!res.success || !res.data || !res.data.hasComp) { fail('Open the composition you want to caption first.'); return; }
                var I = res.data;
                if (!I.audioLayers) { fail('This comp has no audio in its work area. Add the dialogue clip or precomp (audio on).'); return; }
                var job = { dir: tempDir(), cancelled: false, info: I, t0: Date.now(), build: build, engine: engine };
                S.job = job;
                var sel = S.opts.selOnly ? (I.selectedAudio || []) : [];
                var what = sel.length ? sel.map(function (x) { return x.name + (x.precomp ? ' (precomp)' : ''); }).join(', ') : 'the comp';
                showProgress(0.03, 'Rendering the audio of ' + what + '…');
                host('renderAudio', { out: job.dir.replace(/\\/g, '/') + '/audio.aif', selectedOnly: sel.length > 0 }, function (r2) {
                    if (job.cancelled) return;
                    if (!r2.success) { fail(r2.message); return; }
                    job.audio = r2.data;
                    job.what = what;
                    job.key = audioKey(job.audio.path);
                    if (job.key && S.preview && S.preview.key === job.key) {
                        // same audio and languages as the last run: no need to listen again
                        job.result = S.preview.result;
                        afterRecognition(job, edited);
                        return;
                    }
                    recognise(job);
                });
            });
        });
    }

    function recognise(job) {
        var out = N.path.join(job.dir, 'words.json'), engine = job.engine;
        var args = [scriptPath(), '--audio', job.audio.path, '--out', out, '--model', S.opts.model,
            '--source', S.opts.from, '--target', S.opts.to,
            '--device', (S.opts.gpu && engine.gpu && engine.gpu.devices > 0 && engine.gpu.cublas) ? 'auto' : 'cpu',
            '--duration', String(job.audio.duration), '--spoken', S.opts.spoken ? '1' : '0'];
        showProgress(0.06, 'Loading the speech model…');
        runPython(args, 'Downloading the speech model…', 0.06, 0.9, function (code, msg, device) {
            if (job.cancelled) return;
            if (code === 3) { setupTranslator(job); return; }
            if (code !== 0) {
                fail('Recognition failed: ' + msg + (/load the speech model|model\.bin|corrupt|Unable to open/i.test(msg) ? ' The model files may be damaged: open Options and press Recheck.' : ''));
                updateModelRow(false);
                return;
            }
            var data;
            try { data = JSON.parse(N.fs.readFileSync(out, 'utf8')); } catch (e) { fail('Could not read the transcript.'); return; }
            job.result = data;
            afterRecognition(job, null);
        });
    }

    /** One-time setup of the offline translator, then recognition again. */
    function setupTranslator(job) {
        showProgress(0.1, 'Downloading the translator (one time, about 3 GB)…');
        runPython([scriptPath('dala_setup_mt.py')], 'Downloading the translation model…', 0.1, 0.6, function (code, msg) {
            if (job.cancelled) return;
            if (code !== 0) { fail('Translator setup failed: ' + msg); return; }
            S.engine = null;
            checkEngine(function (err, eng) {
                if (eng) job.engine = eng;
                recognise(job);
            }, true);
        });
    }

    function afterRecognition(job, edited) {
        var r = job.result, A = job.audio, fps = job.info.fps || 30;
        var src = r.source || {};
        S.detected = S.opts.from === 'auto' ? (src.shown || src.lang || null) : null;
        renderLangBar();
        var srcMeta = (src.label || NAMES[src.lang] || '') + (src.detected ? ' - detected' : '');
        setSourcePane(sourceText(r, A), srcMeta);
        var reuse = S.preview && S.preview.key === job.key && S.preview.planKey === planKey() && S.preview.plan;
        var plan = reuse ? S.preview.plan : makePlan(r, A, fps);
        S.preview = { key: job.key, result: r, audio: A, info: job.info, plan: plan, planKey: planKey(), stale: false };
        // other audio heard: edits in the box no longer belong to the captions built before
        if (S.built && S.built.audioKey !== job.key) S.built = null;
        if (!plan.captions.length) { fail('No speech was found in the work area. Select the dialogue layer or precomp (music confuses the recogniser) and try again.'); return; }
        if (edited !== null && edited !== undefined && reuse) {
            dom.outText.value = edited;
            S.preview.shownText = plan.captions.map(captionLine).join('\n');
            dom.outMeta.textContent = plan.captions.length + ' captions';
        } else {
            if (edited) toast('The options changed, so the caption lines were made again (your edits were not kept).', 'info');
            showPlan(plan);
        }
        if (!job.build) {
            S.job = null;
            setBusy(false);
            hideProgress();
            var secs = Math.round((Date.now() - job.t0) / 1000);
            dom.lastNote.textContent = 'Heard ' + (srcMeta || 'speech') + ' in ' + job.what + ' (' + secs + ' s). Edit the lines if needed, then Generate captions.';
            return;
        }
        buildLayers(job);
    }

    /** The captions as the box shows them: one per non-empty line, any number of lines and words, each timed
     *  from the words it shares with the speech (captionPlanner.fromText). ref: the timed words to match. */
    function boxCaptions(ref, audio) {
        return root.DalaCaptionPlanner.fromText(dom.outText.value, { captions: [{ words: ref }] }, { total: audio.duration });
    }
    function planWords(plan) {
        var out = [];
        (plan.captions || []).forEach(function (c) { (c.words || []).forEach(function (w) { out.push(w); }); });
        return out;
    }
    function boxText(caps) { return caps.map(captionLine).join('\n'); }
    /** The box text as captions see it: lines trimmed, spaces collapsed, empty lines gone. */
    function sameText(t) { return String(t || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean).join('\n'); }

    /** Writes the plan and asks the host to build B's captions: update = { gen, ids } rebuilds those of an
     *  earlier build (ids: only these; null: all of them); renumber = { oldId: newId } (a caption was inserted). */
    function hostBuild(B, caps, update, cb, renumber) {
        var assign = null;
        if (B.style.kind === 'family') {
            var fam = loadFamily(B.style);
            if (!fam) { cb({ success: false, message: 'The caption style "' + B.style.name + '" could not be read. Reinstall CFX Suite.' }); return; }
            assign = root.DalaCaptionDirector.direct(caps, fam, { mode: B.styleMode });
        }
        try { if (!B.dir || !N.fs.existsSync(B.dir)) B.dir = tempDir(); } catch (eD) { B.dir = tempDir(); }
        var planPath = N.path.join(B.dir, 'plan.json');
        try { N.fs.writeFileSync(planPath, JSON.stringify(assign ? { captions: caps, assign: assign } : { captions: caps })); }
        catch (e) { cb({ success: false, message: 'Could not write the caption plan: ' + e.message }); return; }
        var A = B.audio;
        host('build', {
            planPath: planPath.replace(/\\/g, '/'), target: B.target, gen: B.gen, update: update || undefined, renumber: renumber || undefined,
            templatePath: extRoot() + '/captions/styles/dala-default.json',
            familyPath: B.style.kind === 'family' ? (B.style.custom ? B.style.path.replace(/\\/g, '/') : extRoot() + '/captions/styles/' + B.style.file) : undefined,
            offset: A.start, workStart: A.workStart, workEnd: A.workEnd, compId: A.compId, replace: B.replace,
            position: B.position, sizeScale: B.size / 100, scriptFonts: SCRIPT_FONTS[B.target] || null
        }, cb);
    }

    function captionKey(c) { return c.s + '|' + c.e + '|' + c.lines.join('\n'); }

    // ------------------------------------------------------------------ build records
    // Every build is kept as a small record (its timed words, the speech regions, its captions and options) in
    // %APPDATA%\DalaSuite\captions\<gen>.json, so its layers can still be edited or get a caption inserted after
    // the panel or After Effects restarts: the layers carry the build's tag "#gen:id".

    function recordDir() {
        var proc = root.process || req('process'), env = (proc && proc.env) || {};
        return N.path.join(env.APPDATA || N.path.join(N.os.homedir(), 'AppData', 'Roaming'), 'DalaSuite', 'captions');
    }
    function saveRecord(B) {
        try {
            var dir = recordDir();
            if (!N.fs.existsSync(N.path.dirname(dir))) N.fs.mkdirSync(N.path.dirname(dir));
            if (!N.fs.existsSync(dir)) N.fs.mkdirSync(dir);
            B.text = boxText(B.caps);
            var keep = {}, k;
            for (k in B) if (B.hasOwnProperty(k) && k !== 'dir') keep[k] = B[k];
            N.fs.writeFileSync(N.path.join(dir, B.gen + '.json'), JSON.stringify(keep));
            // the newest 300 builds are kept
            var all = N.fs.readdirSync(dir).filter(function (n) { return /^\d+\.json$/.test(n); }).sort();
            for (k = 0; k < all.length - 300; k++) { try { N.fs.unlinkSync(N.path.join(dir, all[k])); } catch (eU) {} }
        } catch (e) {}
    }
    function loadRecord(gen) {
        try { return JSON.parse(N.fs.readFileSync(N.path.join(recordDir(), gen + '.json'), 'utf8')); } catch (e) { return null; }
    }

    function buildLayers(job) {
        var ref = planWords(S.preview.plan), caps = boxCaptions(ref, job.audio);
        if (!caps.length) { fail('All caption lines are empty.'); return; }
        var st = currentStyle();
        // what the build needs again when the lines are edited afterwards (this build's options, not later ones)
        var B = { gen: String(Date.now()), dir: job.dir, audio: job.audio, style: st, styleMode: S.opts.styleMode, target: S.opts.to,
            replace: S.opts.replace, position: S.opts.position, size: S.opts.size, caps: caps, audioKey: S.preview.key,
            ref: ref, speech: (job.result && job.result.speech) || [] };
        showProgress(0.92, 'Creating ' + caps.length + ' captions in ' + st.name + '…');
        hostBuild(B, caps, null, function (res) {
            S.job = null;
            setBusy(false);
            hideProgress();
            if (!res.success) { toast(res.message, 'error'); dom.lastNote.textContent = res.message; return; }
            S.built = B;
            saveRecord(B);
            B.text = dom.outText.value;
            refreshSync();
            dom.outMeta.textContent = caps.length + ' caption' + (caps.length === 1 ? '' : 's');
            var secs = Math.round((Date.now() - job.t0) / 1000);
            var dev = job.result.device === 'cuda' ? 'GPU' : 'CPU';
            var warn = (res.data && res.data.warnings && res.data.warnings.length) ? ' ' + res.data.warnings.join(' ') : '';
            dom.lastNote.textContent = res.message + ' ' + (NAMES[job.result.source && job.result.source.shown] || '') + ' → ' + NAMES[S.opts.to] + ' · ' + secs + ' s · ' + dev + warn +
                (S.opts.sync === 'manual' ? ' Edit the lines in the box, then press UPDATE.' : ' Edit the lines in the box and the layers follow.');
            toast(res.message, 'success');
        });
    }

    // ------------------------------------------------------------------ edits after Generate

    // Once captions are built, editing the box updates them in the comp: Auto - a moment after typing stops;
    // Manual - when UPDATE is pressed. A line whose words or timing changed is rebuilt in place; lines added,
    // removed, split or joined rebuild the captions of that build.
    var syncTimer = null;
    function scheduleSync() {
        refreshSync();
        if (!S.built || S.opts.sync === 'manual') return;
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(function () { syncTimer = null; syncLayers(); }, 900);
    }

    /** The Auto / Manual switch and the UPDATE button (shown in Manual; enabled while the box differs from the
     *  built captions). */
    function refreshSync() {
        if (!dom.syncMode) return;
        Array.prototype.forEach.call(dom.syncMode.querySelectorAll('[data-sync]'), function (b) { b.classList.toggle('active', b.getAttribute('data-sync') === S.opts.sync); });
        var manual = S.opts.sync === 'manual', B = S.built;
        dom.update.hidden = !manual;
        var pending = !!(B && sameText(dom.outText.value) !== sameText(B.text));
        dom.update.disabled = !pending || S.syncing || S.busy;
        if (manual && B && !S.syncing) dom.outMeta.textContent = pending ? 'edited · press UPDATE' : B.caps.length + ' caption' + (B.caps.length === 1 ? '' : 's');
    }

    /** ids to rebuild when the captions went from old to now (null: all of them). A caption whose timing moved
     *  also changes the one before it (its layer runs to this one's start) and the one after (its reveal waits
     *  for this one's sweep-out). */
    function changedIds(old, now) {
        if (old.length !== now.length) return null;
        var mark = {}, ids = [], i;
        for (i = 0; i < now.length; i++) {
            if (captionKey(old[i]) === captionKey(now[i])) continue;
            mark[i] = 1;
            if (old[i].s !== now[i].s || old[i].e !== now[i].e) { if (i > 0) mark[i - 1] = 1; if (i + 1 < now.length) mark[i + 1] = 1; }
        }
        for (i = 0; i < now.length; i++) if (mark[i]) ids.push(now[i].id);
        return ids;
    }

    function syncLayers() {
        var B = S.built;
        if (!B) return;
        if (S.busy || S.syncing) { S.syncAgain = true; return; }
        var text = dom.outText.value.replace(/\r/g, '');
        var caps = boxCaptions(B.ref, B.audio);
        if (!caps.length) return;                                // an emptied box leaves the layers alone
        var ids = changedIds(B.caps, caps);
        if (ids && !ids.length) { B.text = text; refreshSync(); return; }
        S.syncing = true;
        S.syncAgain = false;
        refreshSync();
        dom.outMeta.textContent = 'Updating the layers…';
        hostBuild(B, caps, { gen: B.gen, ids: ids }, function (res) {
            S.syncing = false;
            if (res.success) {
                B.caps = caps;
                saveRecord(B);
                B.text = text;                                   // what was typed (saveRecord keeps the lines)
                dom.outMeta.textContent = caps.length + ' caption' + (caps.length === 1 ? '' : 's') + ' · layers updated';
                dom.lastNote.textContent = res.message.replace(/\.$/, '') + ' from your edit.';
            } else {
                dom.outMeta.textContent = caps.length + ' caption' + (caps.length === 1 ? '' : 's');
                dom.lastNote.textContent = 'The layers were not updated: ' + res.message;
                if (/Open the composition|missing/i.test(res.message)) S.built = null;
            }
            refreshSync();
            if (S.syncAgain) { S.syncAgain = false; if (S.opts.sync === 'manual') refreshSync(); else scheduleSync(); }
        });
    }

    // ------------------------------------------------------------------ insert a caption
    // CHECK TIMELINE reads the time indicator and the Dala captions of the active comp, finds the build they belong
    // to (this session's, or its saved record) and where a new caption fits: after the speech of the caption before
    // the time indicator, on the next voice the recogniser heard (its speech regions) or at the time indicator.
    // ADD NEW LAYER asks for the text; UPDATE inserts it there, timed to that voice (or to its length when nothing
    // is spoken there), numbers the later captions up and rebuilds the captions on both sides so they fit around it.

    function fmtT(t) { return (Math.round(t * 100) / 100).toFixed(2) + ' s'; }
    function insState(msg) { dom.insState.textContent = msg; }
    function insReset(msg) {
        S.insert = null;
        dom.insAdd.disabled = true;
        dom.insEdit.style.display = 'none';
        if (msg) insState(msg);
    }

    function checkTimeline() {
        if (S.busy || S.syncing) return;
        if (!nodeOk()) { insState('Restart After Effects: this panel cannot read its caption records.'); return; }
        insReset('Checking the timeline…');
        host('timeline', undefined, function (res) {
            if (!res.success) { insReset(res.message); return; }
            var T = res.data, gens = {}, best = null, i;
            T.captions.forEach(function (c) { if (c.gen) gens[c.gen] = (gens[c.gen] || 0) + 1; });
            if (!T.captions.length) { insReset('No Dala captions in "' + T.compName + '": generate captions first.'); return; }
            // the build to insert into: this session's build when it is in this comp, otherwise the one most layers belong to
            if (S.built && gens[S.built.gen] && S.built.audio.compId === T.compId) best = S.built.gen;
            for (var g in gens) if (gens.hasOwnProperty(g) && (!best || gens[g] > gens[best])) best = g;
            if (!best) { insReset('These captions were made by an older CFX Suite: generate them again to insert captions.'); return; }
            var B = (S.built && S.built.gen === best) ? S.built : loadRecord(best);
            if (!B || !B.ref) { insReset('The record of these captions is missing on this PC: generate them again to insert captions.'); return; }
            if (S.built !== B) {
                // a build from an earlier session: its lines come back into the box, edits and inserts work on it again
                if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
                S.built = B;
                dom.outText.value = B.text || boxText(B.caps);
                dom.outMeta.textContent = B.caps.length + ' caption' + (B.caps.length === 1 ? '' : 's');
            }
            refreshSync();
            var ta = T.time - B.audio.start, caps = B.caps, prev = null, next = null, pi = -1;
            for (i = 0; i < caps.length; i++) { if (caps[i].s <= ta) { prev = caps[i]; pi = i; } else { next = caps[i]; break; } }
            var lo = B.audio.workStart - B.audio.start, hi = B.audio.workEnd - B.audio.start;
            if (ta < lo - 0.01 || ta > hi + 0.01) { insReset('The time indicator (' + fmtT(T.time) + ') is outside the audio these captions were made from (' + fmtT(B.audio.workStart) + ' - ' + fmtT(B.audio.workEnd) + ').'); return; }
            // the new caption starts after the speech of the caption before it, on the voice at / after the time indicator
            var s = Math.max(ta, prev ? prev.e + 0.05 : lo), limit = next ? next.s : hi, sp = B.speech || [], region = null;
            for (i = 0; i < sp.length; i++) {
                if (sp[i][1] <= s + 0.05) continue;
                if (sp[i][0] <= s) { if (s - sp[i][0] < 0.4 && sp[i][0] >= (prev ? prev.e : lo)) s = sp[i][0]; region = sp[i]; break; }
                if (sp[i][0] - s <= 0.6 && sp[i][0] < limit - 0.3) { s = sp[i][0]; region = sp[i]; }
                break;
            }
            if (limit - s < 0.3) {
                insReset('No room at ' + fmtT(T.time) + ': ' + (next ? nameOf(next) + ' is spoken right after ' + (prev ? nameOf(prev) : 'it') : 'the audio ends here') + '. Move the time indicator to a pause, or edit that line in the box.');
                return;
            }
            // how far the voice there goes (regions with short gaps joined), never into the next caption's speech
            var vEnd = null;
            if (region) {
                vEnd = region[1];
                for (i = 0; i < sp.length; i++) if (sp[i][0] > vEnd && sp[i][0] - vEnd < 0.3) vEnd = sp[i][1];
                vEnd = Math.min(vEnd, limit - 0.05);
            }
            S.insert = { gen: B.gen, compId: T.compId, at: pi + 1, s: s, limit: limit, vEnd: vEnd };
            dom.insAdd.disabled = false;
            var where = prev && next ? 'between ' + nameOf(prev) + ' and ' + nameOf(next) : (prev ? 'after ' + nameOf(prev) : 'before ' + nameOf(next));
            insState('Time indicator ' + fmtT(T.time) + ': the new caption goes ' + where + ', starting at ' + fmtT(s + B.audio.start) +
                (vEnd !== null ? ' on the voice heard until ' + fmtT(vEnd + B.audio.start) + '.' : ' (no voice there: it is timed to its length).') + ' Press Add new layer.');
        });
    }
    function nameOf(c) { var t = captionLine(c); return 'CAP ' + c.id + ' "' + (t.length > 22 ? t.substring(0, 21) + '…' : t) + '"'; }

    function addNewLayer() {
        if (!S.insert) return;
        dom.insEdit.style.display = '';
        dom.insText.value = '';
        dom.insText.focus();
    }

    function insertCaption() {
        var I = S.insert, B = S.built;
        if (!I || !B || B.gen !== I.gen) { insReset('Press Check timeline again.'); return; }
        if (S.busy || S.syncing) return;
        var text = dom.insText.value.replace(/\s+/g, ' ').trim();
        if (!text) { insState('Type the new caption first.'); dom.insText.focus(); return; }
        var P = root.DalaCaptionPlanner, words = text.split(' ');
        var e = I.vEnd !== null ? Math.max(I.vEnd, I.s + 0.4) : I.s + Math.max(0.8, 0.32 * words.length);
        e = Math.min(e, I.limit - 0.05);
        if (e < I.s + 0.2) e = I.s + 0.2;
        // its words, timed over its span by length: they join the build's timed words, so later edits keep it here
        var len = 0, acc = 0, timed = [];
        words.forEach(function (w) { len += w.length + 1; });
        words.forEach(function (w) { var a = I.s + (e - I.s) * acc / len; acc += w.length + 1; timed.push({ w: w, s: Math.round(a * 1000) / 1000, e: Math.round((I.s + (e - I.s) * acc / len) * 1000) / 1000 }); });
        var ref = B.ref.concat(timed).sort(function (a, b) { return a.s - b.s; });
        var caps = B.caps.slice(), at = I.at, renumber = {}, i;
        caps.splice(at, 0, { id: '', s: Math.round(I.s * 1000) / 1000, e: Math.round(e * 1000) / 1000, lines: P.relineText(text, {}), words: timed });
        for (i = 0; i < caps.length; i++) {
            var nid = (i + 1 < 10 ? '0' : '') + (i + 1);
            if (caps[i].id && caps[i].id !== nid) renumber[caps[i].id] = nid;
            caps[i] = { id: nid, s: caps[i].s, e: caps[i].e, lines: caps[i].lines, words: caps[i].words };
        }
        var ids = [caps[at].id];
        if (at > 0) ids.unshift(caps[at - 1].id);
        if (at + 1 < caps.length) ids.push(caps[at + 1].id);
        S.syncing = true;
        refreshSync();
        insState('Inserting the caption…');
        dom.insUpdate.disabled = true;
        hostBuild(B, caps, { gen: B.gen, ids: ids }, function (res) {
            S.syncing = false;
            dom.insUpdate.disabled = false;
            if (!res.success) { insState('Not inserted: ' + res.message); refreshSync(); return; }
            B.ref = ref;
            B.caps = caps;
            saveRecord(B);
            dom.outText.value = B.text;
            dom.outMeta.textContent = caps.length + ' caption' + (caps.length === 1 ? '' : 's') + ' · layers updated';
            refreshSync();
            var nm = 'CAP ' + caps[at].id;
            insReset('Inserted ' + nm + ' at ' + fmtT(caps[at].s + B.audio.start) + (ids.length > 1 ? '; ' + ids.filter(function (x) { return x !== caps[at].id; }).map(function (x) { return 'CAP ' + x; }).join(' and ') + ' adjusted around it.' : '.'));
            toast(nm + ' inserted.', 'success');
        }, renumber);
    }

    function cancelJob() {
        var job = S.job;
        if (!job) return;
        if (job.setup) { job.setup.cancel(); return; }     // the install's own callback restores the panel
        setTimeout(function () { updateModelRow(false); }, 800);   // e.g. a cancelled model download: offer Resume
        job.cancelled = true;
        try { if (job.child) job.child.kill(); } catch (e) {}
        S.job = null;
        setBusy(false);
        hideProgress();
        if (!job.pip) toast('Cancelled.', 'info');
    }

    function clearLayers() {
        if (S.busy) return;
        host('removeCaptions', undefined, function (res) {
            if (res.success) { S.built = null; refreshSync(); insReset('Move the time indicator to where the new caption goes, then press Check timeline.'); }
            toast(res.message, res.success ? 'success' : 'info');
            dom.lastNote.textContent = res.message;
        });
    }

    // ------------------------------------------------------------------ caption style (CAPTION STYLE tab)
    // captions/styles/index.json lists the styles: Woodl Style (one text layer per caption) and the style
    // families made from the user's txt pjf 1.aep (tools/make_caption_styles.py), whose looks the director
    // (captionDirector.js) picks line by line. Previews are animated WebP (MP4 does not play in every panel).

    var WOODL = { id: 'woodl', name: 'Woodl Style', kind: 'single', file: 'dala-default.json', about: 'The original Dala caption: one clean line, revealed as it is spoken',
        preview: 'previews/woodl.webp', thumb: 'previews/woodl-thumb.webp' };
    var VENDOR_NOTE = { 'Deep Glow': 'Deep Glow is replaced by After Effects’ own Glow' };

    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function styleList() {
        if (S.styles) return S.styles;
        var list = null;
        if (nodeOk()) { try { list = JSON.parse(N.fs.readFileSync(extRoot() + '/captions/styles/index.json', 'utf8')).styles; } catch (e) { list = null; } }
        if (!list) {
            try { var x = new XMLHttpRequest(); x.open('GET', '../captions/styles/index.json', false); x.send(); if (x.status === 200 || x.status === 0) list = JSON.parse(x.responseText).styles; } catch (e2) {}
        }
        S.styles = ((list && list.length) ? list : [WOODL]).concat(root.DalaCustomStyles ? root.DalaCustomStyles.list() : []);
        return S.styles;
    }
    function currentStyle() { var l = styleList(), i; for (i = 0; i < l.length; i++) if (l[i].id === S.opts.style) return l[i]; return l[0]; }
    function loadFamily(st) {
        if (S.families[st.id]) return S.families[st.id];
        var fam = null;
        try { fam = JSON.parse(N.fs.readFileSync(st.custom ? st.path : extRoot() + '/captions/styles/' + st.file, 'utf8')); } catch (e) { fam = null; }
        if (fam && fam.styles && fam.styles.length) S.families[st.id] = fam;
        return S.families[st.id] || null;
    }
    function assetUrl(rel) { return '../captions/' + rel; }     // relative to client/index.html

    function showPreview(st) {
        dom.styleChip.textContent = st.name;
        dom.styleAbout.textContent = st.about || '';
        dom.stylePreview.classList.remove('noimg');
        var C = root.DalaCustomStyles;
        if (st.custom) {
            // a custom style's preview is a flip-book of the frames rendered when it was made
            if (dom.styleAnim.getAttribute('data-src') !== st.id && C) { dom.styleAnim.setAttribute('data-src', st.id); C.play(dom.styleAnim, st, dom.styleBar); }
            return;
        }
        if (C) C.stop(dom.styleAnim);
        var src = assetUrl(st.preview);
        if (dom.styleAnim.getAttribute('data-src') !== src) {
            dom.styleAnim.setAttribute('data-src', src);
            dom.styleAnim.src = src + '?v=' + Date.now();              // a fresh load starts the animation over
            var bar = dom.styleBar;
            bar.style.animation = 'none';
            void bar.offsetWidth;
            bar.style.animation = 'capStyleBar ' + (st.seconds || 6) + 's linear infinite';
        }
    }

    function renderStyles() {
        var list = styleList(), cur = currentStyle(), i;
        dom.styleGrid.innerHTML = '';
        for (i = 0; i < list.length; i++) (function (st) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'cap-style-card' + (st.id === cur.id ? ' selected' : '');
            b.title = (st.about || st.name) + (st.kind === 'family' ? ' (' + st.styles.length + (st.styles.length === 1 ? ' look)' : ' looks)') : '');
            b.innerHTML = '<span class="cap-style-thumb"><img alt="" src="' + esc(st.custom ? st.thumbUrl : assetUrl(st.thumb)) + '"><span class="cap-style-thumb-text">' + esc(st.name) + '</span>' +
                (st.custom ? '<span class="cap-style-custom">CUSTOM</span>' : '') +
                (st.kind === 'family' ? '<span class="cap-style-count">' + st.styles.length + (st.styles.length === 1 ? ' look' : ' looks') + '</span>' : '') + '</span>' +
                '<span class="cap-style-name">' + esc(st.name) + '</span>' +
                '<span class="cap-style-check"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>';
            var img = b.querySelector('img');
            img.addEventListener('error', function () { b.querySelector('.cap-style-thumb').classList.add('noimg'); });
            b.addEventListener('click', function () { S.opts.style = st.id; saveOpts(); renderStyles(); toast(st.name + ' will be used for the captions.', 'info'); });
            b.addEventListener('mouseenter', function () { showPreview(st); });
            b.addEventListener('mouseleave', function () { showPreview(currentStyle()); });
            dom.styleGrid.appendChild(b);
        })(list[i]);
        showPreview(cur);
        dom.pickName.textContent = cur.name;
        dom.familyOpts.style.display = cur.kind === 'family' ? '' : 'none';
        var mb = dom.styleMode.querySelectorAll('[data-stylemode]');
        for (i = 0; i < mb.length; i++) mb[i].classList.toggle('active', mb[i].getAttribute('data-stylemode') === S.opts.styleMode);
        checkStyleNeeds(cur);
    }

    /** What the style needs that this PC lacks: plug-ins (their effects are left out or replaced) and fonts. */
    function checkStyleNeeds(st) {
        var fx = [], vendors = [], v, i;
        for (v in (st.needs || {})) if (st.needs.hasOwnProperty(v)) { vendors.push(v); for (i = 0; i < st.needs[v].length; i++) fx.push(st.needs[v][i]); }
        dom.styleNote.textContent = '';
        if (!fx.length && !(st.fonts || []).length) return;
        host('styleCheck', { effects: fx, fonts: st.fonts || [] }, function (res) {
            if (!res.success || currentStyle().id !== st.id) return;
            var miss = res.data.missingEffects || [], gone = [], swaps = [], k;
            for (k = 0; k < vendors.length; k++) {
                var lost = false;
                for (i = 0; i < st.needs[vendors[k]].length; i++) if (miss.indexOf(st.needs[vendors[k]][i]) >= 0) lost = true;
                if (lost) { if (VENDOR_NOTE[vendors[k]]) swaps.push(VENDOR_NOTE[vendors[k]]); else gone.push(vendors[k]); }
            }
            var parts = [];
            if (gone.length) parts.push(gone.join(', ') + (gone.length === 1 ? ' is' : ' are') + ' not installed: those effects are left out (the rest of the look stays).');
            if (swaps.length) parts.push(swaps.join('; ') + '.');
            if (res.data.missingFonts && res.data.missingFonts.length) parts.push('Install these fonts for the exact look: ' + res.data.missingFonts.join(', ') + '.');
            dom.styleNote.textContent = parts.length ? 'On this PC: ' + parts.join(' ') : 'Everything this style uses is installed on this PC.';
        });
    }

    function showTab(which) {
        var tb = dom.tabs.querySelectorAll('[data-captab]'), i;
        for (i = 0; i < tb.length; i++) tb[i].classList.toggle('active', tb[i].getAttribute('data-captab') === which);
        dom.tabText.style.display = which === 'text' ? '' : 'none';
        dom.tabStyle.style.display = which === 'style' ? '' : 'none';
        dom.tabCustom.style.display = which === 'custom' ? '' : 'none';
        if (which === 'style') renderStyles();
        else if (root.DalaCustomStyles) root.DalaCustomStyles.stop(dom.styleAnim);
        if (which === 'custom' && root.DalaCustomStyles) root.DalaCustomStyles.onShow();
    }

    /** Custom styles were saved, renamed or deleted: the style list is read again (selectId: pick that style). */
    function stylesChanged(selectId) {
        S.styles = null;
        S.families = {};
        dom.styleAnim.removeAttribute('data-src');
        if (selectId) { S.opts.style = selectId; saveOpts(); }
        dom.pickName.textContent = currentStyle().name;
        if (dom.tabStyle.style.display !== 'none') renderStyles();
    }

    // ------------------------------------------------------------------ options

    function bindGroup(id, attr, key, after) {
        var box = $(id), btns = box.querySelectorAll('[data-' + attr + ']'), i;
        function sync() { for (var j = 0; j < btns.length; j++) btns[j].classList.toggle('active', btns[j].getAttribute('data-' + attr) === String(S.opts[key])); }
        for (i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', function () { S.opts[key] = this.getAttribute('data-' + attr); sync(); saveOpts(); if (after) after(); });
        }
        sync();
    }
    function bindToggle(id, key, after) {
        var el = $(id);
        el.checked = !!S.opts[key];
        el.addEventListener('change', function () { S.opts[key] = el.checked; saveOpts(); if (after) after(); });
    }
    function bindSlider(id, valId, key, fmt, after) {
        var el = $(id), v = $(valId);
        el.value = S.opts[key];
        v.textContent = fmt(S.opts[key]);
        el.addEventListener('input', function () { S.opts[key] = +el.value; v.textContent = fmt(S.opts[key]); });
        el.addEventListener('change', function () { saveOpts(); if (after) after(); });
    }

    /** Words-per-caption / punctuation changes: make the lines again from the same recognition. */
    function replanFromPreview() {
        if (!S.preview || S.preview.stale || !S.preview.result) return;
        S.preview.plan = makePlan(S.preview.result, S.preview.audio, S.preview.info.fps || 30);
        S.preview.planKey = planKey();
        showPlan(S.preview.plan);
    }

    function on(el, evt, fn) {
        if (el) el.addEventListener(evt, fn);
    }

    // ------------------------------------------------------------------ init

    function init() {
        try {
            _init();
        } catch (err) {
            console.error("CFXCaptionsUI init failed:", err);
            if (window.CFXToast) window.CFXToast("Captions UI Init: " + (err.message || err), "bad");
        }
    }

    function _init() {
        dom.card = $('cap-card');
        if (!dom.card) return;
        try { cs = new root.CSInterface(); } catch (e) { cs = null; }
        nodeOk();
        loadOpts();
        dom.engine = $('cap-engine'); dom.setup = $('cap-setup'); dom.setupText = $('cap-setup-text'); dom.install = $('cap-install');
        dom.from = $('cap-from'); dom.to = $('cap-to'); dom.swap = $('cap-swap');
        dom.srcTitle = $('cap-src-title'); dom.srcMeta = $('cap-src-meta'); dom.srcText = $('cap-src-text');
        dom.outTitle = $('cap-out-title'); dom.outMeta = $('cap-out-meta'); dom.outText = $('cap-out-text');
        on(dom.outText, 'input', scheduleSync);
        on(dom.outText, 'blur', function () { if (syncTimer && S.opts.sync !== 'manual') { clearTimeout(syncTimer); syncTimer = null; syncLayers(); } });
        // Layers: Auto (edits apply as you type) / Manual (edits wait for UPDATE)
        dom.syncMode = $('cap-sync-mode'); dom.update = $('cap-update') || $('cap-sync-update');
        if (dom.syncMode) {
            Array.prototype.forEach.call(dom.syncMode.querySelectorAll('[data-sync]'), function (b) {
                on(b, 'click', function () {
                    S.opts.sync = b.getAttribute('data-sync');
                    saveOpts();
                    if (S.opts.sync === 'manual' && syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
                    refreshSync();
                    if (S.opts.sync === 'auto') scheduleSync();
                });
            });
        }
        on(dom.update, 'click', function () { if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; } syncLayers(); });
        // Insert a caption
        dom.insAdd = $('cap-ins-add'); dom.insState = $('cap-ins-state'); dom.insEdit = $('cap-ins-edit'); dom.insText = $('cap-ins-text'); dom.insUpdate = $('cap-ins-update');
        on($('cap-ins-check'), 'click', checkTimeline);
        on(dom.insAdd, 'click', addNewLayer);
        on(dom.insUpdate, 'click', insertCaption);
        on($('cap-ins-cancel'), 'click', function () { if (dom.insEdit) dom.insEdit.style.display = 'none'; });
        dom.idle = $('cap-idle'); dom.clear = $('cap-clear'); dom.lastNote = $('cap-last-note');
        dom.progress = $('cap-progress'); dom.progressFill = $('cap-progress-fill'); dom.progressLabel = $('cap-progress-label');

        renderLangBar();
        if (dom.from) {
            var btnFrom = dom.from.querySelector('.cap-dd-btn');
            on(btnFrom, 'click', function (ev) { ev.stopPropagation(); toggleDropdown(dom.from); });
        }
        if (dom.to) {
            var btnTo = dom.to.querySelector('.cap-dd-btn');
            on(btnTo, 'click', function (ev) { ev.stopPropagation(); toggleDropdown(dom.to); });
        }
        document.addEventListener('click', function () {
            if (dom.from) dom.from.classList.remove('open');
            if (dom.to) dom.to.classList.remove('open');
        });
        on(dom.swap, 'click', swapLanguages);

        bindGroup('cap-model', 'model', 'model', function () { invalidatePreview(false); updateModelRow(false); });
        bindGroup('cap-position', 'position', 'position');
        bindSlider('cap-size', 'cap-size-val', 'size', function (v) { return v + '%'; });
        bindSlider('cap-words', 'cap-words-val', 'words', function (v) { return String(v); }, replanFromPreview);
        bindToggle('cap-selonly', 'selOnly');
        bindToggle('cap-punct', 'punct', replanFromPreview);
        bindToggle('cap-replace', 'replace');
        bindToggle('cap-gpu', 'gpu', function () { refreshEngine(false); });
        bindToggle('cap-spoken', 'spoken', function () { invalidatePreview(false); });

        // CAPTION STYLE tab
        dom.tabs = $('cap-tabs'); dom.tabText = $('cap-tab-text'); dom.tabStyle = $('cap-tab-style'); dom.tabCustom = $('cap-tab-custom');
        dom.styleGrid = $('cap-style-grid'); dom.styleAnim = $('cap-style-anim'); dom.styleChip = $('cap-style-chip');
        dom.styleBar = $('cap-style-bar'); dom.styleAbout = $('cap-style-about'); dom.styleNote = $('cap-style-note');
        dom.stylePreview = $('cap-style-preview'); dom.familyOpts = $('cap-style-family-opts'); dom.styleMode = $('cap-style-mode');
        dom.pickName = $('cap-style-pick-name');
        on(dom.styleAnim, 'error', function () { if (dom.stylePreview) dom.stylePreview.classList.add('noimg'); });
        if (dom.tabs) {
            Array.prototype.forEach.call(dom.tabs.querySelectorAll('[data-captab]'), function (b) {
                on(b, 'click', function () { showTab(b.getAttribute('data-captab')); });
            });
        }
        if (dom.styleMode) {
            Array.prototype.forEach.call(dom.styleMode.querySelectorAll('[data-stylemode]'), function (b) {
                on(b, 'click', function () { S.opts.styleMode = b.getAttribute('data-stylemode'); saveOpts(); renderStyles(); });
            });
        }
        on($('cap-style-pick'), 'click', function () { showTab('style'); });
        if (dom.pickName) dom.pickName.textContent = currentStyle().name;

        on($('cap-test'), 'click', function () { start(false); });
        on($('cap-generate'), 'click', function () { start(true); });
        on($('cap-cancel'), 'click', cancelJob);
        on(dom.clear, 'click', clearLayers);
        on(dom.install, 'click', onInstallClick);
        dom.modelState = $('cap-model-state'); dom.modelGet = $('cap-model-get');
        on($('cap-model-recheck'), 'click', function () {
            if (S.busy) return;
            checkEngine(function (err) { if (err) { toast('Install the speech engine first (button above).', 'error'); return; } updateModelRow(true); });
        });
        on(dom.modelGet, 'click', downloadModel);

        var quick = $('quick-auto-captions');
        if (quick) quick.addEventListener('click', function () {
            var nav = document.querySelector('.nav-item[data-view="captions"]');
            if (nav) nav.click();
        });
        // check the engine the first time the Captions view is opened (it starts Python, so not at panel load)
        var nav = document.querySelector('.nav-item[data-view="captions"]'), checked = false;
        function onOpen() { if (!checked) { checked = true; refreshEngine(false); } }
        if (nav) nav.addEventListener('click', onOpen);
        if (quick) quick.addEventListener('click', onOpen);
    }

    root.CFXCaptionsUI = root.DalaCaptionsUI = { test: function () { start(false); }, generate: function () { start(true); }, cancel: cancelJob, clear: clearLayers, state: function () { return S; }, refreshEngine: refreshEngine,
        showTab: showTab, styles: styleList, stylesChanged: stylesChanged, direct: function (caps) { var st = currentStyle(); return st.kind === 'family' ? root.DalaCaptionDirector.direct(caps, loadFamily(st), { mode: S.opts.styleMode }) : null; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
