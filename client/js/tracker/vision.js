/**
 * Dala Suite - Auto Tracker vision core (pure JavaScript, ES5)
 *
 *  - grayscale conversion and 2x downsampling (the tracker's pyramids: featureTrack.js)
 *  - shot-cut detection from per-frame colour/luma signatures
 *  - letterbox / pillarbox detection
 *  - track gap filling and Gaussian smoothing
 *
 * Images are { width, height, data } RGBA objects (canvas ImageData shape).
 * Gray images are { w, h, d: Float32Array }.
 */
(function (root) {
    'use strict';

    // ---------------------------------------------------------------- images

    function grayFromRGBA(img) {
        var n = img.width * img.height, d = new Float32Array(n), s = img.data, i, j;
        for (i = 0, j = 0; i < n; i++, j += 4) d[i] = 0.299 * s[j] + 0.587 * s[j + 1] + 0.114 * s[j + 2];
        return { w: img.width, h: img.height, d: d };
    }

    // 2x downsample with a [1 2 1] binomial blur (separable)
    function pyrDown(g) {
        var w = g.w, h = g.h, W = Math.max(1, w >> 1), H = Math.max(1, h >> 1), s = g.d;
        var tmp = new Float32Array(W * h), out = new Float32Array(W * H), x, y, xl, xr, yu, yd, sx;
        for (y = 0; y < h; y++) {
            var r = y * w;
            for (x = 0; x < W; x++) {
                sx = 2 * x; xl = sx > 0 ? sx - 1 : 0; xr = sx + 1 < w ? sx + 1 : w - 1;
                tmp[y * W + x] = (s[r + xl] + 2 * s[r + sx] + s[r + xr]) * 0.25;
            }
        }
        for (y = 0; y < H; y++) {
            var sy = 2 * y; yu = sy > 0 ? sy - 1 : 0; yd = sy + 1 < h ? sy + 1 : h - 1;
            for (x = 0; x < W; x++) out[y * W + x] = (tmp[yu * W + x] + 2 * tmp[sy * W + x] + tmp[yd * W + x]) * 0.25;
        }
        return { w: W, h: H, d: out };
    }

    function median(arr) {
        if (!arr.length) return NaN;
        var a = Array.prototype.slice.call(arr).sort(function (p, q) { return p - q; });
        var m = a.length >> 1;
        return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
    }

    // normalised cross-correlation of two (2r+1)^2 patches
    // ---------------------------------------------------------------- shot cuts

    /** A small per-frame signature: 8x8x8-ish RGB histogram (3 x 16 bins) + 24x14 luma thumbnail. */
    function frameSignature(img) {
        var w = img.width, h = img.height, s = img.data, hist = new Float32Array(48), TW = 24, TH = 14;
        var thumb = new Float32Array(TW * TH), cnt = new Float32Array(TW * TH), x, y, i, step = Math.max(1, Math.floor(Math.min(w, h) / 180));
        var n = 0;
        for (y = 0; y < h; y += step) {
            var ty = Math.min(TH - 1, Math.floor(y * TH / h));
            for (x = 0; x < w; x += step) {
                i = (y * w + x) * 4;
                var r = s[i], g = s[i + 1], b = s[i + 2];
                hist[r >> 4]++; hist[16 + (g >> 4)]++; hist[32 + (b >> 4)]++;
                var t = ty * TW + Math.min(TW - 1, Math.floor(x * TW / w));
                thumb[t] += 0.299 * r + 0.587 * g + 0.114 * b; cnt[t]++; n++;
            }
        }
        for (i = 0; i < 48; i++) hist[i] /= n;
        for (i = 0; i < thumb.length; i++) thumb[i] = cnt[i] ? thumb[i] / cnt[i] : 0;
        return { hist: hist, thumb: thumb };
    }

    /** 0..1-ish dissimilarity between two signatures. */
    function signatureDistance(a, b) {
        var hd = 0, td = 0, i, ma = 0, mb = 0;
        for (i = 0; i < 48; i++) hd += Math.abs(a.hist[i] - b.hist[i]);
        hd /= 6;   // three histograms, each with total variation <= 2
        for (i = 0; i < a.thumb.length; i++) { ma += a.thumb[i]; mb += b.thumb[i]; }
        ma /= a.thumb.length; mb /= b.thumb.length;
        // mean-removed thumbnail difference: ignores global brightness flicker
        for (i = 0; i < a.thumb.length; i++) td += Math.abs((a.thumb[i] - ma) - (b.thumb[i] - mb));
        td /= a.thumb.length * 64;
        return 0.5 * hd + 0.5 * Math.min(1, td);
    }

    /**
     * Picks cuts from consecutive-frame distances. dist[i] is the distance between frame i-1 and
     * frame i (dist[0] unused). A cut at i means a new shot starts at frame i. A cut needs a
     * high absolute score AND to stand out from its neighbourhood (so fast pans do not split).
     */
    function detectCuts(dist, opts) {
        opts = opts || {};
        var minShot = opts.minShot || 6, thr = opts.threshold || 0.28, ratio = opts.ratio || 3.0, win = opts.window || 6;
        var cuts = [], last = 0, i, j;
        for (i = 1; i < dist.length; i++) {
            if (dist[i] < thr) continue;
            var nb = [];
            for (j = Math.max(1, i - win); j <= Math.min(dist.length - 1, i + win); j++) if (j !== i) nb.push(dist[j]);
            var ref = Math.max(0.02, median(nb));
            if (dist[i] < ratio * ref) continue;
            // local maximum only
            if ((i > 1 && dist[i - 1] > dist[i]) || (i + 1 < dist.length && dist[i + 1] > dist[i])) continue;
            if (i - last < minShot) continue;
            if (dist.length - i < minShot) continue;
            cuts.push(i); last = i;
        }
        return cuts;
    }

    /**
     * Letterbox / pillarbox bars: counts the near-black, flat rows (top, bottom) and columns
     * (left, right) at the frame edges. Returns pixel counts in this image's resolution.
     * Measured on 80 letterboxed clips: bar pixels never exceed luma 4, while the darkest real
     * picture rows average 12.5 with texture - so a bar must be dark AND flat.
     */
    function letterbox(img) {
        var w = img.width, h = img.height, d = img.data, step = 2;
        function lum(i) { return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; }
        function darkRow(y) {
            var s = 0, m = 0, n = 0, x, v;
            for (x = 0; x < w; x += step) { v = lum((y * w + x) * 4); s += v; if (v > m) m = v; n++; }
            return s / n < 18 && m < 28 && m - s / n < 14;
        }
        function darkCol(x) {
            var s = 0, m = 0, n = 0, y, v;
            for (y = 0; y < h; y += step) { v = lum((y * w + x) * 4); s += v; if (v > m) m = v; n++; }
            return s / n < 18 && m < 28 && m - s / n < 14;
        }
        var top = 0, bottom = 0, left = 0, right = 0;
        while (top < h / 2 && darkRow(top)) top++;
        while (bottom < h / 2 && darkRow(h - 1 - bottom)) bottom++;
        while (left < w / 2 && darkCol(left)) left++;
        while (right < w / 2 && darkCol(w - 1 - right)) right++;
        return { top: top, bottom: bottom, left: left, right: right };
    }

    // ---------------------------------------------------------------- track post-processing

    /** Fills null gaps by linear interpolation (holds at the ends). pts: [{x,y}|null]. */
    function fillGaps(pts) {
        var n = pts.length, out = new Array(n), i, j, first = -1, last = -1;
        for (i = 0; i < n; i++) if (pts[i]) { if (first < 0) first = i; last = i; }
        if (first < 0) return null;
        for (i = 0; i < n; i++) {
            if (pts[i]) { out[i] = { x: pts[i].x, y: pts[i].y }; continue; }
            if (i < first) { out[i] = { x: pts[first].x, y: pts[first].y }; continue; }
            if (i > last) { out[i] = { x: pts[last].x, y: pts[last].y }; continue; }
            var a = i - 1; while (!pts[a]) a--;
            var b = i + 1; while (!pts[b]) b++;
            var t = (i - a) / (b - a);
            out[i] = { x: pts[a].x + (pts[b].x - pts[a].x) * t, y: pts[a].y + (pts[b].y - pts[a].y) * t };
        }
        return out;
    }

    /**
     * Median filter (radius medRadius, removes single-frame spikes) followed by a Gaussian-weighted
     * local quadratic fit (sigma in samples). Unlike a plain Gaussian blur this follows fast and
     * curving motion without lag or flattened peaks, and it needs no edge padding.
     */
    function smooth(vals, sigma, medRadius) {
        var n = vals.length, i, k, m = new Float64Array(n);
        medRadius = medRadius == null ? 1 : medRadius;
        for (i = 0; i < n; i++) {
            var win = [];
            for (k = -medRadius; k <= medRadius; k++) {
                var j = i + k; if (j < 0) j = 0; if (j >= n) j = n - 1;
                win.push(vals[j]);
            }
            m[i] = median(win);
        }
        if (!(sigma > 0.3) || n < 4) return Array.prototype.slice.call(m);
        var R = Math.ceil(3 * sigma), out = new Array(n);
        for (i = 0; i < n; i++) {
            // weighted least squares of v = a + b t + c t^2 around t = 0
            var s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, v0 = 0, v1 = 0, v2 = 0;
            for (k = -R; k <= R; k++) {
                var q = i + k;
                if (q < 0 || q >= n) continue;
                var wgt = Math.exp(-k * k / (2 * sigma * sigma)), t = k, t2 = t * t, v = m[q];
                s0 += wgt; s1 += wgt * t; s2 += wgt * t2; s3 += wgt * t2 * t; s4 += wgt * t2 * t2;
                v0 += wgt * v; v1 += wgt * v * t; v2 += wgt * v * t2;
            }
            // solve the 3x3 normal equations for a (Cramer's rule)
            var det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
            if (Math.abs(det) < 1e-9) { out[i] = m[i]; continue; }
            out[i] = (v0 * (s2 * s4 - s3 * s3) - s1 * (v1 * s4 - s3 * v2) + s2 * (v1 * s3 - s2 * v2)) / det;
        }
        return out;
    }

    var api = {
        grayFromRGBA: grayFromRGBA, pyrDown: pyrDown, median: median,
        frameSignature: frameSignature, signatureDistance: signatureDistance, detectCuts: detectCuts, letterbox: letterbox,
        fillGaps: fillGaps, smooth: smooth
    };
    root.DalaVision = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
