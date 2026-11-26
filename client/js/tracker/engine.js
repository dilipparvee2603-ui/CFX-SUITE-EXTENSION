/**
 * Dala Suite - Auto Tracker compute engine (ES5)
 *
 * Runs face detection and shot tracking in a Web Worker so the panel never freezes (a busy
 * panel is what made the preview flicker / go black inside After Effects). The worker is built
 * from the same tracker scripts the panel loads (read with cep.fs, or XHR in a browser), so
 * nothing extra ships. If a worker cannot be created the engine runs inline, as before.
 *
 *   engine.detect(img, opts, cb(err, faces))
 *   engine.track({ count, seedIndex, seed, opts, getFrame(i, cb), onProgress(done, total, last),
 *                  isCancelled }, cb(err, { frames }))
 *   engine.cancel()   stops any running work
 */
(function (root) {
    'use strict';

    var SCRIPTS = ['yunet-model.js', 'yunet.js', 'vision.js', 'trackCore.js', 'featureTrack.js'];

    // worker side (serialised with Function.prototype.toString; runs inside the worker)
    function workerMain() {
        var det = null, jobs = {};
        function getDet() { return det || (det = new self.DalaYuNet.Detector(self.DalaYuNetModel)); }
        function toImg(o) { return { width: o.width, height: o.height, data: new Uint8ClampedArray(o.buffer) }; }
        self.onmessage = function (e) {
            var m = e.data;
            if (m.type === 'ping') { self.postMessage({ type: 'pong' }); return; }
            if (m.type === 'detect') {
                try { self.postMessage({ type: 'detect', id: m.id, faces: getDet().detect(toImg(m.img), m.opts) }); }
                catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) }); }
                return;
            }
            if (m.type === 'track') {
                var job = m.job, st = { pend: {}, cancelled: false };
                jobs[m.id] = st;
                self.DalaFeatureTrack.trackShot({
                    count: job.count, seedIndex: job.seedIndex, seed: job.seed, opts: job.opts,
                    detector: job.seed.kind === 'face' ? getDet() : null,
                    getFrame: function (i, cb) { st.pend[i] = cb; self.postMessage({ type: 'need', id: m.id, i: i }); },
                    isCancelled: function () { return st.cancelled; },
                    onProgress: function (d, t, last) { self.postMessage({ type: 'progress', id: m.id, done: d, total: t, last: last }); }
                }, function (err, res) {
                    delete jobs[m.id];
                    if (err) self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
                    else self.postMessage({ type: 'done', id: m.id, frames: res.frames, feature: res.feature });
                });
                return;
            }
            if (m.type === 'frame') {
                var j = jobs[m.id]; if (!j) return;
                var cb = j.pend[m.i]; delete j.pend[m.i];
                if (cb) cb(m.err ? new Error(m.err) : null, m.err ? null : toImg(m.img));
                return;
            }
            if (m.type === 'cancel') { if (jobs[m.id]) jobs[m.id].cancelled = true; }
        };
    }

    function baseDir() {
        var p = decodeURIComponent(root.location.pathname);
        p = p.substring(0, p.lastIndexOf('/') + 1) + 'js/tracker/';
        if (/^\/[A-Za-z]:\//.test(p)) p = p.substring(1);   // Windows: /C:/... -> C:/...
        return p;
    }

    function readText(name, cb) {
        if (root.location.protocol === 'file:' && root.cep && root.cep.fs && root.cep.encoding) {
            var r = root.cep.fs.readFile(baseDir() + name, root.cep.encoding.UTF8);
            return r.err === 0 ? cb(null, r.data) : cb(new Error('cannot read ' + name + ' (' + r.err + ')'));
        }
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'js/tracker/' + name, true);
        xhr.onload = function () { (xhr.status === 200 || xhr.status === 0) && xhr.responseText ? cb(null, xhr.responseText) : cb(new Error('HTTP ' + xhr.status)); };
        xhr.onerror = function () { cb(new Error('cannot load ' + name)); };
        xhr.send();
    }

    function Engine() {
        this.worker = null; this.mode = 'starting'; this.queue = []; this.seq = 0; this.handlers = {};
        this.inlineDet = null; this.current = null;
        this._boot();
    }

    Engine.prototype._boot = function () {
        var self = this;
        if (typeof root.Worker !== 'function' || typeof root.Blob !== 'function' || !root.URL || !root.URL.createObjectURL) return this._inline();
        var texts = [], k = 0;
        (function next() {
            if (k >= SCRIPTS.length) return build();
            readText(SCRIPTS[k], function (err, t) {
                if (err) return self._inline();
                texts.push(t); k++; next();
            });
        })();
        function build() {
            try {
                var src = 'var window = undefined;\n' + texts.join('\n;\n') + '\n;(' + workerMain.toString() + ')();';
                var url = root.URL.createObjectURL(new root.Blob([src], { type: 'application/javascript' }));
                var w = new root.Worker(url);
                var ok = false;
                w.onmessage = function (e) {
                    var m = e.data;
                    if (m.type === 'pong') { ok = true; self.worker = w; self.mode = 'worker'; self._flush(); return; }
                    var h = self.handlers[m.id];
                    if (h) h(m);
                };
                w.onerror = function (ev) {
                    if (ev && ev.preventDefault) ev.preventDefault();
                    if (!ok) { try { w.terminate(); } catch (e) {} self._inline(); }
                };
                w.postMessage({ type: 'ping' });
                setTimeout(function () { if (!ok && self.mode === 'starting') { try { w.terminate(); } catch (e) {} self._inline(); } }, 8000);
            } catch (e) { self._inline(); }
        }
    };

    Engine.prototype._inline = function () {
        if (this.mode === 'inline') return;
        this.worker = null; this.mode = 'inline';
        this._flush();
    };

    Engine.prototype._flush = function () {
        var q = this.queue; this.queue = [];
        for (var i = 0; i < q.length; i++) q[i]();
    };

    Engine.prototype._when = function (fn) {
        if (this.mode === 'starting') this.queue.push(fn); else fn();
    };

    function sendable(img) {
        var copy = new Uint8ClampedArray(img.data);   // the panel keeps its own copy for drawing
        return { msg: { width: img.width, height: img.height, buffer: copy.buffer }, transfer: [copy.buffer] };
    }

    Engine.prototype.detect = function (img, opts, cb) {
        var self = this;
        this._when(function () {
            if (self.mode !== 'worker') {
                try {
                    if (!self.inlineDet) self.inlineDet = new root.DalaYuNet.Detector(root.DalaYuNetModel);
                    var faces = self.inlineDet.detect(img, opts);
                    return setTimeout(function () { cb(null, faces); }, 0);
                } catch (e) { return cb(e); }
            }
            var id = ++self.seq, s = sendable(img);
            self.handlers[id] = function (m) {
                delete self.handlers[id];
                if (m.type === 'error') cb(new Error(m.message)); else cb(null, m.faces);
            };
            self.worker.postMessage({ type: 'detect', id: id, img: s.msg, opts: opts }, s.transfer);
        });
    };

    Engine.prototype.track = function (job, cb) {
        var self = this;
        this._when(function () {
            if (self.mode !== 'worker') {
                if (!self.inlineDet) self.inlineDet = new root.DalaYuNet.Detector(root.DalaYuNetModel);
                return root.DalaFeatureTrack.trackShot({
                    count: job.count, seedIndex: job.seedIndex, seed: job.seed, opts: job.opts,
                    detector: job.seed.kind === 'face' ? self.inlineDet : null,
                    getFrame: job.getFrame, isCancelled: job.isCancelled, onProgress: job.onProgress
                }, cb);
            }
            var id = ++self.seq, finished = false;
            self.current = id;
            self.handlers[id] = function (m) {
                if (finished) return;
                if (job.isCancelled && job.isCancelled()) { self.worker.postMessage({ type: 'cancel', id: id }); }
                if (m.type === 'need') {
                    job.getFrame(m.i, function (err, img) {
                        if (finished) return;
                        if (err) return self.worker.postMessage({ type: 'frame', id: id, i: m.i, err: String(err.message || err) });
                        var s = sendable(img);
                        self.worker.postMessage({ type: 'frame', id: id, i: m.i, img: s.msg }, s.transfer);
                    });
                } else if (m.type === 'progress') {
                    if (job.onProgress) job.onProgress(m.done, m.total, m.last);
                } else {
                    finished = true; delete self.handlers[id]; self.current = null;
                    if (m.type === 'error') cb(new Error(m.message)); else cb(null, { frames: m.frames, feature: m.feature });
                }
            };
            self.worker.postMessage({ type: 'track', id: id, job: { count: job.count, seedIndex: job.seedIndex, seed: job.seed, opts: job.opts } });
        });
    };

    Engine.prototype.cancel = function () {
        if (this.worker && this.current) this.worker.postMessage({ type: 'cancel', id: this.current });
    };

    var shared = null;
    root.DalaTrackEngine = {
        get: function () { return shared || (shared = new Engine()); },
        Engine: Engine
    };
})(window);
