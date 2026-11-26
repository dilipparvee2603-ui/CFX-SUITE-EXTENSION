/**
 * Dala Suite - GENERAL > Curves (ES5): a graph editor for the ease between keyframes + a library of eases.
 * The curve is a cubic bezier b = [x1, y1, x2, y2] from (0, 0) to (1, 1), like CSS cubic-bezier(). After
 * Effects stores the same ease as influence (how far the handle reaches, % of the time) and speed (the slope
 * at the keyframe): influence = x * 100, speed = slope x the average speed between the two keyframes.
 * The host side is $._dalaSuite.edit.curveRead / curveApply (host/editTools.jsx).
 *
 * Graph: drag a handle (Ctrl: 10x finer, Shift: flat). Value graph (default) or Speed graph like AE's:
 * there sideways = influence, Alt + up / down = speed, and the curve itself can be dragged. Scroll to zoom
 * (Ctrl: time axis, Shift: value axis), drag the empty space to move, double-click it to fit. Double-click a
 * handle to type its influence and speed; click the numbers to type all four.
 *   DalaCurves.render(box, api)    api: { host(call, cb), q(obj), say(msg, type), pop(anchor, html, bind), closePop() }
 *   DalaCurves.stop()              (stops the preview animation when the view is left)
 */
(function (root) {
    'use strict';

    var PRESETS = [
        ['Linear', [0, 0, 1, 1]], ['Easy Ease', [0.33, 0, 0.67, 1]], ['Ease In', [0.42, 0, 1, 1]], ['Ease Out', [0, 0, 0.58, 1]],
        ['Smooth', [0.65, 0, 0.35, 1]], ['Strong', [0.83, 0, 0.17, 1]], ['Expo In', [0.7, 0, 0.84, 0]], ['Expo Out', [0.16, 1, 0.3, 1]],
        ['Quart Out', [0.25, 1, 0.5, 1]], ['Back Out', [0.34, 1.56, 0.64, 1]], ['Back In', [0.36, 0, 0.66, -0.56]]
    ];
    var NS = 'http://www.w3.org/2000/svg';

    var store = {
        get: function (k, d) { try { var v = root.localStorage.getItem('dala.curves.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
        set: function (k, v) { try { root.localStorage.setItem('dala.curves.' + k, JSON.stringify(v)); } catch (e) {} }
    };

    var api = null, box = null;
    var ed = store.get('editor', { b: [0.33, 0, 0.67, 1], name: 'Easy Ease' });
    if (!ed || !ed.b || ed.b.length !== 4) ed = { b: [0.33, 0, 0.67, 1], name: 'Easy Ease' };
    var mode = store.get('mode', 'value'), down = store.get('down', false), live = store.get('live', false);
    var view = null, userView = false, drag = -1, raf = 0, t0 = 0, keyRead = null, lastDown = {};

    function $(sel, el) { return (el || box).querySelector(sel); }
    function $$(sel, el) { return Array.prototype.slice.call((el || box).querySelectorAll(sel)); }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function r4(v) { return Math.round(v * 10000) / 10000; }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function fmtN(n) { var a = Math.abs(n); return String(a >= 100 ? Math.round(n) : a >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100); }
    function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
    function saveEd() { store.set('editor', { b: ed.b, name: ed.name }); }
    function fy(y) { return down ? 1 - y : y; }

    // ------------------------------------------------------------------ the maths

    function toAE(b) {
        return { outInf: Math.max(0.1, b[0] * 100), outRatio: b[0] > 0 ? b[1] / b[0] : 0, inInf: Math.max(0.1, (1 - b[2]) * 100), inRatio: b[2] < 1 ? (1 - b[3]) / (1 - b[2]) : 0 };
    }
    function fromAE(c) {
        var x1 = c.outInf / 100, x2 = 1 - c.inInf / 100;
        return [x1, Math.min(20, x1 * c.outRatio), x2, Math.max(-19, 1 - (c.inInf / 100) * c.inRatio)];
    }
    function bz(t, p1, p2) { return 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t; }
    function dbz(t, p1, p2) { return 3 * (1 - t) * (1 - t) * p1 + 6 * (1 - t) * t * (p2 - p1) + 3 * t * t * (1 - p2); }
    /** the eased value at time x (0..1) */
    function easeAt(b, x) {
        var lo = 0, hi = 1, t = x;
        for (var i = 0; i < 32; i++) { var v = bz(t, b[0], b[2]); if (Math.abs(v - x) < 1e-5) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
        return bz(t, b[1], b[3]);
    }
    /** the speed at each keyframe, relative to the average speed (1 = constant speed) */
    function speedsOf(b) { return [b[0] > 0.001 ? b[1] / b[0] : 0, b[2] < 0.999 ? (1 - b[3]) / (1 - b[2]) : 0]; }
    function speedSamples(b) {
        var out = [], s = speedsOf(b);
        for (var i = 0; i <= 400; i++) {
            var t = i / 400, dx = dbz(t, b[0], b[2]), dy = dbz(t, b[1], b[3]);
            out.push([bz(t, b[0], b[2]), dx > 1e-4 ? dy / dx : (dy >= 0 ? 50 : -50)]);
        }
        out[0][1] = s[0];
        out[out.length - 1][1] = s[1];
        return out;
    }
    function handlePts(b) {
        if (mode !== 'speed') return [[b[0], fy(b[1])], [b[2], fy(b[3])]];
        var s = speedsOf(b);
        return [[b[0], s[0]], [b[2], s[1]]];
    }
    function rangeFor(b) {
        if (mode === 'speed') {
            var ys = speedSamples(b).map(function (q) { return clamp(q[1], -6, 12); });
            var hi = Math.max.apply(null, [1.2].concat(ys)), lo = Math.min.apply(null, [0].concat(ys));
            return { x0: -0.05, x1: 1.05, y0: lo - (hi - lo) * 0.24, y1: hi + (hi - lo) * 0.1 };
        }
        var a = fy(b[1]), c = fy(b[3]);
        return { x0: -0.05, x1: 1.05, y0: Math.min(-0.1, a - 0.12, c - 0.12), y1: Math.max(1.1, a + 0.12, c + 0.12) };
    }
    function niceStep(span) { var s = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]; for (var i = 0; i < s.length; i++) if (span / s[i] <= 6) return s[i]; return 5; }
    function fmtSp(sp) { return ed.u && ed.u.avg ? fmtN(sp * ed.u.avg) + '/s' : fmtN(sp) + '×'; }
    /** a valley in the speed graph (fast at both keys) */
    function isValley(b) { var a = b[0] > 0.001 ? b[1] / b[0] : 99, z = b[2] < 0.999 ? (1 - b[3]) / (1 - b[2]) : 99; return a > 1.05 && z > 1.05; }
    /** the curve mirrored on its diagonal (its inverse): speeds become 1 / speed, a valley becomes a hill */
    function flipSpeed() {
        var b = ed.b, c = function (v) { return Math.round(clamp(v, 0, 1) * 1000) / 1000; };
        ed = { b: [c(b[1]), b[0], c(b[3]), b[2]], name: ed.name === 'Linear' ? 'Linear' : 'Custom', u: ed.u };
        saveEd();
    }

    // ------------------------------------------------------------------ drawing

    function draw() {
        var svg = $('#cvG');
        if (!svg) return;
        var rect = svg.getBoundingClientRect(), W = Math.max(60, rect.width || 300), H = Math.max(40, rect.height || 150), pad = 10;
        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        var v = view || (view = rangeFor(ed.b));
        function X(x) { return pad + (x - v.x0) / (v.x1 - v.x0) * (W - 2 * pad); }
        function Y(y) { return H - pad - (y - v.y0) / (v.y1 - v.y0) * (H - 2 * pad); }
        var b = ed.b, speed = mode === 'speed', hp = handlePts(b), sy = niceStep(v.y1 - v.y0), sx = niceStep(v.x1 - v.x0), x, y, h = [];
        // outside 0..1 in time is shaded
        h.push('<rect x="0" y="0" width="' + Math.max(0, X(0)) + '" height="' + H + '" class="cv-out"/><rect x="' + X(1) + '" y="0" width="' + Math.max(0, W - X(1)) + '" height="' + H + '" class="cv-out"/>');
        for (y = Math.ceil(v.y0 / sy) * sy; y <= v.y1; y += sy) if (Math.abs(y) > 1e-6 && (speed || Math.abs(y - 1) > 1e-6)) h.push('<line x1="0" x2="' + W + '" y1="' + Y(y) + '" y2="' + Y(y) + '" class="cv-grid"/>');
        for (x = Math.max(0, Math.ceil(v.x0 / sx) * sx); x <= Math.min(1, v.x1); x += sx) if (x > 1e-6 && x < 1 - 1e-6) h.push('<line x1="' + X(x) + '" x2="' + X(x) + '" y1="0" y2="' + H + '" class="cv-grid"/>');
        // axis numbers, like After Effects: % of the change (value graph) or the speed; the time in frames once keys were read
        for (y = Math.ceil(v.y0 / sy) * sy; y <= v.y1 + 1e-9; y += sy) {
            var yy = Y(y);
            if (yy < 8 || yy > H - 12) continue;
            h.push('<text x="3" y="' + (yy - 2).toFixed(1) + '" class="cv-lbl">' + (speed ? fmtSp(y) : fmtN(fy(y) * 100) + '%') + '</text>');
        }
        for (x = Math.max(0, Math.ceil(v.x0 / sx) * sx); x <= Math.min(1, v.x1) + 1e-9; x += sx) {
            var xx = X(x);
            if (xx < 26 || xx > W - 18) continue;
            h.push('<text x="' + xx.toFixed(1) + '" y="' + (H - 2) + '" class="cv-lbl" text-anchor="middle">' + (ed.u && ed.u.frames ? fmtN(x * ed.u.frames) + 'f' : fmtN(x * 100) + '%') + '</text>');
        }
        if (speed) {
            var sm = speedSamples(b), d = sm.map(function (q, i) { return (i ? 'L' : 'M') + X(q[0]).toFixed(1) + ' ' + Y(clamp(q[1], v.y0 - 5, v.y1 + 5)).toFixed(1); }).join(' ');
            svg._samp = sm;
            h.push('<line x1="0" x2="' + W + '" y1="' + Y(0) + '" y2="' + Y(0) + '" class="cv-base"/><line x1="0" x2="' + W + '" y1="' + Y(1) + '" y2="' + Y(1) + '" class="cv-avg"/>');
            h.push('<line x1="' + X(0) + '" y1="' + Y(hp[0][1]) + '" x2="' + X(hp[0][0]) + '" y2="' + Y(hp[0][1]) + '" class="cv-arm"/><line x1="' + X(1) + '" y1="' + Y(hp[1][1]) + '" x2="' + X(hp[1][0]) + '" y2="' + Y(hp[1][1]) + '" class="cv-arm"/>');
            h.push('<path d="' + d + '" class="cv-curve"/><circle cx="' + X(0) + '" cy="' + Y(hp[0][1]) + '" r="3" class="cv-end"/><circle cx="' + X(1) + '" cy="' + Y(hp[1][1]) + '" r="3" class="cv-end"/>');
        } else {
            svg._samp = null;
            var A = Y(fy(0)), Z = Y(fy(1));
            h.push('<line x1="0" x2="' + W + '" y1="' + Y(0) + '" y2="' + Y(0) + '" class="cv-base"/><line x1="0" x2="' + W + '" y1="' + Y(1) + '" y2="' + Y(1) + '" class="cv-base"/>');
            h.push('<line x1="' + X(0) + '" y1="' + A + '" x2="' + X(b[0]) + '" y2="' + Y(fy(b[1])) + '" class="cv-arm"/><line x1="' + X(1) + '" y1="' + Z + '" x2="' + X(b[2]) + '" y2="' + Y(fy(b[3])) + '" class="cv-arm"/>');
            h.push('<path d="M' + X(0) + ' ' + A + ' C' + X(b[0]) + ' ' + Y(fy(b[1])) + ' ' + X(b[2]) + ' ' + Y(fy(b[3])) + ' ' + X(1) + ' ' + Z + '" class="cv-curve"/>');
            h.push('<circle cx="' + X(0) + '" cy="' + A + '" r="3" class="cv-end"/><circle cx="' + X(1) + '" cy="' + Z + '" r="3" class="cv-end"/>');
        }
        h.push('<circle id="cvDot" r="3.5" class="cv-dot" cx="' + X(0) + '" cy="' + Y(speed ? hp[0][1] : fy(0)) + '"/>');
        for (var k = 0; k < 2; k++) h.push('<circle cx="' + X(hp[k][0]) + '" cy="' + Y(hp[k][1]) + '" r="6" class="cv-h' + (drag === k ? ' on' : '') + '"/>');
        svg.innerHTML = h.join('');
        svg._map = { X: X, Y: Y, W: W, H: H, pad: pad, v: v, hp: hp };
        var vals = $('#cvVals');
        if (vals && !vals.querySelector('input')) {
            if (speed) { var s = speedsOf(b); vals.textContent = fmtN(b[0] * 100) + '% ' + fmtSp(s[0]) + ' · ' + fmtN((1 - b[2]) * 100) + '% ' + fmtSp(s[1]); }
            else vals.textContent = b.map(r4).join(', ');
        }
        var nm = $('#cvName');
        if (nm) nm.textContent = ed.name || 'Custom';
        $$('#cvMode button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-m') === mode); });
        var inv = $('#cvInv');
        if (inv) inv.classList.toggle('on', mode === 'value' && down);
    }

    function animate(now) {
        var svg = box && $('#cvG');
        if (!svg || !svg.offsetParent) { raf = 0; return; }
        var m = svg._map, dot = svg.querySelector('#cvDot');
        if (m && dot) {
            var cyc = ((now - t0) / 1000) % 1.6, x = Math.min(1, cyc / 1.2), y;
            if (mode === 'speed' && svg._samp) { var sm = svg._samp, k = 0; while (k < sm.length - 1 && sm[k + 1][0] < x) k++; y = sm[k][1]; }
            else y = fy(easeAt(ed.b, x));
            dot.setAttribute('cx', m.X(x));
            dot.setAttribute('cy', m.Y(clamp(y, m.v.y0, m.v.y1)));
        }
        raf = root.requestAnimationFrame(animate);
    }

    // ------------------------------------------------------------------ interaction

    function graphAt(svg, e, m0) {
        var m = m0 || svg._map, r = svg.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width * m.W, py = (e.clientY - r.top) / r.height * m.H;
        return { px: px, py: py, x: m.v.x0 + (px - m.pad) / (m.W - 2 * m.pad) * (m.v.x1 - m.v.x0), y: m.v.y0 + (m.H - m.pad - py) / (m.H - 2 * m.pad) * (m.v.y1 - m.v.y0) };
    }
    function handleAt(svg, e, reach) {
        var m = svg._map, p = graphAt(svg, e), h = -1, best = reach || 14;
        if (!m) return -1;
        for (var i = 0; i < 2; i++) {
            var d = Math.sqrt(Math.pow(m.X(m.hp[i][0]) - p.px, 2) + Math.pow(m.Y(m.hp[i][1]) - p.py, 2));
            if (d < best) { best = d; h = i; }
        }
        return h;
    }
    /** axis: 'x' (Ctrl + scroll), 'y' (Shift + scroll) or both */
    function zoom(f, cx, cy, axis) {
        var v = view || rangeFor(ed.b);
        if (cx == null) { cx = (v.x0 + v.x1) / 2; cy = (v.y0 + v.y1) / 2; }
        var fx = axis === 'y' ? 1 : f, fz = axis === 'x' ? 1 : f, sx = (v.x1 - v.x0) * fx, sy = (v.y1 - v.y0) * fz;
        if (sx < 0.04 || sy < 0.04 || sx > 8 || sy > 40) return;
        view = { x0: cx - (cx - v.x0) * fx, x1: cx + (v.x1 - cx) * fx, y0: cy - (cy - v.y0) * fz, y1: cy + (v.y1 - cy) * fz };
        userView = true;
        draw();
    }
    function fit() { userView = false; view = null; draw(); }
    function setMode(m) {
        mode = m;
        store.set('mode', m);
        // the speed graph opens as a hill (an ease); a curve that would show a valley is flipped
        if (m === 'speed' && isValley(ed.b)) flipSpeed();
        fit();
        api.say(m === 'speed' ? 'Speed graph: drag a handle sideways for the influence, Alt + up / down for the speed' : 'Value graph', 'info');
    }
    /** value graph: drawn going down, for a value that decreases (the ease stays the same); speed graph:
     *  the hill mirrored left / right (the fast part comes earlier or later) */
    function invert() {
        if (mode === 'speed') {
            var b = ed.b;
            ed = { b: [r4(1 - b[2]), r4(1 - b[3]), r4(1 - b[0]), r4(1 - b[1])], name: ed.name, u: ed.u };
            saveEd();
            fit();
            return;
        }
        down = !down;
        store.set('down', down);
        fit();
    }

    function liveApply() { if (live) apply('Custom', ed.b, null, true); }

    /** double-click on a handle: type its influence and speed, like After Effects' Keyframe Velocity */
    function openVelocity(h) {
        var wrap = $('.cv-wrap'), old = $('#cvVel');
        if (old) old.parentNode.removeChild(old);
        var b = ed.b, inf = h ? (1 - b[2]) * 100 : b[0] * 100, sp = speedsOf(b)[h], real = !!(ed.u && ed.u.avg);
        var el = document.createElement('div');
        el.className = 'cv-vel';
        el.id = 'cvVel';
        el.innerHTML = '<div class="cv-vel-t"><b>Keyframe velocity</b><span>' + (h ? 'Ease in' : 'Ease out') + '</span></div>' +
            '<label><span>Influence</span><input class="dala-input" id="cvInf" type="number" step="0.1" min="0.1" max="100" value="' + fmtN(inf) + '"><i>%</i></label>' +
            '<label><span>Speed</span><input class="dala-input" id="cvSp" type="number" step="0.01" min="0" value="' + fmtN(real ? sp * ed.u.avg : sp) + '"><i>' + (real ? '/s' : '×') + '</i></label>' +
            '<div class="cv-vel-b"><button type="button" class="cv-btn main" id="cvOk">OK</button><button type="button" class="cv-btn" id="cvNo">Cancel</button></div>';
        wrap.appendChild(el);
        var fi = $('#cvInf', el), fs = $('#cvSp', el);
        fi.focus(); fi.select();
        function close() { if (el.parentNode) el.parentNode.removeChild(el); }
        function ok() {
            var i = clamp(Number(fi.value) || 0.1, 0.1, 100) / 100, s = Math.max(0, Number(fs.value) || 0), nb = ed.b.slice();
            if (real) s /= ed.u.avg;
            if (h === 0) { nb[0] = r4(i); nb[1] = r4(s * i); } else { nb[2] = r4(1 - i); nb[3] = r4(1 - s * i); }
            ed = { b: nb, name: 'Custom', u: ed.u };
            saveEd();
            if (!userView) view = null;
            close();
            draw();
            liveApply();
        }
        [fi, fs].forEach(function (x) { x.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); }); });
        $('#cvOk', el).addEventListener('click', ok);
        $('#cvNo', el).addEventListener('click', close);
    }

    function bindGraph() {
        var svg = $('#cvG');
        if (mode === 'speed' && isValley(ed.b)) flipSpeed();
        svg.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            var m = svg._map;
            if (!m) return;
            var p = graphAt(svg, e), h = handleAt(svg, e, 22), now = Date.now();
            // a double-click on a handle (the graph is redrawn between the two clicks, so it is caught here)
            if (h >= 0 && lastDown.h === h && now - lastDown.t < 400) { lastDown = {}; openVelocity(h); return; }
            lastDown = { h: h, t: now };
            var start = { x: e.clientX, y: e.clientY, v: { x0: (view || rangeFor(ed.b)).x0, x1: (view || rangeFor(ed.b)).x1, y0: (view || rangeFor(ed.b)).y0, y1: (view || rangeFor(ed.b)).y1 } };
            // speed graph: the curve itself can be grabbed. Up / down = higher or flatter hill, sideways = the fast part earlier or later
            var body = null;
            if (h < 0 && mode === 'speed' && svg._samp) {
                var near = 14;
                svg._samp.forEach(function (q) { var d = Math.sqrt(Math.pow(m.X(q[0]) - p.px, 2) + Math.pow(m.Y(clamp(q[1], m.v.y0, m.v.y1)) - p.py, 2)); if (d < near) near = d; });
                if (near < 14) { var a = ed.b[0], c = 1 - ed.b[2], T = Math.max(0.04, a + c); body = { T: T, B: a / T, y: p.y, x: p.x, span: m.v.y1 - m.v.y0 }; }
            }
            var cur = h >= 0 ? { x: m.hp[h][0], y: m.hp[h][1] } : null, last = p, sp0 = speedsOf(ed.b);
            var map0 = { X: m.X, Y: m.Y, W: m.W, H: m.H, pad: m.pad, v: { x0: m.v.x0, x1: m.v.x1, y0: m.v.y0, y1: m.v.y1 }, hp: m.hp };
            if (h >= 0) drag = h; else if (body) drag = 2;
            svg.classList.add(drag >= 0 ? 'dragging' : 'panning');
            if (drag >= 0) draw();
            function move(ev) {
                if (drag === 2) {
                    var q = graphAt(svg, ev), T2 = clamp(body.T * Math.exp((q.y - body.y) / body.span * 1.6), 0.04, 1.96), B2 = clamp(body.B + (q.x - body.x), 0.05, 0.95);
                    var x1 = r4(clamp(T2 * B2, 0.01, 0.99)), x2 = r4(clamp(1 - T2 * (1 - B2), 0.01, 0.99));
                    ed.b = [x1, r4(sp0[0] * x1), x2, r4(1 - sp0[1] * (1 - x2))];
                    ed.name = 'Custom';
                    draw();
                } else if (drag >= 0) {
                    // the handle follows the mouse from where it was grabbed (no jump), in the scale of the start
                    var q2 = graphAt(svg, ev, map0), k = ev.ctrlKey || ev.metaKey ? 0.1 : 1;
                    cur.x += (q2.x - last.x) * k; cur.y += (q2.y - last.y) * k; last = q2;
                    if (mode === 'speed') {
                        // sideways = influence; the speed at the key stays unless Alt is held; Shift = speed 0
                        var s = ev.shiftKey ? 0 : ev.altKey ? Math.max(0, cur.y) : speedsOf(ed.b)[drag];
                        if (!ev.altKey) cur.y = s;
                        if (drag === 0) { var xa = r4(clamp(cur.x, 0.001, 1)); ed.b[0] = xa; ed.b[1] = r4(s * xa); }
                        else { var xb = r4(clamp(cur.x, 0, 0.999)); ed.b[2] = xb; ed.b[3] = r4(1 - s * (1 - xb)); }
                    } else {
                        var yv = clamp(fy(cur.y), -10, 10);
                        if (ev.shiftKey) yv = drag === 0 ? 0 : 1;      // flat handle, a classic ease
                        ed.b[drag * 2] = r4(clamp(cur.x, 0, 1));
                        ed.b[drag * 2 + 1] = r4(yv);
                    }
                    ed.name = 'Custom';
                    // a handle near the top or bottom: the view grows so it stays in sight
                    if (!userView && view) {
                        var hp = handlePts(ed.b)[drag], span = view.y1 - view.y0;
                        if (hp[1] > view.y1 - span * 0.06) view.y1 = hp[1] + span * 0.12;
                        if (hp[1] < view.y0 + span * 0.06) view.y0 = hp[1] - span * 0.12;
                    }
                    draw();
                } else {
                    if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 3) return;
                    var r = svg.getBoundingClientRect(), mm = svg._map;
                    var dx = (ev.clientX - start.x) / r.width * (mm.W / (mm.W - 2 * mm.pad)) * (start.v.x1 - start.v.x0);
                    var dy = (ev.clientY - start.y) / r.height * (mm.H / (mm.H - 2 * mm.pad)) * (start.v.y1 - start.v.y0);
                    view = { x0: start.v.x0 - dx, x1: start.v.x1 - dx, y0: start.v.y0 + dy, y1: start.v.y1 + dy };
                    userView = true;
                    draw();
                }
            }
            function up() {
                document.removeEventListener('mousemove', move, true);
                document.removeEventListener('mouseup', up, true);
                root.removeEventListener('blur', up);
                svg.classList.remove('dragging', 'panning');
                if (drag < 0) return;
                drag = -1;
                if (!userView) view = null;
                draw();
                saveEd();
                liveApply();
            }
            document.addEventListener('mousemove', move, true);
            document.addEventListener('mouseup', up, true);
            root.addEventListener('blur', up);
        });
        svg.addEventListener('wheel', function (e) {
            e.preventDefault();
            // Shift + wheel arrives as a sideways scroll in Chromium: read whichever delta is there
            var raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX, d = e.deltaMode === 1 ? raw * 16 : raw, p = graphAt(svg, e);
            zoom(Math.exp(clamp(d, -60, 60) * 0.004), p.x, p.y, e.ctrlKey || e.metaKey ? 'x' : e.shiftKey ? 'y' : null);
        });
        svg.addEventListener('dblclick', function (e) { e.preventDefault(); if (handleAt(svg, e) < 0) fit(); });
        svg.addEventListener('mousemove', function (e) { if (drag < 0) svg.style.cursor = handleAt(svg, e) >= 0 ? 'grab' : ''; });
        $('#cvZin').addEventListener('click', function () { zoom(0.7); });
        $('#cvZout').addEventListener('click', function () { zoom(1 / 0.7); });
        $('#cvFit').addEventListener('click', fit);
        $('#cvInv').addEventListener('click', invert);
        $$('#cvMode button').forEach(function (x) { x.addEventListener('click', function () { setMode(x.getAttribute('data-m')); }); });
        // type the four numbers
        $('#cvVals').addEventListener('click', function () {
            var vb = $('#cvVals');
            if (vb.querySelector('input')) return;
            var inp = document.createElement('input');
            inp.className = 'dala-input';
            inp.value = ed.b.join(', ');
            vb.textContent = '';
            vb.appendChild(inp);
            inp.focus(); inp.select();
            var closed = false;
            function done(ok) {
                if (closed) return;
                closed = true;
                if (ok) {
                    var n = inp.value.split(/[ ,;]+/).filter(function (s) { return s !== ''; }).map(Number).filter(function (x) { return !isNaN(x); });
                    if (n.length === 4) { ed = { b: [clamp(n[0], 0, 1), n[1], clamp(n[2], 0, 1), n[3]], name: 'Custom' }; saveEd(); liveApply(); }
                    else api.say('Type 4 numbers, like 0.33, 0, 0.67, 1', 'error');
                }
                vb.textContent = '';
                if (!userView) view = null;
                draw();
            }
            inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
            inp.addEventListener('blur', function () { done(true); });
        });
        // the graph's height: drag the grip below it (double-click: back to normal)
        var grip = $('#cvGrip'), hh = store.get('height', 0);
        if (hh) svg.style.height = hh + 'px';
        grip.addEventListener('mousedown', function (e) {
            e.preventDefault();
            var y0 = e.clientY, h0 = svg.getBoundingClientRect().height;
            function mv(ev) { svg.style.height = Math.round(clamp(h0 + ev.clientY - y0, 90, 900)) + 'px'; draw(); }
            function upG() { document.removeEventListener('mousemove', mv, true); document.removeEventListener('mouseup', upG, true); store.set('height', Math.round(svg.getBoundingClientRect().height)); }
            document.addEventListener('mousemove', mv, true);
            document.addEventListener('mouseup', upG, true);
        });
        grip.addEventListener('dblclick', function () { svg.style.height = ''; store.set('height', 0); draw(); });
    }

    // ------------------------------------------------------------------ After Effects

    function apply(name, b, tile, quiet) {
        api.host('$._dalaSuite.edit.curveApply(' + api.q(toAE(b)) + ')', function (res) {
            if (tile) { tile.classList.add(res.success ? 'done-ok' : 'done-bad'); setTimeout(function () { tile.classList.remove('done-ok', 'done-bad'); }, 1200); }
            if (!res.success) { if (!quiet || !/Select two/.test(res.message || '')) api.say(res.message || 'Applying the curve failed.', 'error'); return; }
            var n = res.data && res.data.count;
            if (!quiet) api.say(name + ' → ' + plural(n || 0, 'keyframe pair') + (res.data && res.data.flat ? ' (Position cannot go past its keyframes: separate its dimensions for that)' : ''), 'success');
        });
    }

    function keysHTML() {
        if (!keyRead) return '';
        var k = keyRead.pairs[keyRead.i], n = keyRead.pairs.length;
        function f2(x) { return String(Math.round(x * 100) / 100); }
        function ease(inf, sp) { return k.hold ? 'Hold' : k.linear ? 'Linear' : f2(inf) + '% · speed ' + f2(sp) + '/s'; }
        return '<div class="cv-keys" id="cvKeys"><div class="cv-keys-h">' +
            (n > 1 ? '<button type="button" class="cv-ico" data-step="-1" title="Previous pair of keyframes">‹</button>' : '') +
            '<span class="cv-keys-n"><b>' + esc(k.prop) + '</b>' + (k.layer ? '<small>' + esc(k.layer) + '</small>' : '') + '</span>' +
            (n > 1 ? '<span class="cv-keys-c">' + (keyRead.i + 1) + ' / ' + n + '</span><button type="button" class="cv-ico" data-step="1" title="Next pair of keyframes">›</button>' : '') +
            '<button type="button" class="cv-ico" id="cvKeysX" title="Close">×</button></div><div class="cv-keys-g">' +
            '<span>Keyframes</span><b>' + k.k1 + ' → ' + k.k2 + '</b>' +
            '<span>Duration</span><b>' + k.frames + ' frames (' + f2(k.t2 - k.t1) + ' s)</b>' +
            '<span>From</span><b>' + esc(k.v1) + '</b><span>To</span><b>' + esc(k.v2) + '</b>' +
            '<span>Ease out</span><b>' + ease(k.outInf, k.outSpeed) + '</b><span>Ease in</span><b>' + ease(k.inInf, k.inSpeed) + '</b>' +
            (k.hold || k.linear ? '' : '<span>Average</span><b>speed ' + f2(k.avg) + '/s</b>') + '</div>' +
            (keyRead.total > n ? '<div class="cv-keys-more">Showing the first ' + n + ' pairs</div>' : '') + '</div>';
    }
    function showKeys() {
        var old = $('#cvKeys'), html = keysHTML(), slot = $('#cvKeySlot');
        if (old) old.parentNode.removeChild(old);
        if (html) slot.innerHTML = html;
        var kb = $('#cvKeys');
        if (!kb) return;
        $$('[data-step]', kb).forEach(function (b) {
            b.addEventListener('click', function () { var n = keyRead.pairs.length; keyRead.i = (keyRead.i + Number(b.getAttribute('data-step')) + n) % n; loadPair(); showKeys(); });
        });
        $('#cvKeysX', kb).addEventListener('click', function () { keyRead = null; showKeys(); });
    }
    function loadPair() {
        var k = keyRead.pairs[keyRead.i];
        if (k.hold) { api.say('Hold keyframe: no ease to show', 'info'); return; }
        ed = { b: fromAE(k.curve).map(r4), name: 'From keyframes', u: { avg: k.avg, frames: k.frames } };
        saveEd();
        fit();
    }
    function readKeys(btn) {
        api.host('$._dalaSuite.edit.curveRead()', function (res) {
            if (!res.success) { api.say(res.message || 'Reading the keyframes failed.', 'error'); return; }
            keyRead = { pairs: res.data.pairs, i: 0, total: res.data.total || res.data.pairs.length };
            loadPair();
            showKeys();
            api.say(keyRead.pairs.length > 1 ? keyRead.pairs.length + ' pairs of keyframes read · ‹ › to see each one' : 'Ease of the selected keyframes loaded in the graph', 'success');
        });
    }

    // ------------------------------------------------------------------ library

    function save() {
        var row = $('#cvRow');
        if (row.getAttribute('data-naming')) return;
        var list = store.get('mine', []);
        var builtin = PRESETS.some(function (p) { return p[0] === ed.name; });
        var suggest = ed.name && ['Custom', 'Linear', 'From keyframes'].indexOf(ed.name) < 0 && !builtin && !list.some(function (c) { return c.name === ed.name; }) ? ed.name : 'My curve ' + (list.length + 1);
        row.setAttribute('data-naming', '1');
        row.innerHTML = '<input class="dala-input cv-grow" id="cvNameIn" maxlength="32" placeholder="Name this curve" value="' + esc(suggest) + '">' +
            '<button type="button" class="cv-btn main" id="cvNameOk">Save</button><button type="button" class="cv-btn" id="cvNameNo">Cancel</button>';
        var inp = $('#cvNameIn');
        inp.focus(); inp.select();
        function done(ok) {
            if (ok) {
                var name = inp.value.replace(/^\s+|\s+$/g, '');
                if (!name) { inp.focus(); api.say('Give the curve a name', 'error'); return; }
                var l = store.get('mine', []), at = -1;
                for (var i = 0; i < l.length; i++) if (l[i].name.toLowerCase() === name.toLowerCase()) at = i;
                if (at >= 0) l.splice(at, 1);
                l.unshift({ name: name, b: ed.b.map(r4) });
                store.set('mine', l);
                ed.name = name;
                saveEd();
                api.say(at >= 0 ? '“' + name + '” updated' : '“' + name + '” saved in your curves', 'success');
            }
            render(box, api);
        }
        inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
        $('#cvNameOk').addEventListener('mousedown', function (e) { e.preventDefault(); });
        $('#cvNameOk').addEventListener('click', function () { done(true); });
        $('#cvNameNo').addEventListener('click', function () { done(false); });
    }

    function curveIcon(b) {
        function X(x) { return 2 + x * 36; }
        function Y(y) { return 26 - y * 24; }
        return '<svg class="cv-ic" viewBox="0 0 40 28" overflow="visible"><path d="M' + X(0) + ' ' + Y(0) + ' C' + X(b[0]) + ' ' + Y(b[1]) + ' ' + X(b[2]) + ' ' + Y(b[3]) + ' ' + X(1) + ' ' + Y(1) + '"/></svg>';
    }
    function tile(name, b, mine) {
        return '<button type="button" class="cv-tile' + (mine != null ? ' mine' : '') + '" data-b="' + b.join(',') + '" data-n="' + esc(name) + '"' + (mine != null ? ' data-i="' + mine + '"' : '') +
            ' title="' + esc(name) + ' · click to load it and apply it to the selected keyframes' + (mine != null ? '. Double-click to rename' : '') + '">' + curveIcon(b) +
            '<span>' + esc(name) + '</span><i class="cv-x" ' + (mine != null ? 'data-del="' + mine + '"' : 'data-hide="' + esc(name) + '"') + ' title="' + (mine != null ? 'Delete' : 'Remove from the list (Options brings it back)') + '">×</i></button>';
    }

    function options(anchor) {
        var hidden = store.get('hidden', []).length, mine = store.get('mine', []).length;
        api.pop(anchor, '<div class="gp-cap">Curves</div>' +
            '<label class="gp-opt"><input type="checkbox" id="cvLive"' + (live ? ' checked' : '') + '><span>Apply while editing<small>each time a handle is released</small></span></label>' +
            '<div class="gp-note">Drag a handle (Shift: flat, Ctrl: fine). Scroll to zoom, Ctrl + scroll: time only, Shift + scroll: value only. Drag the empty space to move, double-click it to fit. Double-click a handle to type its influence and speed. Speed graph: Alt + up / down changes the speed.</div>' +
            '<div class="gp-cap">Library</div>' +
            '<button type="button" class="gp-row" id="cvRestore">Bring back the built-in curves<small>' + (hidden ? plural(hidden, 'curve') + ' removed' : 'none removed') + '</small></button>' +
            '<button type="button" class="gp-row danger" id="cvClear">Delete all my curves<small>' + plural(mine, 'saved curve') + '</small></button>', function (p) {
            p.querySelector('#cvLive').addEventListener('change', function (e) { live = e.target.checked; store.set('live', live); });
            p.querySelector('#cvRestore').addEventListener('click', function () { store.set('hidden', []); api.closePop(); api.say('Built-in curves are back', 'info'); render(box, api); });
            var del = p.querySelector('#cvClear');
            del.addEventListener('click', function () {
                if (!del.getAttribute('data-sure')) { del.setAttribute('data-sure', '1'); del.firstChild.textContent = 'Click again to delete them all'; return; }
                store.set('mine', []); api.closePop(); api.say('Your curves were deleted', 'info'); render(box, api);
            });
        });
    }

    // ------------------------------------------------------------------ the view

    function render(el, a) {
        box = el; api = a;
        var mine = store.get('mine', []), hidden = store.get('hidden', []);
        box.innerHTML = '<div class="cv">' +
            '<div class="cv-head"><span class="cv-name" id="cvName"></span>' +
            '<div class="cv-seg" id="cvMode"><button type="button" data-m="value" title="Value graph: the value over time (default)">Value</button><button type="button" data-m="speed" title="Speed graph, like After Effects: drag a handle sideways for the influence, Alt + up / down for the speed">Speed</button></div>' +
            '<span class="cv-vals" id="cvVals" title="Click to type the four numbers"></span></div>' +
            '<div class="cv-wrap"><svg id="cvG" class="cv-g" xmlns="' + NS + '"></svg>' +
            '<div class="cv-zoom"><button type="button" class="cv-ico" id="cvInv" title="Invert: value graph drawn going down (for a value that decreases); speed graph mirrored">⇅</button>' +
            '<button type="button" class="cv-ico" id="cvZout" title="Zoom out">−</button><button type="button" class="cv-ico" id="cvZin" title="Zoom in">+</button>' +
            '<button type="button" class="cv-ico" id="cvFit" title="Fit the curve (or double-click the graph)">⤢</button></div>' +
            '<div class="cv-grip" id="cvGrip" title="Drag to make the graph taller or shorter (double-click: back to normal)"><i></i></div></div>' +
            '<div id="cvKeySlot"></div>' +
            '<div class="cv-row" id="cvRow"><button type="button" class="cv-btn main cv-grow" id="cvApply" title="Apply the curve to the selected keyframes (two or more)">Apply</button>' +
            '<button type="button" class="cv-btn" id="cvRead" title="Read keys: shows the curve and the values of the selected keyframes">Read keys</button>' +
            '<button type="button" class="cv-btn" id="cvSave" title="Save this curve in your library">Save</button></div>' +
            '<div class="cv-lib">' + mine.map(function (c, i) { return tile(c.name, c.b, i); }).join('') +
            PRESETS.filter(function (p) { return hidden.indexOf(p[0]) < 0; }).map(function (p) { return tile(p[0], p[1]); }).join('') + '</div></div>';
        bindGraph();
        if (!userView) view = null;
        root.requestAnimationFrame(draw);
        if (!raf) { t0 = root.performance ? root.performance.now() : Date.now(); raf = root.requestAnimationFrame(animate); }
        $('#cvApply').addEventListener('click', function (e) { apply(ed.name || 'Custom', ed.b, e.currentTarget); });
        $('#cvRead').addEventListener('click', function (e) { readKeys(e.currentTarget); });
        $('#cvSave').addEventListener('click', save);
        if (keyRead) showKeys();
        $$('.cv-tile').forEach(function (t) {
            t.addEventListener('click', function (e) {
                if (e.target.getAttribute('data-del') !== null || e.target.getAttribute('data-hide') !== null) return;
                ed = { b: t.getAttribute('data-b').split(',').map(Number), name: t.getAttribute('data-n') };
                saveEd();
                fit();
                apply(ed.name, ed.b, t);
            });
            if (t.getAttribute('data-i') !== null) t.addEventListener('dblclick', function () {
                var span = t.querySelector('span'), inp = document.createElement('input'), i = Number(t.getAttribute('data-i')), closed = false;
                inp.className = 'dala-input cv-rename';
                inp.value = t.getAttribute('data-n');
                span.parentNode.replaceChild(inp, span);
                inp.focus(); inp.select();
                function done(ok) {
                    if (closed) return;
                    closed = true;
                    if (ok) { var l = store.get('mine', []); if (l[i]) { l[i].name = inp.value.replace(/^\s+|\s+$/g, '') || l[i].name; store.set('mine', l); } }
                    render(box, api);
                }
                inp.addEventListener('click', function (e) { e.stopPropagation(); });
                inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
                inp.addEventListener('blur', function () { done(true); });
            });
        });
        $$('[data-del]').forEach(function (x) {
            x.addEventListener('click', function (e) { e.stopPropagation(); var l = store.get('mine', []), g = l.splice(Number(x.getAttribute('data-del')), 1)[0]; store.set('mine', l); api.say('“' + (g ? g.name : '') + '” deleted', 'info'); render(box, api); });
        });
        $$('[data-hide]').forEach(function (x) {
            x.addEventListener('click', function (e) { e.stopPropagation(); var h = store.get('hidden', []); h.push(x.getAttribute('data-hide')); store.set('hidden', h); api.say('“' + x.getAttribute('data-hide') + '” removed · Options brings it back', 'info'); render(box, api); });
        });
    }

    function stop() { if (raf) { root.cancelAnimationFrame(raf); raf = 0; } }
    function resize() { if (box && $('#cvG')) draw(); }

    root.DalaCurves = { render: render, stop: stop, resize: resize, options: options, presets: PRESETS, toAE: toAE, fromAE: fromAE, easeAt: easeAt };
})(window);
