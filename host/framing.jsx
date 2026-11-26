/**
 * Dala Suite - Auto Tracker framing (ECMAScript 3; also loaded by the Node test harness)
 *
 * Decides, for one tracked shot, the layer scale and where the subject lands in the comp on
 * every frame:
 *   1. target  - the subject (face / point) goes to the exact comp centre (the central
 *                intersection of the Proportional Grid) on the followed axes
 *   2. zoom    - per frame, the smallest scale (>= cover) at which the picture area still fills
 *                the comp with the subject at that centre. It follows the subject (more zoom when
 *                the subject nears an edge of the picture, less when it is central), is eased so
 *                it never pumps (a slow envelope that only rises ahead of the need), is held
 *                constant when it would barely change, and is capped at maxZoom x cover
 *   3. clamp   - per frame, the target is moved just enough that the picture area (inside any
 *                letterbox / pillarbox bars) still covers the whole comp, so bars or empty
 *                (black) comp areas never show; only happens past the maxZoom cap. `allow` lets a
 *                small mirrored edge through when Motion Tile is on and the edge is real picture
 *
 * In:  trk [[frame, x, y], ...] subject in layer (source) pixels, smoothed, one entry per frame
 *      geo { compW, compH, srcW, srcH, fxp (layer/comp pixel aspect), act {x0,y0,x1,y1}, baseScale, rotDeg }
 *      opts { axis 'xy'|'x'|'y', centerY (bool), zoom 'auto'|'off', maxZoom, mirror (bool), allow,
 *             vTarget, fps, ease (seconds, zoom envelope), hold (relative change kept constant) }
 * Out: { scale (largest), scales [per frame], dynamic, cover, target: [[tx, ty], ...] (comp px,
 *        per frame), clampedFrames, subject {mx, my} }
 */
if (typeof $ === "undefined") { $ = {}; }
if (typeof $._dalaSuite === "undefined") { $._dalaSuite = {}; }

$._dalaSuite.framing = (function () {

    // running maximum over [k - r, k + r]
    function maxFilter(a, r) {
        var out = [], n = a.length, i, j;
        for (i = 0; i < n; i++) {
            var m = a[i];
            for (j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) if (a[j] > m) m = a[j];
            out.push(m);
        }
        return out;
    }

    // Gaussian blur with edge renormalisation
    function blur(a, sigma) {
        var n = a.length, out = [], r = Math.ceil(sigma * 3), i, j;
        if (sigma < 0.3 || n < 3) return a.slice();
        var w = [];
        for (j = -r; j <= r; j++) w.push(Math.exp(-(j * j) / (2 * sigma * sigma)));
        for (i = 0; i < n; i++) {
            var s = 0, ws = 0;
            for (j = -r; j <= r; j++) {
                var k = i + j;
                if (k < 0 || k >= n) continue;
                s += a[k] * w[j + r]; ws += w[j + r];
            }
            out.push(s / ws);
        }
        return out;
    }

    function solve(trk, geo, opts) {
        opts = opts || {};
        var W = geo.compW, H = geo.compH, fx = geo.fxp || 1, act = geo.act;
        var aW = act.x1 - act.x0, aH = act.y1 - act.y0, n = trk.length, i;
        var followX = opts.axis !== "y", followY = opts.axis !== "x";
        var centerY = opts.centerY !== false;
        var vT = (opts.vTarget != null ? opts.vTarget : 0.5) * H;
        var fps = opts.fps || 25;

        // smallest scale at which the picture area covers the comp
        var cover = Math.max(W / (aW * fx), H / aH);
        var rad = Math.abs(geo.rotDeg || 0) * Math.PI / 180;
        if (rad > 1e-4) {   // rotated layers need more to cover the corners
            var c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
            cover *= Math.max(c + (H / W) * s, c + (W / H) * s);
        }
        var base = Math.max(cover, geo.baseScale || 0);

        var mx = 0, my = 0;
        for (i = 0; i < n; i++) { mx += trk[i][1]; my += trk[i][2]; }
        mx /= n; my /= n;
        // subject position used per axis (a non-followed axis is held at the shot average)
        function px(k) { return followX ? trk[k][1] : mx; }
        function py(k) { return followY ? trk[k][2] : my; }

        // allowed uncovered edge per side (only real picture can be mirrored; never bars)
        var allow = opts.mirror ? (opts.allow != null ? opts.allow : 0.04) : 0;
        var barsX = act.x0 > 0.5 || act.x1 < geo.srcW - 0.5, barsY = act.y0 > 0.5 || act.y1 < geo.srcH - 0.5;
        var ax = barsX ? 0 : allow * W, ay = barsY ? 0 : allow * H;

        // vertical target before clamping
        function wantY(sc) {
            if (centerY) return vT;
            // natural height: keep the subject's average height of a centred full frame
            return H / 2 + (my - (act.y0 + act.y1) / 2) * sc;
        }

        // scale needed so the wanted target is reachable on frame k (each side of each axis)
        function needAt(k) {
            var need = 0, x = px(k), y = py(k), tx = W / 2, ty = vT, d;
            // left edge: tx - (x - x0) * s * fx <= ax  ->  s >= (tx - ax) / ((x - x0) * fx)
            d = (x - act.x0) * fx; if (d > 0.5) need = Math.max(need, (tx - ax) / d); else need = 1e9;
            d = (act.x1 - x) * fx; if (d > 0.5) need = Math.max(need, (W - tx - ax) / d); else need = 1e9;
            if (centerY) {
                d = y - act.y0; if (d > 0.5) need = Math.max(need, (ty - ay) / d); else need = 1e9;
                d = act.y1 - y; if (d > 0.5) need = Math.max(need, (H - ty - ay) / d); else need = 1e9;
            } else if (followY) {
                // natural height: the layer moves by (y - my) * s around a centred frame
                d = aH / 2 - (my - y); if (d > 0.5) need = Math.max(need, (H / 2 - ay) / d); else need = 1e9;
                d = aH / 2 + (my - y); if (d > 0.5) need = Math.max(need, (H / 2 - ay) / d); else need = 1e9;
            }
            return need;
        }

        var scales = [], dynamic = false;
        if (opts.zoom !== "off") {
            var cap = base * (opts.maxZoom || 2.5), z = [];
            for (i = 0; i < n; i++) z.push(Math.min(cap, Math.max(base, needAt(i))));
            // ease: a running max (so the zoom is already there when the subject reaches an edge)
            // blurred over ~ease seconds, never below the per-frame need
            var ease = (opts.ease != null ? opts.ease : 0.6) * fps;
            var r = Math.max(1, Math.round(ease)), env = blur(maxFilter(z, r), r / 2);
            var lo = 1e9, hi = 0;
            for (i = 0; i < n; i++) {
                var v = Math.min(cap, Math.max(env[i], z[i]));
                scales.push(v);
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            // barely changing: one steady zoom for the shot (no visible breathing)
            if (hi / lo - 1 <= (opts.hold != null ? opts.hold : 0.06)) {
                for (i = 0; i < n; i++) scales[i] = hi;
            } else {
                dynamic = true;
            }
        } else {
            for (i = 0; i < n; i++) scales.push(base);
        }

        // targets, clamped so the picture always covers the comp
        var target = [], clamped = 0, top = 0;
        for (i = 0; i < n; i++) {
            var sc = scales[i], x = px(i), y = py(i), tx = W / 2, ty = wantY(sc);
            if (sc > top) top = sc;
            // picture left edge in comp = tx - (x - x0) * s * fx  must be <= ax
            var txMax = ax + (x - act.x0) * sc * fx, txMin = W - ax - (act.x1 - x) * sc * fx;
            var tyMax = ay + (y - act.y0) * sc, tyMin = H - ay - (act.y1 - y) * sc;
            var ox = tx, oy = ty;
            if (txMin <= txMax) { if (tx > txMax) tx = txMax; if (tx < txMin) tx = txMin; } else tx = (txMin + txMax) / 2;
            if (tyMin <= tyMax) { if (ty > tyMax) ty = tyMax; if (ty < tyMin) ty = tyMin; } else ty = (tyMin + tyMax) / 2;
            if (Math.abs(tx - ox) > 0.5 || Math.abs(ty - oy) > 0.5) clamped++;
            target.push([tx, ty]);
        }
        return { scale: top, scales: scales, dynamic: dynamic, cover: cover, target: target, clampedFrames: clamped, subject: { mx: mx, my: my } };
    }

    return { solve: solve };
})();

if (typeof module !== "undefined" && module.exports) module.exports = $._dalaSuite.framing;
