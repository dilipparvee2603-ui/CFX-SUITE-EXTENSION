/**
 * Dala Suite - Auto Tracker panel controller (ES5)
 *
 * Start tracking
 *   1. prepare      host validates the selected layers, maps comp frames to source times
 *   2. find shots   After Effects renders small analysis frames (in the background - the panel
 *                   polls for them, After Effects is never blocked); the panel compares frame
 *                   signatures to find the cuts (refined to the exact frame) and measures any
 *                   letterbox bars
 *   3. pick         per shot: click a detected face, or place a point (size -/+), or skip
 *   4. track        median-flow + YuNet re-detection on a Web Worker (engine.js), forward and
 *                   backward from the pick, shown live in the preview
 *   5. apply        smoothed track -> framing (host/framing.jsx) -> Position keyframes, then
 *                   CUT 2 F on every tracked clip (frame blending + motion blur, First 2F / Mid /
 *                   Last 2F, pre-composed)
 * Everything runs locally: no network.
 */
(function (root) {
    'use strict';

    var STORE_KEY = 'dalaSuite.autoTracker.v2';
    var cs = null, dom = {}, engine = null, nodeFs = null;
    var S = {
        busy: false,
        axis: 'xy',
        opts: {
            smooth: 0, quality: 'best', split: true, zoom: true, maxZoom: 250, mirror: true, mblur: true,
            centerY: true, autoPick: false, cropBars: true, cut2f: true, pointSize: 48
        },
        job: null
    };
    try {
        if (typeof root.require === 'function') nodeFs = root.require('fs');
        else if (root.cep_node && typeof root.cep_node.require === 'function') nodeFs = root.cep_node.require('fs');
    } catch (eNode) { nodeFs = null; }

    // ------------------------------------------------------------------ helpers

    function $(id) { return document.getElementById(id); }

    function loadOpts() {
        try {
            var saved = JSON.parse(root.localStorage.getItem(STORE_KEY) || 'null');
            if (saved) {
                for (var k in saved) if (saved.hasOwnProperty(k) && S.opts.hasOwnProperty(k)) S.opts[k] = saved[k];
                // settings saved by older versions: the zoom cap of the fixed-zoom framing (v1) would stop
                // the subject short of the centre, and their default smoothing (35) made the face float
                // instead of locking like a manual head track
                if (!(saved.framing >= 2)) S.opts.maxZoom = 250;
                if (!(saved.framing >= 3)) S.opts.smooth = 0;
                if (saved.axis) S.axis = saved.axis;
            }
        } catch (e) {}
    }

    function saveOpts() {
        try {
            var o = {}; for (var k in S.opts) if (S.opts.hasOwnProperty(k)) o[k] = S.opts[k];
            o.axis = S.axis; o.framing = 3;
            root.localStorage.setItem(STORE_KEY, JSON.stringify(o));
        } catch (e) {}
    }

    function toast(message, type) { if (window.DalaToast) window.DalaToast(message, type); }

    function host(fn, arg, cb) {
        var call = '$._dalaSuite.autoTracker.' + fn + '(' + (arg === undefined ? '' : JSON.stringify(JSON.stringify(arg))) + ')';
        cs.evalScript(call, function (raw) {
            var res;
            try { res = JSON.parse(raw); }
            catch (e) { res = { success: false, message: (raw && raw !== 'undefined') ? String(raw) : 'After Effects did not answer (is the Dala Suite host script loaded?)' }; }
            cb(res);
        });
    }

    function fmtElapsed(ms) {
        var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
        s = s % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function getEngine() {
        if (!engine) engine = root.DalaTrackEngine.get();
        return engine;
    }

    // ------------------------------------------------------------------ preview canvas
    // The visible canvas is CPU-backed (willReadFrequently) and is always redrawn from a cached
    // copy of the current frame, so it can never be left blank: if the GPU drops the canvas
    // (context lost) it is repainted as soon as it comes back.

    var view = { ctx: null, frame: null, frameKey: null, overlay: null };

    function initCanvas() {
        try { view.ctx = dom.canvas.getContext('2d', { willReadFrequently: true }); } catch (e) { view.ctx = null; }
        if (!view.ctx) view.ctx = dom.canvas.getContext('2d');
        dom.canvas.addEventListener('contextrestored', function () { view.frameKey = null; redraw(); });
        document.addEventListener('visibilitychange', function () { if (!document.hidden) redraw(); });
        root.addEventListener('resize', function () { redraw(); });
    }

    // img: { width, height, data } - copied into an offscreen canvas once per frame
    function setFrame(img, key) {
        if (!img) return;
        if (view.frameKey === key && view.frame) return;
        var f = view.frame || document.createElement('canvas');
        if (f.width !== img.width || f.height !== img.height) { f.width = img.width; f.height = img.height; }
        var fctx = f.getContext('2d'), id = fctx.createImageData(img.width, img.height);
        id.data.set(img.data);
        fctx.putImageData(id, 0, 0);
        view.frame = f; view.frameKey = key;
    }

    var redrawQueued = false;
    function redraw() {
        if (redrawQueued) return;
        redrawQueued = true;
        (root.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
            redrawQueued = false;
            paint();
        });
    }

    function paint() {
        var c = dom.canvas, ctx = view.ctx;
        if (!ctx || !view.frame) return;
        if (c.width !== view.frame.width || c.height !== view.frame.height) { c.width = view.frame.width; c.height = view.frame.height; }
        ctx.drawImage(view.frame, 0, 0);
        if (view.overlay) view.overlay(ctx, c);
    }

    // ------------------------------------------------------------------ view state

    function show(section) {
        dom.idle.style.display = section === 'idle' ? 'flex' : 'none';
        dom.progress.style.display = section === 'idle' ? 'none' : 'flex';
        var stage = section === 'picker' || section === 'tracking';
        dom.picker.style.display = stage ? 'flex' : 'none';
        dom.empty.style.display = section === 'idle' ? 'flex' : 'none';
        // picker-only controls
        var pickOnly = section === 'picker' ? '' : 'none';
        $('at-picker-actions').style.display = section === 'picker' ? 'grid' : 'none';
        dom.scrubRow.style.display = pickOnly;
        if (section !== 'picker') dom.pointRow.style.display = 'none';
        dom.modeBadge.style.display = pickOnly;
        var lock = section !== 'idle';
        var btns = dom.card.querySelectorAll('.at-axis .subtab-btn');
        for (var i = 0; i < btns.length; i++) btns[i].disabled = lock;
        if (stage) redraw();
    }

    function setProgress(label, frac) {
        S.progressLabel = label;
        S.progressFrac = frac;
        renderProgress();
    }

    function renderProgress() {
        if (!S.job) return;
        var el = fmtElapsed(Date.now() - S.job.t0);
        var lbl = S.progressLabel + ' · ' + el + ' elapsed';
        if (S.progressFrac > 0.03 && S.progressFrac < 1 && S.job.phaseT0) {
            var spent = Date.now() - S.job.phaseT0, left = spent / S.progressFrac - spent;
            if (spent > 4000) lbl += ' · ~' + fmtElapsed(left) + ' left';
        }
        dom.progressLabel.textContent = lbl;
        dom.progressFill.style.width = Math.round(Math.max(0, Math.min(1, S.progressFrac || 0)) * 100) + '%';
    }

    function finish(message, type, resultText) {
        var job = S.job;
        if (S.timer) { clearInterval(S.timer); S.timer = null; }
        S.busy = false;
        S.job = null;
        if (engine) engine.cancel();
        view.overlay = null;
        if (job && job.cache) job.cache.clear();
        // let renders that are still being written finish before the folder is removed
        var inflight = job ? pendingPaths(job) : [];
        waitFiles(inflight, 10000, function () { host('cleanup', undefined, function () {}); });
        show('idle');
        if (resultText) {
            dom.emptyText.textContent = resultText;
            dom.empty.className = 'at-empty result';
        } else {
            dom.emptyText.textContent = 'Select a footage clip, then run Auto Tracker to pick the face or a point in each shot.';
            dom.empty.className = 'at-empty';
        }
        if (message) toast(message, type || 'info');
    }

    function cancelled() { return !S.job || S.job.cancelled; }

    // ------------------------------------------------------------------ analysis frames

    function framePath(L, idx) {
        return S.job.info.framesPath.replace(/\\/g, '/') + '/L' + L.key + '_' + idx + '.png';
    }

    function pendingPaths(job) {
        var out = [];
        if (job.requested) for (var p in job.requested) if (job.requested.hasOwnProperty(p) && !job.ready[p]) out.push(p);
        return out;
    }

    // byte sizes of files (-1 = missing): Node fs if the panel has it, else one quick host call
    function sizesOf(paths, cb) {
        if (nodeFs) {
            var out = [];
            for (var i = 0; i < paths.length; i++) { try { out.push(nodeFs.statSync(paths[i]).size); } catch (e) { out.push(-1); } }
            return cb(out);
        }
        host('frameSizes', { paths: paths }, function (res) { cb(res.success ? res.data.sizes : null); });
    }

    /**
     * After Effects writes analysis PNGs in the background (saveFrameToPng returns at once in
     * AE 2022+). Poll - without blocking After Effects - until every file exists and its size
     * stayed the same over one poll interval, then call back.
     */
    function waitFiles(paths, timeoutMs, cb) {
        if (!paths.length) return cb(null);
        var last = null, t0 = Date.now();
        (function poll() {
            sizesOf(paths, function (sizes) {
                var done = !!sizes;
                for (var i = 0; sizes && i < sizes.length; i++) {
                    if (!(sizes[i] > 0) || !last || last[i] !== sizes[i]) done = false;
                }
                last = sizes;
                if (done) return cb(null);
                if (Date.now() - t0 > timeoutMs) return cb(new Error('After Effects did not finish rendering the analysis frames.'));
                setTimeout(poll, 90);
            });
        })();
    }

    // Renders (if needed) and loads frames of a layer in small batches; onFrame(idx, img).
    function renderAndLoad(L, frames, onFrame, onProgress, done) {
        var CHUNK = 8, pos = 0, job = S.job;
        function next() {
            if (cancelled()) return;
            if (pos >= frames.length) return done(null);
            var chunk = frames.slice(pos, pos + CHUNK), need = [], k;
            for (k = 0; k < chunk.length; k++) if (!job.ready[framePath(L, chunk[k])]) need.push(chunk[k]);
            var go = function () {
                var j = 0;
                (function loadNext() {
                    if (cancelled()) return;
                    if (j >= chunk.length) { pos += chunk.length; if (onProgress) onProgress(pos, frames.length); return next(); }
                    var idx = chunk[j];
                    if (!onFrame) { j++; return loadNext(); }
                    job.cache.get(framePath(L, idx), function (err, img) {
                        if (err) return done(err);
                        onFrame(idx, img);
                        j++;
                        loadNext();
                    });
                })();
            };
            if (!need.length) return go();
            host('renderFrames', { key: L.key, frames: need }, function (res) {
                if (cancelled()) return;
                if (!res.success) return done(new Error(res.message));
                var paths = [];
                for (k = 0; k < need.length; k++) { var p = framePath(L, need[k]); job.requested[p] = true; paths.push(res.data.paths[k] || p); }
                waitFiles(paths, 30000, function (err) {
                    if (cancelled()) return;
                    if (err) return done(err);
                    for (k = 0; k < need.length; k++) job.ready[framePath(L, need[k])] = true;
                    go();
                });
            });
        }
        next();
    }

    // ------------------------------------------------------------------ 1. prepare

    function start() {
        if (S.busy) return;
        if (!cs) { toast('After Effects connection unavailable.', 'error'); return; }
        S.busy = true;
        S.job = { t0: Date.now(), phaseT0: Date.now(), cancelled: false, cache: new root.DalaFrameIO.FrameCache(24), requested: {}, ready: {} };
        view.overlay = null;
        show('progress');
        setProgress('Preparing', 0);
        S.timer = setInterval(renderProgress, 1000);
        getEngine();   // start the worker while After Effects prepares
        var fast = S.opts.quality === 'fast';
        host('prepare', { analysisSize: fast ? 480 : 640 }, function (res) {
            if (cancelled()) return;
            if (!res.success) { finish(res.message || 'Auto Tracker could not start.', 'error'); return; }
            var d = res.data, job = S.job;
            job.info = d;
            job.step = fast ? 2 : 1;
            job.layers = d.layers;
            if (d.skipped && d.skipped.length) {
                toast('Skipped ' + d.skipped.length + ' layer(s): ' + d.skipped[0].name + ' (' + d.skipped[0].why + ')', 'info');
            }
            analyzeLayer(0);
        });
    }

    // ------------------------------------------------------------------ 2. find shots

    function analyzeLayer(li) {
        var job = S.job;
        if (li >= job.layers.length) return startPicking();
        var L = job.layers[li], n = L.f1 - L.f0, step = job.step, samples = [], i;
        for (i = 0; i < n; i += step) samples.push(i);
        if (samples[samples.length - 1] !== n - 1) samples.push(n - 1);
        L.n = n; L.samples = samples; L.sig = {}; L.bars = null;
        job.phaseT0 = Date.now();
        var label = 'Finding shots' + (job.layers.length > 1 ? ' · layer ' + (li + 1) + '/' + job.layers.length : '');
        renderAndLoad(L, samples, function (idx, img) {
            L.sig[idx] = root.DalaVision.frameSignature(img);
            // letterbox bars: keep the smallest bar seen on any frame (dark scenes cannot inflate it)
            var b = root.DalaVision.letterbox(img);
            if (!L.bars) L.bars = b;
            else {
                L.bars.top = Math.min(L.bars.top, b.top); L.bars.bottom = Math.min(L.bars.bottom, b.bottom);
                L.bars.left = Math.min(L.bars.left, b.left); L.bars.right = Math.min(L.bars.right, b.right);
            }
        }, function (done, total) {
            setProgress(label + ' · ' + done + '/' + total, done / total);
        }, function (err) {
            if (err) return finish(err.message, 'error');
            var dist = [0];
            for (i = 1; i < samples.length; i++) dist.push(root.DalaVision.signatureDistance(L.sig[samples[i - 1]], L.sig[samples[i]]));
            var cutsS = root.DalaVision.detectCuts(dist, { minShot: Math.max(2, Math.ceil(6 / step)) });
            refineCuts(L, cutsS, function (cuts) {
                L.shots = [];
                var bounds = [0].concat(cuts, [n]), edges = [];
                for (var s = 0; s + 1 < bounds.length; s++) {
                    L.shots.push({ start: bounds[s], end: bounds[s + 1], seed: null });
                    edges.push(bounds[s], bounds[s + 1] - 1);
                }
                // every frame the tracker will read exists before tracking starts, so tracking never
                // has to ask After Effects for anything
                renderAndLoad(L, edges, null, null, function (err2) {
                    if (err2) return finish(err2.message, 'error');
                    analyzeLayer(li + 1);
                });
            });
        });
    }

    // With step > 1 a cut lies somewhere between two samples: render the frames in between and
    // put the cut where consecutive frames differ most.
    function refineCuts(L, cutsS, done) {
        var out = [], k = 0;
        (function next() {
            if (cancelled()) return;
            if (k >= cutsS.length) return done(out);
            var b = L.samples[cutsS[k]], a = L.samples[cutsS[k] - 1];
            k++;
            if (b - a <= 1) { out.push(b); return next(); }
            var mids = [];
            for (var f = a + 1; f < b; f++) mids.push(f);
            renderAndLoad(L, mids, function (idx, img) { L.sig[idx] = root.DalaVision.frameSignature(img); }, null, function (err) {
                if (err) { out.push(b); return next(); }
                var best = b, bestD = -1;
                for (var g = a + 1; g <= b; g++) {
                    var d = root.DalaVision.signatureDistance(L.sig[g - 1], L.sig[g]);
                    if (d > bestD) { bestD = d; best = g; }
                }
                out.push(best);
                next();
            });
        })();
    }

    // ------------------------------------------------------------------ 3. pick

    function startPicking() {
        var job = S.job, li, si;
        job.queue = [];
        for (li = 0; li < job.layers.length; li++) {
            for (si = 0; si < job.layers[li].shots.length; si++) job.queue.push({ li: li, si: si });
        }
        job.qi = 0;
        job.phaseT0 = null;   // no time-left estimate while waiting for the user
        showShot();
    }

    function shotSamples(L, shot) {
        var list = [shot.start], i;
        for (i = 0; i < L.samples.length; i++) if (L.samples[i] > shot.start && L.samples[i] < shot.end - 1) list.push(L.samples[i]);
        if (shot.end - 1 > shot.start) list.push(shot.end - 1);
        return list;
    }

    function showShot() {
        var job = S.job;
        if (job.qi >= job.queue.length) return startTracking();
        var q = job.queue[job.qi], L = job.layers[q.li], shot = L.shots[q.si];
        var P = job.pick = { q: q, L: L, shot: shot, samples: shotSamples(L, shot), mode: 'face', faces: null, point: null };
        P.pos = Math.floor((P.samples.length - 1) / 2);
        var nL = job.layers.length;
        dom.pickerTitle.textContent = (nL > 1 ? 'Layer ' + (q.li + 1) + '/' + nL + ' · ' : '') +
            'shot ' + (q.si + 1) + '/' + L.shots.length + ' (' + (job.qi + 1) + ' of ' + job.queue.length + ')';
        setProgress('Pick a face · ' + (job.qi + 1) + ' of ' + job.queue.length, job.qi / job.queue.length);
        dom.scrub.min = 0; dom.scrub.max = P.samples.length - 1; dom.scrub.value = P.pos;
        view.overlay = pickOverlay;
        setMode('face');
        show('picker');
        loadPickFrame();
    }

    function setMode(mode) {
        var P = S.job && S.job.pick;
        if (!P) return;
        P.mode = mode;
        dom.modeBadge.textContent = mode === 'face' ? 'FACE' : 'POINT';
        dom.modeBadge.className = 'at-mode-badge' + (mode === 'point' ? ' point' : '');
        dom.modeToggle.textContent = mode === 'face' ? 'TRACK A POINT' : 'PICK A FACE';
        dom.pointRow.style.display = mode === 'point' ? 'flex' : 'none';
        dom.pickerHint.textContent = mode === 'face'
            ? 'Click a face, or drag the strip to another moment.'
            : 'Click your subject to place the point, size it with −/+, then Track this point.';
        redraw();
    }

    function loadPickFrame() {
        var P = S.job.pick, idx = P.samples[P.pos], token = {};
        P.token = token; P.faces = null; P.hover = -1;
        var fps = S.job.info.fps;
        dom.scrubTime.textContent = idx + 'f · ' + (idx / fps).toFixed(2) + 's';
        stageMsg('Loading frame…');
        // the previous picture stays on screen until the new one is ready (never a blank preview)
        renderAndLoad(P.L, [idx], null, null, function (err) {
            if (cancelled() || P.token !== token) return;
            if (err) return finish(err.message, 'error');
            S.job.cache.get(framePath(P.L, idx), function (err2, img) {
                if (cancelled() || P.token !== token) return;
                if (err2) return finish(err2.message, 'error');
                P.img = img;
                setFrame(img, P.L.key + ':' + idx);
                redraw();
                stageMsg('Finding faces…');
                getEngine().detect(img, { maxSide: 640, scoreThreshold: 0.6 }, function (err3, faces) {
                    if (cancelled() || P.token !== token) return;
                    P.faces = err3 ? [] : faces;
                    if (S.opts.autoPick && P.faces.length && P.mode === 'face') {
                        var big = P.faces[0];
                        for (var i = 1; i < P.faces.length; i++) if (P.faces[i].w * P.faces[i].h > big.w * big.h) big = P.faces[i];
                        return pickSeed({ kind: 'face', frame: idx, box: { x: big.x, y: big.y, w: big.w, h: big.h }, kps: big.kps });
                    }
                    stageMsg(P.faces.length ? '' : 'No face found on this frame. Drag the strip to another moment, or Track a point.');
                    redraw();
                });
            });
        });
    }

    function stageMsg(text) {
        dom.stageMsg.textContent = text || '';
        dom.stageMsg.style.display = text ? 'block' : 'none';
    }

    function pickOverlay(ctx, c) {
        var P = S.job && S.job.pick;
        if (!P) return;
        var lw = Math.max(2, Math.round(c.width / 320)), i;
        if (P.mode === 'face' && P.faces) {
            for (i = 0; i < P.faces.length; i++) {
                var f = P.faces[i];
                ctx.lineWidth = lw;
                ctx.strokeStyle = i === P.hover ? '#ffffff' : '#ef4444';
                ctx.fillStyle = i === P.hover ? 'rgba(41,121,255,0.30)' : 'rgba(41,121,255,0.14)';
                roundRect(ctx, f.x, f.y, f.w, f.h, Math.min(f.w, f.h) * 0.18);
                ctx.fill(); ctx.stroke();
            }
        }
        if (P.mode === 'point' && P.point) {
            var r = S.opts.pointSize / 2 * (c.width / 640);
            ctx.lineWidth = lw; ctx.strokeStyle = '#00e676'; ctx.fillStyle = 'rgba(0,230,118,0.15)';
            ctx.beginPath(); ctx.arc(P.point.x, P.point.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.arc(P.point.x, P.point.y, lw * 1.5, 0, Math.PI * 2); ctx.fillStyle = '#00e676'; ctx.fill();
        }
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function canvasPoint(ev) {
        var r = dom.canvas.getBoundingClientRect();
        return { x: (ev.clientX - r.left) * dom.canvas.width / r.width, y: (ev.clientY - r.top) * dom.canvas.height / r.height };
    }

    function faceAt(p) {
        var P = S.job.pick, best = -1, bestD = 1e9;
        if (!P.faces) return -1;
        for (var i = 0; i < P.faces.length; i++) {
            var f = P.faces[i], pad = Math.max(6, f.w * 0.15);
            if (p.x >= f.x - pad && p.x <= f.x + f.w + pad && p.y >= f.y - pad && p.y <= f.y + f.h + pad) {
                var d = Math.abs(p.x - (f.x + f.w / 2)) + Math.abs(p.y - (f.y + f.h / 2));
                if (d < bestD) { bestD = d; best = i; }
            }
        }
        return best;
    }

    function onCanvasClick(ev) {
        var P = S.job && S.job.pick;
        if (!P || !P.img) return;
        var p = canvasPoint(ev);
        if (P.mode === 'face') {
            var i = faceAt(p);
            if (i < 0) { if (P.faces) stageMsg(P.faces.length ? 'Click inside one of the boxes.' : 'No face here. Use Track a point instead.'); return; }
            var f = P.faces[i];
            pickSeed({ kind: 'face', frame: P.samples[P.pos], box: { x: f.x, y: f.y, w: f.w, h: f.h }, kps: f.kps });
        } else {
            P.point = p;
            redraw();
        }
    }

    function onCanvasMove(ev) {
        var P = S.job && S.job.pick;
        if (!P || P.mode !== 'face' || !P.faces) return;
        var h = faceAt(canvasPoint(ev));
        if (h !== P.hover) { P.hover = h; redraw(); }
    }

    function trackPoint() {
        var P = S.job && S.job.pick;
        if (!P) return;
        if (!P.point) { stageMsg('Click the subject first to place the point.'); return; }
        var size = S.opts.pointSize * (dom.canvas.width / 640);
        pickSeed({ kind: 'point', frame: P.samples[P.pos], box: { x: P.point.x - size / 2, y: P.point.y - size / 2, w: size, h: size } });
    }

    function pickSeed(seed) {
        var job = S.job, P = job.pick;
        P.shot.seed = seed;
        P.token = null;   // ignore late results for this shot
        job.qi++;
        showShot();
    }

    function skipShot() {
        var job = S.job;
        if (!job || !job.pick) return;
        job.pick.shot.seed = null;
        job.pick.token = null;
        job.qi++;
        showShot();
    }

    // ------------------------------------------------------------------ 4. track (live preview)

    function startTracking() {
        var job = S.job, li, si, list = [];
        job.pick = null;
        for (li = 0; li < job.layers.length; li++) {
            for (si = 0; si < job.layers[li].shots.length; si++) {
                if (job.layers[li].shots[si].seed) list.push({ L: job.layers[li], shot: job.layers[li].shots[si] });
            }
        }
        if (!list.length) return finish('Nothing to track: every shot was skipped.', 'info');
        job.phaseT0 = Date.now();
        job.trackList = list;
        var live = { box: null, kind: 'face' };
        view.overlay = function (ctx, c) {
            if (!live.box) return;
            var b = live.box, lw = Math.max(2, Math.round(c.width / 320));
            ctx.lineWidth = lw;
            ctx.strokeStyle = live.lost ? '#ef4444' : (live.kind === 'face' ? '#ef4444' : '#00e676');
            roundRect(ctx, b.bx - b.w / 2, b.by - b.h / 2, b.w, b.h, Math.min(b.w, b.h) * 0.18);
            ctx.stroke();
            ctx.beginPath(); ctx.arc(b.x, b.y, lw * 2, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
        };
        dom.pickerHint.textContent = 'Tracking runs in the background — you can keep working in After Effects.';
        show('tracking');
        var totalFrames = 0, doneFrames = 0, i;
        for (i = 0; i < list.length; i++) totalFrames += shotSamples(list[i].L, list[i].shot).length;
        var k = 0;
        (function nextShot() {
            if (cancelled()) return;
            if (k >= list.length) return applyAll();
            var item = list[k], L = item.L, shot = item.shot, samples = shotSamples(L, shot);
            var label = 'Tracking ' + (k + 1) + ' of ' + list.length;
            dom.pickerTitle.textContent = (job.layers.length > 1 ? L.name + ' · ' : '') + 'shot ' + (k + 1) + ' of ' + list.length;
            setProgress(label, doneFrames / totalFrames);
            live.kind = shot.seed.kind; live.box = null;
            var seedIndex = samples.indexOf(shot.seed.frame);
            if (seedIndex < 0) seedIndex = 0;
            var lastShown = 0;
            getEngine().track({
                count: samples.length, seedIndex: seedIndex, seed: shot.seed,
                opts: { detectEvery: S.opts.quality === 'fast' ? 6 : 12 },   // face check about every 0.5 s
                getFrame: function (i2, cb) { S.job.cache.get(framePath(L, samples[i2]), cb); },
                isCancelled: cancelled,
                onProgress: function (d, t, last) {
                    if (cancelled()) return;
                    setProgress(label, (doneFrames + d) / totalFrames);
                    // live preview: at most ~12 updates a second
                    var now = Date.now();
                    if (last && now - lastShown > 80) {
                        lastShown = now;
                        var key = L.key + ':' + samples[last.i];
                        S.job.cache.get(framePath(L, samples[last.i]), function (e, img) {
                            if (e || cancelled()) return;
                            setFrame(img, key);
                            live.box = last.lost ? live.box : last; live.lost = !!last.lost;
                            redraw();
                        });
                    }
                }
            }, function (err2, res) {
                if (cancelled()) return;
                if (err2) return finish(err2.message, 'error');
                doneFrames += samples.length;
                shot.result = buildTrack(L, shot, samples, res.frames, res.feature);
                k++;
                setTimeout(nextShot, 0);
            });
        })();
    }

    // samples (analysis px) -> one source-pixel position per frame of the shot, smoothed
    function buildTrack(L, shot, samples, frames, feature) {
        var filled = root.DalaVision.fillGaps(frames);
        if (!filled) return null;
        var n = shot.end - shot.start, xs = new Array(n), ys = new Array(n), conf = new Array(n), j = 0, f;
        for (f = shot.start; f < shot.end; f++) {
            while (j + 1 < samples.length && samples[j + 1] <= f) j++;
            var a = samples[j], b = j + 1 < samples.length ? samples[j + 1] : a;
            var t = b > a ? (f - a) / (b - a) : 0;
            var pa = filled[j], pb = filled[Math.min(j + 1, filled.length - 1)];
            xs[f - shot.start] = (pa.x + (pb.x - pa.x) * t) / L.kx;
            ys[f - shot.start] = (pa.y + (pb.y - pa.y) * t) / L.ky;
            // match quality as After Effects' Confidence (its scale reads ~100 - 70 x (1 - ZNCC))
            var c = frames[j] && frames[j].conf != null ? frames[j].conf : 0;
            conf[f - shot.start] = frames[j] ? Math.round(Math.max(0, Math.min(100, 100 - 70 * (1 - c))) * 10) / 10 : 0;
        }
        // smoothness 0..100 -> Gaussian sigma 0..0.5 s of the local quadratic fit; 0 = the raw track,
        // applied as-is like a manual track point (Apply X and Y)
        var sigma = (S.opts.smooth / 100) * 0.5 * S.job.info.fps, med = S.opts.smooth > 0 ? 1 : 0;
        var sx = root.DalaVision.smooth(xs, sigma, med), sy = root.DalaVision.smooth(ys, sigma, med);
        var track = [];
        for (f = 0; f < n; f++) track.push([shot.start + f, Math.round(sx[f] * 100) / 100, Math.round(sy[f] * 100) / 100]);
        var lost = 0;
        for (f = 0; f < frames.length; f++) if (!frames[f]) lost++;
        var fs = feature ? { w: Math.round(feature.w / L.kx * 10) / 10, h: Math.round(feature.h / L.ky * 10) / 10 } : null;
        return { track: track, conf: conf, lost: lost, samples: frames.length, feature: fs,
                 search: fs ? { w: Math.round(fs.w * 17) / 10, h: Math.round(fs.h * 17) / 10 } : null };
    }

    // ------------------------------------------------------------------ 5. apply

    // the picture area inside letterbox / pillarbox bars, in source pixels (null = whole frame)
    function activeArea(L) {
        if (!S.opts.cropBars || !L.bars) return null;
        var b = L.bars, aw = L.analysisW, ah = L.analysisH;
        // real letterbox / pillarbox bars are symmetric: a dark scene edge on one side only is
        // picture, so use the smaller side for both
        var tb = Math.min(b.top, b.bottom), lr = Math.min(b.left, b.right);
        var top = tb >= ah * 0.02 ? tb + 1 : 0, bottom = top;
        var left = lr >= aw * 0.02 ? lr + 1 : 0, right = left;
        if (!top && !bottom && !left && !right) return null;
        if (aw - left - right < aw * 0.3 || ah - top - bottom < ah * 0.3) return null;   // not a letterbox
        return { x0: left / L.kx, y0: top / L.ky, x1: (aw - right) / L.kx, y1: (ah - bottom) / L.ky };
    }

    function applyAll() {
        var job = S.job, payload = {
            axis: S.axis, split: S.opts.split, zoom: S.opts.zoom ? 'auto' : 'off', maxZoom: S.opts.maxZoom / 100,
            mirror: S.opts.mirror, motionBlur: S.opts.mblur, centerY: S.opts.centerY, cut2f: S.opts.cut2f, layers: []
        }, li, si, lostTotal = 0;
        for (li = 0; li < job.layers.length; li++) {
            var L = job.layers[li], shots = [];
            for (si = 0; si < L.shots.length; si++) {
                var sh = L.shots[si], r = sh.seed ? sh.result : null;
                if (r) lostTotal += r.lost;
                shots.push({ start: sh.start, end: sh.end, track: r ? r.track : null, conf: r ? r.conf : null,
                             feature: r ? r.feature : null, search: r ? r.search : null });
            }
            payload.layers.push({ key: L.key, shots: shots, active: activeArea(L) });
        }
        setProgress(S.opts.cut2f ? 'Applying keyframes + Cut to F' : 'Applying keyframes', 1);
        // drop the analysis comps first so that "apply" is the last undo step (one Ctrl+Z undoes it)
        host('releaseAnalysis', undefined, function () {
            if (cancelled()) return;
            host('apply', payload, onApplied);
        });
        function onApplied(res) {
            if (cancelled()) return;
            var d = res.data || {};
            if (!res.success) return finish(res.message || 'Applying the track failed.', 'error');
            var txt = res.message + (d.skippedShots ? ' ' + d.skippedShots + ' shot(s) left untouched.' : '') +
                ' Undo with Ctrl+Z, or select the layers and use Remove tracking.';
            if (d.warnings && d.warnings.length) toast(d.warnings.join(' '), 'info');
            if (lostTotal) txt += ' (' + lostTotal + ' analysis frame(s) had the subject hidden and were filled in.)';
            finish(res.message, 'success', txt);
        }
    }

    function cancelJob() {
        if (!S.job) return;
        S.job.cancelled = true;
        finish('Auto Tracker cancelled.', 'info');
    }

    function removeTracking() {
        if (S.busy || !cs) return;
        host('remove', undefined, function (res) {
            var msg = res.message || (res.success ? 'Done.' : 'Failed.');
            toast(msg, res.success ? 'success' : 'error');
            dom.emptyText.textContent = msg;
            dom.empty.className = 'at-empty' + (res.success ? ' result' : '');
        });
    }

    // ------------------------------------------------------------------ wiring

    function bindOpt(id, key, isCheck) {
        var el = $(id);
        if (!el) return;
        if (isCheck) el.checked = !!S.opts[key]; else el.value = S.opts[key];
        el.addEventListener('change', function () {
            S.opts[key] = isCheck ? el.checked : (el.type === 'range' ? +el.value : el.value);
            saveOpts();
        });
    }

    function init() {
        dom.card = $('at-card');
        if (!dom.card) return;
        try { cs = new root.CSInterface(); } catch (e) { cs = null; }
        loadOpts();
        dom.axis = $('at-axis'); dom.idle = $('at-idle'); dom.progress = $('at-progress');
        dom.progressFill = $('at-progress-fill'); dom.progressLabel = $('at-progress-label');
        dom.picker = $('at-picker'); dom.pickerTitle = $('at-picker-title'); dom.pickerHint = $('at-picker-hint');
        dom.modeBadge = $('at-mode-badge'); dom.canvas = $('at-canvas'); dom.stageMsg = $('at-stage-msg');
        dom.scrub = $('at-scrub'); dom.scrubTime = $('at-scrub-time'); dom.pointRow = $('at-point-row');
        dom.scrubRow = $('at-scrub-row');
        dom.modeToggle = $('at-mode-toggle'); dom.empty = $('at-empty'); dom.emptyText = $('at-empty-text');
        initCanvas();

        var axisBtns = dom.axis.querySelectorAll('.subtab-btn'), i;
        function syncAxis() { for (var j = 0; j < axisBtns.length; j++) axisBtns[j].classList.toggle('active', axisBtns[j].getAttribute('data-axis') === S.axis); }
        for (i = 0; i < axisBtns.length; i++) {
            axisBtns[i].addEventListener('click', function () { S.axis = this.getAttribute('data-axis'); syncAxis(); saveOpts(); });
        }
        syncAxis();

        var qBtns = $('at-quality').querySelectorAll('.subtab-btn');
        function syncQuality() { for (var j = 0; j < qBtns.length; j++) qBtns[j].classList.toggle('active', qBtns[j].getAttribute('data-quality') === S.opts.quality); }
        for (i = 0; i < qBtns.length; i++) {
            qBtns[i].addEventListener('click', function () { S.opts.quality = this.getAttribute('data-quality'); syncQuality(); saveOpts(); });
        }
        syncQuality();

        bindOpt('at-smooth', 'smooth'); bindOpt('at-split', 'split', true);
        bindOpt('at-zoom', 'zoom', true); bindOpt('at-mirror', 'mirror', true); bindOpt('at-mblur', 'mblur', true);
        bindOpt('at-centery', 'centerY', true); bindOpt('at-autopick', 'autoPick', true); bindOpt('at-cropbars', 'cropBars', true);
        bindOpt('at-maxzoom', 'maxZoom');
        var sv = $('at-smooth-val');
        sv.textContent = S.opts.smooth;
        $('at-smooth').addEventListener('input', function () { sv.textContent = this.value; });
        var zv = $('at-maxzoom-val');
        zv.textContent = S.opts.maxZoom + '%';
        $('at-maxzoom').addEventListener('input', function () { zv.textContent = this.value + '%'; });
        $('at-size-val').textContent = S.opts.pointSize;

        // two separate workflows, chosen before tracking starts: with or without CUT 2 F afterwards
        $('at-start-cut2f').addEventListener('click', function () { if (S.busy) return; S.opts.cut2f = true; start(); });
        $('at-start-plain').addEventListener('click', function () { if (S.busy) return; S.opts.cut2f = false; start(); });
        $('at-remove').addEventListener('click', removeTracking);
        $('at-cancel').addEventListener('click', cancelJob);
        $('at-picker-cancel').addEventListener('click', cancelJob);
        $('at-skip').addEventListener('click', skipShot);
        $('at-track-point').addEventListener('click', trackPoint);
        dom.modeToggle.addEventListener('click', function () { setMode(S.job.pick.mode === 'face' ? 'point' : 'face'); });
        function resize(d) {
            S.opts.pointSize = Math.max(12, Math.min(200, S.opts.pointSize + d));
            $('at-size-val').textContent = S.opts.pointSize; saveOpts(); redraw();
        }
        $('at-size-down').addEventListener('click', function () { resize(-8); });
        $('at-size-up').addEventListener('click', function () { resize(8); });
        dom.canvas.addEventListener('click', onCanvasClick);
        dom.canvas.addEventListener('mousemove', onCanvasMove);
        var scrubTimer = null;
        dom.scrub.addEventListener('input', function () {
            var P = S.job && S.job.pick;
            if (!P) return;
            P.pos = +dom.scrub.value;
            P.point = null;
            dom.scrubTime.textContent = P.samples[P.pos] + 'f';
            if (scrubTimer) clearTimeout(scrubTimer);
            scrubTimer = setTimeout(loadPickFrame, 120);
        });

        var quick = $('quick-auto-tracker');
        if (quick) quick.addEventListener('click', function () {
            var nav = document.querySelector('.nav-item[data-view="tracker"]');
            if (nav) nav.click();
        });
        show('idle');
    }

    root.DalaAutoTrackerUI = { start: start, cancel: cancelJob, state: function () { return S; }, engine: function () { return engine; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
