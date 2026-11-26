/**
 * Dala Suite - Auto Tracker: face helpers shared by the tracker (ES5)
 *
 * findFace: YuNet on a crop around a predicted face box (used by featureTrack.js to re-find a lost
 * face and to check the track point is still on it). The shot tracker itself is featureTrack.js.
 */
(function (root) {
    'use strict';

    var Y = root.DalaYuNet;

    function cropImage(img, x0, y0, w, h) {
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
        w = Math.min(img.width - x0, Math.ceil(w)); h = Math.min(img.height - y0, Math.ceil(h));
        if (w < 8 || h < 8) return null;
        var out = new Uint8ClampedArray(w * h * 4), y, s = img.data, rowLen = w * 4;
        for (y = 0; y < h; y++) {
            var si = ((y0 + y) * img.width + x0) * 4;
            out.set(s.subarray ? s.subarray(si, si + rowLen) : Array.prototype.slice.call(s, si, si + rowLen), y * rowLen);
        }
        return { width: w, height: h, data: out, ox: x0, oy: y0 };
    }

    function center(b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

    /** Looks for the tracked face near `pred`. `grow` (>=1) widens the search after losses. */
    function findFace(detector, img, pred, grow, opts) {
        var c = center(pred), side = Math.max(pred.w, pred.h) * (2.4 * grow);
        var crop = cropImage(img, c.x - side / 2, c.y - side / 2, side, side);
        if (!crop) return null;
        // scale so the face is ~64 px in the network input (YuNet is accurate there and it is cheap);
        // never upscale the crop
        var cropMax = Math.max(crop.width, crop.height);
        var want = cropMax * 64 / Math.max(8, pred.w);
        var maxSide = Math.round(Math.max(Math.min(96, cropMax), Math.min(cropMax, opts.maxDetectSide || 640, want)));
        var dets = detector.detect(crop, { maxSide: maxSide, scoreThreshold: opts.detectThreshold || 0.5 });
        var best = null, bestScore = 0, i;
        for (i = 0; i < dets.length; i++) {
            var d = dets[i], box = { x: d.x + crop.ox, y: d.y + crop.oy, w: d.w, h: d.h };
            if (d.kps) { box.kps = []; for (var q = 0; q < d.kps.length; q += 2) box.kps.push(d.kps[q] + crop.ox, d.kps[q + 1] + crop.oy); }
            var ratio = box.w / pred.w;
            if (ratio < 0.6 || ratio > 1.6) continue;
            var ov = Y.iou(box, pred);
            var dc = center(box), dist = Math.sqrt(Math.pow(dc.x - c.x, 2) + Math.pow(dc.y - c.y, 2)) / pred.w;
            // prefer overlap; when lost (grow > 1) accept nearby faces of the right size
            var score = ov > 0 ? ov + 0.5 : (grow > 1 && dist < 0.9 * grow ? 0.5 - dist / (2 * grow) : 0);
            if (score > bestScore) { bestScore = score; best = box; best.score = d.score; }
        }
        return best;
    }

    var api = { findFace: findFace, cropImage: cropImage };
    root.DalaTrackCore = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
