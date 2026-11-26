/**
 * Dala Suite - Auto Tracker: feature-region point tracker (ES5)
 *
 * Reproduces the manual head-tracking workflow (Tracker panel > Stabilize Motion, track point on the
 * nose, Analyze, Apply X and Y): one track point whose feature region is a medium block of the
 * face centred on the nose, matched in every frame by zero-mean
 * normalised cross-correlation (ZNCC, the measure After Effects' tracker reports as Confidence) with
 * sub-pixel positioning, and "Adapt Feature if Confidence is below 80%" like After Effects' default.
 * The track point is the attach point: it is applied without averaging, so the nose stays locked.
 *
 * On top of what a manual tracker does:
 *  - the search window is centred on a constant-velocity prediction and searched coarse to fine,
 *    so fast head moves do not escape the search region
 *  - when the match falls apart (occlusion, a turn away), YuNet re-finds the face near the
 *    prediction and the feature region is re-seeded on its nose
 *  - every few frames YuNet checks the point is still on the face; a point that slid off the face
 *    (to hair, a collar, the background) is re-seeded instead of being followed
 *
 * Images: gray { w, h, d: Float32Array }.
 */
(function (root) {
    'use strict';

    var V = root.DalaVision;

    // ------------------------------------------------------------------ image helpers

    function Integral(g) {
        var w = g.w, h = g.h, W = w + 1, s = new Float64Array(W * (h + 1)), q = new Float64Array(W * (h + 1)), x, y;
        for (y = 0; y < h; y++) {
            var rs = 0, rq = 0, r = y * w, o = (y + 1) * W;
            for (x = 0; x < w; x++) {
                var v = g.d[r + x];
                rs += v; rq += v * v;
                s[o + x + 1] = s[o - W + x + 1] + rs;
                q[o + x + 1] = q[o - W + x + 1] + rq;
            }
        }
        this.s = s; this.q = q; this.W = W;
    }
    Integral.prototype.sums = function (x0, y0, w, h) {
        var W = this.W, a = y0 * W + x0, b = a + w, c = a + h * W, d = c + w;
        return { s: this.s[d] - this.s[b] - this.s[c] + this.s[a], q: this.q[d] - this.q[b] - this.q[c] + this.q[a] };
    };

    /** Level k of a frame: gray + integral image (built lazily). */
    function Frame(gray, levels) {
        this.lv = [gray];
        for (var k = 1; k < levels; k++) {
            var p = this.lv[k - 1];
            if (p.w < 24 || p.h < 24) break;
            this.lv.push(V.pyrDown(p));
        }
        this.ii = [];
    }
    Frame.prototype.integral = function (k) {
        if (!this.ii[k]) this.ii[k] = new Integral(this.lv[k]);
        return this.ii[k];
    };

    function bilinear(g, x, y) {
        if (x < 0) x = 0; if (y < 0) y = 0;
        if (x > g.w - 1.001) x = g.w - 1.001; if (y > g.h - 1.001) y = g.h - 1.001;
        var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * g.w + x0, d = g.d;
        return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.w] * (1 - fx) + d[i + g.w + 1] * fx) * fy;
    }

    /**
     * Template = the feature region centred on (cx, cy) (level-0 pixels), at every pyramid level,
     * zero-mean with its norm, sampled at the exact sub-pixel centre.
     */
    function makeTemplate(frame, cx, cy, fw, fh) {
        var t = { cx: cx, cy: cy, fw: fw, fh: fh, lv: [] }, k;
        for (k = 0; k < frame.lv.length; k++) {
            var g = frame.lv[k], sc = Math.pow(0.5, k);
            var tw = Math.max(5, Math.round(fw * sc) | 1), th = Math.max(5, Math.round(fh * sc) | 1);
            if (k > 0 && (tw < 9 || th < 9)) break;
            var x0 = cx * sc - (tw - 1) / 2, y0 = cy * sc - (th - 1) / 2, n = tw * th;
            var d = new Float32Array(n), x, y, m = 0;
            for (y = 0; y < th; y++) for (x = 0; x < tw; x++) { var v = bilinear(g, x0 + x, y0 + y); d[y * tw + x] = v; m += v; }
            m /= n;
            var nn = 0;
            for (x = 0; x < n; x++) { d[x] -= m; nn += d[x] * d[x]; }
            t.lv.push({ w: tw, h: th, d: d, norm: Math.sqrt(nn), flat: nn / n < 4 });
        }
        return t;
    }

    /** ZNCC of template level T with frame level k at integer top-left (x0, y0). */
    function zncc(frame, k, T, x0, y0) {
        var g = frame.lv[k];
        if (x0 < 0 || y0 < 0 || x0 + T.w > g.w || y0 + T.h > g.h) return -2;
        var ii = frame.integral(k), st = ii.sums(x0, y0, T.w, T.h), n = T.w * T.h;
        var varI = st.q - st.s * st.s / n;
        if (varI < 1e-6 || T.norm < 1e-6) return -2;
        var cross = 0, d = g.d, td = T.d, x, y;
        for (y = 0; y < T.h; y++) {
            var r = (y0 + y) * g.w + x0, tr = y * T.w;
            for (x = 0; x < T.w; x++) cross += td[tr + x] * d[r + x];
        }
        return cross / (T.norm * Math.sqrt(varI));
    }

    function parabola(a, b, c) {
        var den = a - 2 * b + c;
        if (den >= -1e-9) return 0;
        var o = 0.5 * (a - c) / den;
        return o < -0.5 ? -0.5 : (o > 0.5 ? 0.5 : o);
    }

    /**
     * Finds template `tpl` in `frame` around (px, py) within `radius` (level-0 px), coarse to fine.
     * Returns { x, y (sub-pixel centre, level 0), conf (ZNCC) }.
     */
    function match(frame, tpl, px, py, radius, penalty) {
        var top = Math.min(tpl.lv.length, frame.lv.length) - 1, k = top;
        // coarsest level that still has a usable template, but no coarser than needed for the radius
        while (k > 0 && radius * Math.pow(0.5, k - 1) <= 6) k--;
        var sc = Math.pow(0.5, k), T = tpl.lv[k];
        var cx = px * sc, cy = py * sc, r = Math.ceil(radius * sc) + 1;
        var bx = Math.round(cx - (T.w - 1) / 2), by = Math.round(cy - (T.h - 1) / 2), best = -3, bi = bx, bj = by, i, j, v;
        // a look-alike far from the prediction must match clearly better than the patch near it
        // (a manual track point only searches next to where it was)
        var top0 = -9;
        for (j = by - r; j <= by + r; j++) for (i = bx - r; i <= bx + r; i++) {
            v = zncc(frame, k, T, i, j);
            var dd = ((i - bx) * (i - bx) + (j - by) * (j - by)) / (r * r), sc = v - (penalty == null ? 0.3 : penalty) * dd;
            if (sc > top0) { top0 = sc; best = v; bi = i; bj = j; }
        }
        // refine level by level
        for (var L = k - 1; L >= 0; L--) {
            var Tl = tpl.lv[L], Tu = tpl.lv[L + 1];
            var ccx = (bi + (Tu.w - 1) / 2) * 2, ccy = (bj + (Tu.h - 1) / 2) * 2;
            var sx = Math.round(ccx - (Tl.w - 1) / 2), sy = Math.round(ccy - (Tl.h - 1) / 2);
            best = -3; bi = sx; bj = sy;
            for (j = sy - 2; j <= sy + 2; j++) for (i = sx - 2; i <= sx + 2; i++) {
                v = zncc(frame, L, Tl, i, j);
                if (v > best) { best = v; bi = i; bj = j; }
            }
        }
        var T0 = tpl.lv[0];
        if (k === 0 && best < -1) return { x: px, y: py, conf: -1 };
        // sub-pixel: parabola through the neighbours on each axis
        var c0 = best;
        var ox = parabola(zncc(frame, 0, T0, bi - 1, bj), c0, zncc(frame, 0, T0, bi + 1, bj));
        var oy = parabola(zncc(frame, 0, T0, bi, bj - 1), c0, zncc(frame, 0, T0, bi, bj + 1));
        return { x: bi + (T0.w - 1) / 2 + ox, y: bj + (T0.h - 1) / 2 + oy, conf: c0 };
    }

    // ------------------------------------------------------------------ shot driver

    /**
     * job: {
     *   count, seedIndex, seed: { kind:'face'|'point', box:{x,y,w,h}, kps? (face landmarks) },
     *   getFrame(i, cb(err, img RGBA)), detector (DalaYuNet.Detector, faces only),
     *   opts: { feature (0.5 face widths), adapt (0.8), lost (0.45), detectEvery (12), levels }, onProgress(done, total, last), isCancelled()
     * }
     * done(err, { frames: [{ x, y (track point), bx, by (box centre), w, h, conf, src } | null] })
     * For faces the track point is the nose tip (YuNet landmark 2), for points the clicked centre.
     */
    function trackShot(job, done) {
        var TC = root.DalaTrackCore;
        var N = job.count, opts = job.opts || {}, res = new Array(N);
        var adaptBelow = opts.adapt != null ? opts.adapt : 0.8, lostBelow = opts.lost != null ? opts.lost : 0.45;
        var checkEvery = Math.max(4, opts.detectEvery || 12), levels = opts.levels || 4;
        var damp = opts.damp != null ? opts.damp : 0.8, penalty = opts.penalty != null ? opts.penalty : 0.3;
        var isFace = job.seed.kind === 'face' && !!job.detector;
        var processed = 0, total = Math.max(1, N - 1);

        // feature region: face -> a medium block centred on the nose (nose, inner eyes, upper lip):
        // big enough to lock well, small enough to stay on the face when the head turns and to
        // track fast; point -> its box
        var featureSize = opts.feature || 0.5;
        function regionFor(box, kps) {
            if (job.seed.kind === 'face' && kps && kps.length >= 6) {
                var fs = Math.max(13, box.w * featureSize);
                return { cx: kps[4], cy: kps[5], fw: fs, fh: fs * 1.15,
                         // where the face box sits relative to the nose (overlay / detector search)
                         bdx: box.x + box.w / 2 - kps[4], bdy: box.y + box.h / 2 - kps[5], bw: box.w, bh: box.h };
            }
            return { cx: box.x + box.w / 2, cy: box.y + box.h / 2, fw: Math.max(9, box.w), fh: Math.max(9, box.h), bdx: 0, bdy: 0, bw: box.w, bh: box.h };
        }
        var seedReg = regionFor(job.seed.box, job.seed.kps);

        function outAt(x, y, reg, conf, src) {
            return { x: x, y: y, bx: x + reg.bdx, by: y + reg.bdy, w: reg.bw, h: reg.bh, conf: conf, src: src };
        }

        function report(i) {
            processed++;
            if (job.onProgress) {
                var r = res[i];
                job.onProgress(processed, total, r ? { i: i, x: r.x, y: r.y, bx: r.bx, by: r.by, w: r.w, h: r.h, src: r.src } : { i: i, lost: true });
            }
        }

        function frameOf(img) { return new Frame(V.grayFromRGBA(img), levels); }

        /**
         * One direction from the seed. The output point is the template centre plus an attach offset,
         * like a manual track point's attach point: re-templating (the face grew / shrank) and
         * re-anchoring on a better feature never make it jump. It only jumps back onto the face when
         * the point was lost or demonstrably slid off it - and the frames in between are dropped so
         * the correction is interpolated instead of popping.
         */
        function pass(dir, seedFrame, cb) {
            var reg = { cx: seedReg.cx, cy: seedReg.cy, fw: seedReg.fw, fh: seedReg.fh, bdx: seedReg.bdx, bdy: seedReg.bdy, bw: seedReg.bw, bh: seedReg.bh };
            var tpl = makeTemplate(seedFrame, reg.cx, reg.cy, reg.fw, reg.fh);
            var x = reg.cx, y = reg.cy, ax = 0, ay = 0, vx = 0, vy = 0, lost = 0, sinceCheck = 0, i = job.seedIndex;
            // where the tracked face point sits relative to the detected nose, in face widths
            // (0 at the seed: the point starts on the nose); learnt again from the first check
            var rel = null, slid = 0, lastGood = job.seedIndex, adapted = false, prevFrame = seedFrame;
            step();
            function step() {
                i += dir;
                if (i < 0 || i >= N) return cb(null);
                if (job.isCancelled && job.isCancelled()) return cb(new Error('cancelled'));
                job.getFrame(i, function (err, img) {
                    if (err) return cb(err);
                    var fr = frameOf(img);
                    var px = x + vx, py = y + vy;
                    // search radius: the feature-to-search margin of a manual track point, grown with
                    // the current speed and after losses
                    var radius = Math.max(0.35 * Math.min(reg.fw, reg.fh), 1.5 * Math.sqrt(vx * vx + vy * vy) + 4) * (1 + Math.min(lost, 6) * 0.5);
                    var m = match(fr, tpl, px, py, radius, penalty), src = 'track';
                    if (m.conf < adaptBelow + (opts.marginal != null ? opts.marginal : 0.06) && prevFrame) {
                        // a marginal match (the face turned / changed since the feature was taken) can
                        // settle on a look-alike a few pixels off. Cross-check with the patch at the
                        // previous position in the previous frame - consecutive frames look alike, so
                        // that match is reliable over one frame - and follow it when the two disagree
                        var m2 = match(fr, makeTemplate(prevFrame, x, y, reg.fw, reg.fh), px, py, radius, penalty);
                        if (m2.conf >= lostBelow && (m2.conf > m.conf + 0.02 || Math.sqrt(Math.pow(m2.x - m.x, 2) + Math.pow(m2.y - m.y, 2)) > 1)) {
                            m = { x: m2.x, y: m2.y, conf: Math.min(m.conf, adaptBelow - 1e-3) };   // adapt there
                        }
                    }
                    prevFrame = fr;
                    if (m.conf >= lostBelow) {
                        // damp the prediction so a single wrong match cannot run away
                        vx = (m.x - x) * damp; vy = (m.y - y) * damp;
                        x = m.x; y = m.y; lost = 0;
                        if (m.conf < adaptBelow) { tpl = makeTemplate(fr, x, y, reg.fw, reg.fh); src = 'adapt'; adapted = true; }
                    } else {
                        lost++; src = null;
                    }

                    // face: re-acquire when lost, and every few frames check the point is still on the face
                    if (isFace) {
                        sinceCheck++;
                        if (lost > 0 || sinceCheck >= checkEvery) {
                            sinceCheck = 0;
                            var ox = x + ax, oy = y + ay;
                            var pred = { x: ox + reg.bdx - reg.bw / 2, y: oy + reg.bdy - reg.bh / 2, w: reg.bw, h: reg.bh };
                            var det = TC.findFace(job.detector, img, pred, lost > 0 ? Math.min(4, 1 + lost * 0.3) : 1, opts);
                            if (det && det.kps && det.kps.length >= 6) {
                                var nx = det.kps[4], ny = det.kps[5], fw = Math.max(8, det.w);
                                var r = { x: (ox - nx) / fw, y: (oy - ny) / fw };
                                if (lost > 0) {
                                    // lost: re-find the same face point from the detected nose
                                    var rr = rel || { x: 0, y: 0 };
                                    reseed(fr, det, rr.x * fw, rr.y * fw);
                                    src = 'det'; lastGood = i; slid = 0; adapted = false;
                                } else if (!rel) {
                                    rel = r; slid = 0; lastGood = i; adapted = false;
                                } else if (adapted && Math.sqrt(Math.pow(r.x - rel.x, 2) + Math.pow(r.y - rel.y, 2)) > 0.3) {
                                    // the point moves differently from the face. Only possible after the
                                    // feature was adapted (a template that kept matching well is still on the
                                    // same spot - then the landmark is what moved); confirmed on the next check
                                    if (++slid >= 2) {
                                        reseed(fr, det, rel.x * fw, rel.y * fw);
                                        // the frames since the last good check followed the wrong thing
                                        for (var q = lastGood + dir; q !== i; q += dir) res[q] = null;
                                        src = 'det'; slid = 0; lastGood = i; adapted = false;
                                    }
                                    sinceCheck = checkEvery - 3;   // check again soon
                                } else {
                                    slid = 0; lastGood = i; adapted = false;
                                    // follow slow changes of the face point / landmark drift
                                    rel = { x: rel.x * 0.8 + r.x * 0.2, y: rel.y * 0.8 + r.y * 0.2 };
                                    var grown = det.w / reg.bw;
                                    if (grown < 0.75 || grown > 1.33) {
                                        // the face changed size: same point, feature region resized with it
                                        reg.fw *= grown; reg.fh *= grown; reg.bw = det.w; reg.bh = det.h;
                                        reg.bdx = det.x + det.w / 2 - ox; reg.bdy = det.y + det.h / 2 - oy;
                                        tpl = makeTemplate(fr, x, y, reg.fw, reg.fh);
                                        src = 'adapt';
                                    }
                                }
                            }
                        }
                    }

                    res[i] = src ? outAt(x + ax, y + ay, reg, m.conf, src) : null;
                    report(i);
                    if (processed % 2 === 0 && typeof setTimeout === 'function' && !job.sync) setTimeout(step, 0); else step();
                });
            }
            // new feature region on the detected nose; the output point = nose + (offX, offY)
            function reseed(fr, det, offX, offY) {
                reg = regionFor(det, det.kps);
                reg.bdx -= offX; reg.bdy -= offY;
                tpl = makeTemplate(fr, reg.cx, reg.cy, reg.fw, reg.fh);
                x = reg.cx; y = reg.cy; ax = offX; ay = offY; vx = 0; vy = 0; lost = 0;
                sinceCheck = checkEvery - 3;   // confirm soon
            }
        }

        job.getFrame(job.seedIndex, function (err, img) {
            if (err) return done(err);
            var seedFrame = frameOf(img);
            res[job.seedIndex] = outAt(seedReg.cx, seedReg.cy, seedReg, 1, 'seed');
            pass(1, seedFrame, function (err1) {
                if (err1) return done(err1);
                pass(-1, seedFrame, function (err2) {
                    if (err2) return done(err2);
                    done(null, { frames: res, feature: { w: seedReg.fw, h: seedReg.fh } });
                });
            });
        });
    }

    var api = { trackShot: trackShot, match: match, makeTemplate: makeTemplate, Frame: Frame, zncc: zncc };
    root.DalaFeatureTrack = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
