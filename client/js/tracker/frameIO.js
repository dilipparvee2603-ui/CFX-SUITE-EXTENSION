/**
 * Dala Suite - Auto Tracker frame loading (ES5)
 *
 * Reads the analysis PNGs After Effects renders and decodes them to RGBA pixels.
 * Order of file access methods (first one available wins):
 *   1. window.cep.fs      - built into every CEP panel (no Node.js needed)
 *   2. Node.js fs         - when the panel runs with Node enabled
 *   3. XMLHttpRequest     - browser preview / test harness (http:// paths)
 * Pixels are decoded through a data: URL, so the canvas is never tainted.
 */
(function (root) {
    'use strict';

    var nodeFs = null;
    try {
        if (typeof root.require === 'function') nodeFs = root.require('fs');
        else if (root.cep_node && typeof root.cep_node.require === 'function') nodeFs = root.cep_node.require('fs');
    } catch (e) { nodeFs = null; }

    function hasCepFs() {
        return !!(root.cep && root.cep.fs && typeof root.cep.fs.readFile === 'function' && root.cep.encoding);
    }

    function method() {
        if (hasCepFs()) return 'cep.fs';
        if (nodeFs) return 'node';
        return 'xhr';
    }

    function readBase64(path, cb) {
        var m = method();
        if (m === 'cep.fs') {
            var r = root.cep.fs.readFile(path, root.cep.encoding.Base64);
            if (r.err !== 0 || !r.data) return cb(new Error('read failed (' + r.err + ')'));
            return cb(null, r.data);
        }
        if (m === 'node') {
            try {
                if (!nodeFs.existsSync(path)) return cb(new Error('missing'));
                return cb(null, nodeFs.readFileSync(path).toString('base64'));
            } catch (e) { return cb(e); }
        }
        // browser preview: fetch as binary and base64-encode
        var xhr = new XMLHttpRequest();
        xhr.open('GET', path, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function () {
            if (xhr.status && xhr.status !== 200) return cb(new Error('HTTP ' + xhr.status));
            var bytes = new Uint8Array(xhr.response), bin = '', CH = 0x8000;
            for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            cb(null, root.btoa(bin));
        };
        xhr.onerror = function () { cb(new Error('missing')); };
        xhr.send();
    }

    var canvas = null, ctx = null;

    function decode(b64, cb) {
        var img = new root.Image();
        img.onload = function () {
            try {
                if (!canvas) { canvas = root.document.createElement('canvas'); ctx = canvas.getContext('2d'); }
                canvas.width = img.naturalWidth || img.width; canvas.height = img.naturalHeight || img.height;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                var id = ctx.getImageData(0, 0, canvas.width, canvas.height);
                cb(null, { width: id.width, height: id.height, data: id.data, url: img.src });
            } catch (e) { cb(e); }
        };
        img.onerror = function () { cb(new Error('decode failed')); };
        img.src = 'data:image/png;base64,' + b64;
    }

    /**
     * Loads one frame. After Effects may still be writing the file (saveFrameToPng finishes
     * asynchronously in recent versions), so missing / truncated files are retried for up to
     * opts.timeout ms (default 20 s).
     */
    function loadFrame(path, cb, opts) {
        opts = opts || {};
        var deadline = Date.now() + (opts.timeout || 20000), delay = 15;
        function attempt() {
            readBase64(path, function (err, b64) {
                if (err || !b64) return retry(err || new Error('empty'));
                decode(b64, function (err2, img) {
                    if (err2) return retry(err2);
                    cb(null, img);
                });
            });
        }
        function retry(err) {
            if (Date.now() > deadline) return cb(new Error('Frame not readable: ' + path + ' (' + (err && err.message) + ')'));
            setTimeout(attempt, delay);
            delay = Math.min(250, delay * 2);
        }
        attempt();
    }

    /** Small LRU so the picker / tracker do not decode the same PNG twice in a row. */
    function FrameCache(limit) { this.limit = limit || 12; this.keys = []; this.map = {}; }
    FrameCache.prototype.get = function (path, cb) {
        var self = this;
        if (this.map[path]) return cb(null, this.map[path]);
        loadFrame(path, function (err, img) {
            if (err) return cb(err);
            self.map[path] = img; self.keys.push(path);
            while (self.keys.length > self.limit) delete self.map[self.keys.shift()];
            cb(null, img);
        });
    };
    FrameCache.prototype.clear = function () { this.keys = []; this.map = {}; };

    var api = { loadFrame: loadFrame, FrameCache: FrameCache, method: method };
    root.DalaFrameIO = api;
})(typeof window !== 'undefined' ? window : this);
