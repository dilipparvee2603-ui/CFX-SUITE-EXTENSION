/**
 * Dala Suite - GENERAL tab (ES5): one card.
 *   Anchor point (3 x 3) and Align (top / middle / bottom, left / centre / right), each with its own Lock, right in
 *   the card                                                       -> host/anchorAlign.jsx
 *   Edit:  Curves (opens its page: js/general/curves.js), Text, Precomp, Precomp each, Decomp, Copy fx, Paste fx,
 *          Duplicate, Null, Solid (colour picker first), Adjust - one new null / solid / adjustment layer per selected
 *          layer                                                   -> host/editTools.jsx, host/unprecompose.jsx
 *   Link:  a video from a TikTok / YouTube / Instagram / Pinterest / X link into the comp (js/general/linkImport.js)
 *   Beat Checker, Beat Clips Arranger, Sequence Layers, Select (layer types, CHECK COMPOSITION), Gradient Lock,
 *   Organise Project, Gap Finder (+ close), Black Frames (timeline + FFmpeg)  -> host/generalTools.jsx, anchorAlign.jsx
 *   Clean Up: what older projects left on the PC (caches, auto-saves, Dala files), keeping the open project's
 *                                                                  -> js/general/cleanup.js
 * Results show as one small message (js/toast.js); the line under the buttons explains the hovered one.
 * The options button (top right) holds the settings of the Edit tools, or of Curves while that page is open.
 */
(function (root) {
    'use strict';
    var cs = null, dom = {}, busy = {}, pop = null, page = 'grid', linkJob = null, linkApi = null, linkStatus = '';

    var store = {
        get: function (k, d) { try { var v = root.localStorage.getItem('dala.general.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
        set: function (k, v) { try { root.localStorage.setItem('dala.general.' + k, JSON.stringify(v)); } catch (e) {} }
    };
    var DEF = { name: '', match: true, trim: true, preMode: '', removeItem: false, dupMode: 'new', dupDeep: true,
        fxEffects: true, fxReplace: false, fxBlend: true, fxTransform: false, fxAnim: 'fit', linkAudio: false, solid: '#0A0A0A',
        alignTo: 'auto', anchorLock: false, alignLock: false, blackRange: 'comp', blackMarks: true };
    var opt = store.get('options', {}), k0;
    for (k0 in DEF) if (DEF.hasOwnProperty(k0) && !opt.hasOwnProperty(k0)) opt[k0] = DEF[k0];
    function saveOpt() { store.set('options', opt); }

    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function say(message, type) { if (root.DalaToast && message) root.DalaToast(message, type); }
    function q(obj) { return JSON.stringify(JSON.stringify(obj)); }
    function host(call, cb) {
        if (!cs) { cb({ success: false, message: 'After Effects is not connected.' }); return; }
        cs.evalScript(call, function (raw) {
            var res;
            try { res = JSON.parse(raw); } catch (e) { res = { success: false, message: (raw && raw !== 'undefined') ? String(raw) : 'After Effects did not answer.' }; }
            cb(res);
        });
    }
    function node(m) {
        try {
            if (typeof root.require === 'function') return root.require(m);
            if (root.cep_node && typeof root.cep_node.require === 'function') return root.cep_node.require(m);
        } catch (e) {}
        return null;
    }
    function hexRgb(h) { return [1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }); }

    // ------------------------------------------------------------------ popover (one at a time)

    function closePop() {
        if (!pop) return;
        if (pop._watch) { try { pop._watch.disconnect(); } catch (eW) {} }
        if (pop.parentNode) pop.parentNode.removeChild(pop);
        pop = null;
        document.removeEventListener('mousedown', outside, true);
        document.removeEventListener('keydown', escKey, true);
    }
    function outside(e) { if (pop && !pop.contains(e.target) && !(pop._anchor && pop._anchor.contains(e.target))) closePop(); }
    function escKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } }
    /** a small floating box under (or above) the anchor; bind(box) wires it */
    function openPop(anchor, html, bind) {
        var reopen = pop && pop._anchor === anchor;
        closePop();
        if (reopen) return;
        pop = document.createElement('div');
        pop.className = 'gen-pop';
        pop.innerHTML = html;
        pop._anchor = anchor;
        document.body.appendChild(pop);
        fitPop();
        if (bind) bind(pop);
        fitPop();
        // results arriving later (a scan, a list) make the box taller: it is placed again so all of it stays reachable
        if (root.MutationObserver) {
            pop._watch = new root.MutationObserver(function () { fitPop(); });
            pop._watch.observe(pop, { childList: true, subtree: true, characterData: true });
        }
        setTimeout(function () { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', escKey, true); }, 0);
    }
    /** puts the popover under (or above) its button and always fully inside the panel; taller than the panel: it scrolls */
    function fitPop() {
        if (!pop || !pop._anchor) return;
        var r = pop._anchor.getBoundingClientRect(), W = root.innerWidth, H = root.innerHeight;
        pop.style.maxHeight = Math.max(80, H - 12) + 'px';
        var w = pop.offsetWidth, h = pop.offsetHeight;
        var left = Math.max(6, Math.min(W - w - 6, r.left + r.width / 2 - w / 2)), top = r.bottom + 6;
        if (top + h > H - 6) top = r.top - h - 6;
        top = Math.max(6, Math.min(top, H - h - 6));
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }

    // ------------------------------------------------------------------ results on the buttons

    function flash(b, ok) {
        if (!b) return;
        b.classList.remove('busy', 'done-ok', 'done-bad');
        b.classList.add(ok ? 'done-ok' : 'done-bad');
        setTimeout(function () { b.classList.remove('done-ok', 'done-bad'); }, 1200);
    }
    function runHost(id, call, after) {
        var b = $('gen-' + id);
        if (busy[id]) return;
        busy[id] = true;
        if (b) b.classList.add('busy');
        host(call, function (res) {
            busy[id] = false;
            flash(b, !!res.success);
            say(res.message || (res.success ? 'Done' : 'That did not work.'), res.success ? 'success' : 'error');
            if (after) after(res);
        });
    }

    // ------------------------------------------------------------------ the Edit tools

    function createLayer(type, color) {
        return function () {
            var a = { type: type, match: !!opt.match };
            if (opt.name) a.name = opt.name;
            if (color) a.color = hexRgb(color);
            runHost(type === 'adjustment' ? 'adjust' : type, '$._dalaSuite.edit.create(' + q(a) + ')');
        };
    }

    function precompRun(each, id) { runHost(id || (each ? 'precompEach' : 'precomp'), '$._dalaSuite.edit.precompose(' + q({ each: !!each, trim: !!opt.trim }) + ')'); }

    /** several layers selected: together in one precomp or each on its own (asked once, or set in the options) */
    function doPrecomp(b) {
        host('$._dalaSuite.getCompInfo()', function (res) {
            var n = (res && res.data && res.data.selectedLayerCount) || 0;
            if (n < 2 || opt.preMode) { precompRun(n > 1 && opt.preMode === 'each', 'precomp'); return; }
            openPop(b, '<div class="gp-cap">Precompose ' + n + ' layers</div>' +
                '<button type="button" class="gp-btn main" id="gpEach">Each layer on its own</button>' +
                '<button type="button" class="gp-btn" id="gpOne">All together</button>' +
                '<label class="gp-opt"><input type="checkbox" id="gpRem" checked><span>Remember my choice<small>change it in the options</small></span></label>', function (p) {
                function go(mode) { if (p.querySelector('#gpRem').checked) { opt.preMode = mode; saveOpt(); } closePop(); precompRun(mode === 'each', 'precomp'); }
                p.querySelector('#gpEach').addEventListener('click', function () { go('each'); });
                p.querySelector('#gpOne').addEventListener('click', function () { go('one'); });
            });
        });
    }

    function pasteOpts() {
        var o = { effects: !!opt.fxEffects, replace: !!opt.fxReplace, blend: !!opt.fxBlend, transform: !!opt.fxTransform, keys: opt.fxAnim !== 'off' };
        if (o.keys) o.timing = opt.fxAnim;
        return o;
    }

    // ------------------------------------------------------------------ Solid: colour picker first

    var SWATCHES = ['#FFFFFF', '#0A0A0A', '#2B2B30', '#8C8C96', '#F03C3C', '#FF7A2E', '#FFCC33', '#5FD068', '#22C3A6', '#2979FF', '#8A63F5', '#F25CA2'];
    function hexHsv(h) {
        var n = parseInt(String(h).replace('#', ''), 16) || 0, r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, hu = 0;
        if (d) hu = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return { h: (hu * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
    }
    function hsvRgb(h, s, v) { function f(n) { var k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); } return [f(5), f(3), f(1)]; }
    function hsvHex(h, s, v) { return '#' + hsvRgb(h, s, v).map(function (x) { var t = Math.round(x * 255).toString(16); return t.length < 2 ? '0' + t : t; }).join('').toUpperCase(); }

    function solidPicker(b) {
        var recent = store.get('solidRecent', []).filter(function (c) { return /^#[0-9A-F]{6}$/i.test(c); }).slice(0, 6);
        function sw(c) { return '<button type="button" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>'; }
        openPop(b, '<div class="gp-cap">New solid</div>' +
            '<div class="gp-wheel-row"><div class="gp-wheel" id="gpWheel"><canvas></canvas><i class="gp-dot" id="gpWheelDot"></i></div>' +
            '<div class="gp-bar" id="gpBright" title="Brightness: drag left for darker, right for brighter" tabindex="0"><i class="gp-dot" id="gpBrightDot"></i></div></div>' +
            '<div class="gp-sw">' + SWATCHES.map(sw).join('') + '</div>' +
            (recent.length ? '<div class="gp-cap">Last used</div><div class="gp-sw">' + recent.map(sw).join('') + '</div>' : '') +
            '<div class="gp-hex"><i id="gpPrev"></i><input class="dala-input" id="gpHex" maxlength="7" spellcheck="false" title="Colour code: type or paste a hex code"></div>' +
            '<button type="button" class="gp-btn main" id="gpSolidGo">Create solid</button>' +
            '<div class="gp-note">Double-click a colour to create at once.</div>', function (p) {
            var hsv = hexHsv(opt.solid), wheel = p.querySelector('#gpWheel'), cv = wheel.querySelector('canvas'), bar = p.querySelector('#gpBright'), hex = p.querySelector('#gpHex');
            // the wheel: hue around, strength from the middle out (drawn once, sharp on any screen)
            var S = wheel.clientWidth || 132, dpr = Math.min(3, root.devicePixelRatio || 1), W = Math.round(S * dpr);
            cv.width = cv.height = W;
            try {
                var ctx = cv.getContext('2d'), img = ctx.createImageData(W, W), R = W / 2, x, y;
                for (y = 0; y < W; y++) for (x = 0; x < W; x++) {
                    var dx = x + 0.5 - R, dy = y + 0.5 - R, d = Math.sqrt(dx * dx + dy * dy);
                    if (d > R) continue;
                    var c = hsvRgb((Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, Math.min(1, d / (R - 1)), 1), i = (y * W + x) * 4;
                    img.data[i] = c[0] * 255; img.data[i + 1] = c[1] * 255; img.data[i + 2] = c[2] * 255; img.data[i + 3] = Math.max(0, Math.min(1, R - d)) * 255;
                }
                ctx.putImageData(img, 0, 0);
            } catch (eC) { /* no canvas: the swatches and the hex code still work */ }
            function show(c, from) {
                opt.solid = c; saveOpt();
                var dot = document.querySelector('#gen-solid .gen-dot');
                if (dot) dot.style.background = c;
                p.querySelector('#gpPrev').style.background = c;
                if (from !== 'hex') hex.value = c;
                Array.prototype.forEach.call(p.querySelectorAll('.gp-sw button'), function (x) { x.classList.toggle('on', x.getAttribute('data-c').toUpperCase() === c.toUpperCase()); });
                var a = hsv.h * Math.PI / 180, wd = p.querySelector('#gpWheelDot'), bd = p.querySelector('#gpBrightDot');
                wd.style.left = (50 + Math.cos(a) * hsv.s * 50) + '%';
                wd.style.top = (50 - Math.sin(a) * hsv.s * 50) + '%';
                wd.style.background = hsvHex(hsv.h, hsv.s, 1);
                bd.style.left = (hsv.v * 100) + '%';
                bd.style.background = c;
                bar.style.background = 'linear-gradient(90deg, #000, ' + hsvHex(hsv.h, hsv.s, 1) + ')';
                cv.style.opacity = String(1 - Math.min(0.6, (1 - hsv.v) * 0.6));
            }
            function fromHex(c, from) { var n = hexHsv(c); hsv = { h: n.s ? n.h : hsv.h, s: n.s, v: n.v }; show(c.toUpperCase(), from); }
            function dragOn(el, move) {
                el.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    function at(ev) { var r = el.getBoundingClientRect(); move(ev.clientX - r.left, ev.clientY - r.top, r); }
                    function up() { document.removeEventListener('mousemove', at, true); document.removeEventListener('mouseup', up, true); }
                    at(e);
                    document.addEventListener('mousemove', at, true);
                    document.addEventListener('mouseup', up, true);
                });
            }
            dragOn(wheel, function (x, y, r) {
                var dx = x - r.width / 2, dy = r.height / 2 - y, d = Math.sqrt(dx * dx + dy * dy);
                hsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
                hsv.s = Math.min(1, d / (r.width / 2));
                if (hsv.v < 0.15) hsv.v = 1;     // picking a hue on a black solid: show the hue, not black
                show(hsvHex(hsv.h, hsv.s, hsv.v));
            });
            dragOn(bar, function (x, y, r) { hsv.v = Math.max(0, Math.min(1, x / r.width)); show(hsvHex(hsv.h, hsv.s, hsv.v)); });
            bar.addEventListener('keydown', function (e) {
                var k = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
                if (!k) return;
                e.preventDefault(); e.stopPropagation();
                hsv.v = Math.max(0, Math.min(1, hsv.v + k));
                show(hsvHex(hsv.h, hsv.s, hsv.v));
            });
            function go() {
                closePop();
                var list = [opt.solid].concat(store.get('solidRecent', []).filter(function (c) { return c.toUpperCase() !== opt.solid.toUpperCase(); })).slice(0, 6);
                store.set('solidRecent', list);
                createLayer('solid', opt.solid)();
            }
            Array.prototype.forEach.call(p.querySelectorAll('.gp-sw button'), function (x) {
                x.addEventListener('click', function () { fromHex(x.getAttribute('data-c')); });
                x.addEventListener('dblclick', function () { fromHex(x.getAttribute('data-c')); go(); });
            });
            hex.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') go(); });
            hex.addEventListener('input', function () { var v = hex.value.replace(/^\s+|\s+$/g, '').replace(/^#?/, '#'); if (/^#[0-9a-f]{6}$/i.test(v)) fromHex(v, 'hex'); });
            p.querySelector('#gpSolidGo').addEventListener('click', go);
            fromHex(opt.solid);
        });
    }

    // ------------------------------------------------------------------ Link

    function linkSetup() {
        if (linkApi) return linkApi;
        var N = { fs: node('fs'), path: node('path'), os: node('os'), cp: node('child_process'), https: node('https'), crypto: node('crypto'), url: node('url') };
        if (!N.fs || !N.cp || !N.https || !root.DalaLinkImport) return null;
        var proc = (typeof root.process !== 'undefined' && root.process) || node('process');
        linkApi = root.DalaLinkImport.create(N, (proc && proc.env) || {});
        return linkApi;
    }

    function linkImport(url, b) {
        var L = linkSetup();
        if (!L) { say('Link needs Node.js in the panel (After Effects 2020 or newer).', 'error'); return; }
        busy.link = true;
        b.classList.add('busy');
        linkStatus = 'Starting…';
        info(linkStatus);
        linkJob = L.download(url, { audioOnly: !!opt.linkAudio }, {
            onStatus: function (s) { linkStatus = s; info(s); var pl = pop && pop.querySelector('#gpLinkState'); if (pl) pl.textContent = s; }
        }, function (e, file) {
            linkJob = null;
            if (e) { busy.link = false; flash(b, false); info(IDLE); if (e.code !== 'cancelled') say(e.message, 'error'); else say('Download cancelled', 'info'); return; }
            linkStatus = 'Importing…';
            info(linkStatus);
            host('$._dalaSuite.edit.importMedia(' + q({ path: file }) + ')', function (res) {
                busy.link = false;
                flash(b, !!res.success);
                info(IDLE);
                say(res.success ? res.message + ' · saved in Downloads\\Dala Suite' : (res.message || 'Importing failed.'), res.success ? 'success' : 'error');
            });
        });
    }

    function clipboardLink(inp) {
        // a link copied in the browser is pasted in for you
        try {
            if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.readText) {
                root.navigator.clipboard.readText().then(function (t) { t = String(t || '').replace(/^\s+|\s+$/g, ''); if (!inp.value && /^https?:\/\/\S+$/i.test(t)) { inp.value = t; inp.select(); } }, function () {});
                return;
            }
        } catch (e) {}
    }

    function linkPicker(b) {
        if (busy.link) {
            openPop(b, '<div class="gp-cap">Import from a link</div><div class="gp-state" id="gpLinkState">' + esc(linkStatus) + '</div>' +
                '<button type="button" class="gp-btn" id="gpLinkStop">Cancel the download</button>', function (p) {
                p.querySelector('#gpLinkStop').addEventListener('click', function () { if (linkJob) linkJob.cancel(); closePop(); });
            });
            return;
        }
        openPop(b, '<div class="gp-cap">Import from a link</div>' +
            '<input class="dala-input" id="gpLink" placeholder="TikTok, YouTube, Instagram, Pinterest, X… link" spellcheck="false">' +
            '<label class="gp-opt"><input type="checkbox" id="gpAudio"' + (opt.linkAudio ? ' checked' : '') + '><span>Sound only<small>WAV, for music and sound design</small></span></label>' +
            '<button type="button" class="gp-btn main" id="gpLinkGo">Import</button>' +
            '<div class="gp-note">Only import videos you are allowed to use: your own, free to use, or with the creator’s OK. Downloading from YouTube or TikTok can go against their terms.</div>', function (p) {
            var inp = p.querySelector('#gpLink');
            p.querySelector('#gpAudio').addEventListener('change', function (e) { opt.linkAudio = e.target.checked; saveOpt(); });
            function go() { var v = inp.value; closePop(); linkImport(v, b); }
            inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') go(); });
            p.querySelector('#gpLinkGo').addEventListener('click', go);
            setTimeout(function () { inp.focus(); }, 30);
            clipboardLink(inp);
        });
    }

    // ------------------------------------------------------------------ options

    function check(id, on, label, sub) { return '<label class="gp-opt"><input type="checkbox" data-o="' + id + '"' + (on ? ' checked' : '') + '><span>' + label + (sub ? '<small>' + sub + '</small>' : '') + '</span></label>'; }
    function seg(id, val, items) {
        return '<div class="gp-seg">' + items.map(function (it) { return '<button type="button" data-o="' + id + '" data-v="' + it[0] + '"' + (val === it[0] ? ' class="on"' : '') + (it[2] ? ' title="' + it[2] + '"' : '') + '>' + it[1] + '</button>'; }).join('') + '</div>';
    }
    function optionsPop(b) {
        if (page === 'curves') { root.DalaCurves.options(b); return; }
        openPop(b, '<div class="gp-cap">New layers</div>' +
            '<input class="dala-input" id="gpName" placeholder="Name (optional)" value="' + esc(opt.name) + '">' +
            check('match', opt.match, 'Match selected layer', 'same start, end and place in the stack') +
            '<div class="gp-cap">Precompose</div>' + check('trim', opt.trim, 'Trim to the layers', 'the precomp is as long as its layers') +
            '<div class="gp-sub">Several layers</div>' + seg('preMode', opt.preMode, [['', 'Ask'], ['one', 'Together'], ['each', 'Each']]) +
            '<div class="gp-cap">Decomp</div>' + check('removeItem', opt.removeItem, 'Delete the precomp', 'from the project, once nothing uses it') +
            '<div class="gp-cap">Duplicate</div>' + seg('dupMode', opt.dupMode, [['new', 'New layer', 'A new layer with the copy, next to the original'], ['unique', 'In place', 'The selected layer itself switches to the copy']]) +
            check('dupDeep', opt.dupDeep, 'Nested precomps too', 'precomps inside are copied as well') +
            '<div class="gp-cap">Paste fx</div>' + check('fxEffects', opt.fxEffects, 'Effects') + check('fxReplace', opt.fxReplace, 'Replace existing effects') +
            check('fxBlend', opt.fxBlend, 'Blend mode, opacity, motion blur') + check('fxTransform', opt.fxTransform, 'Scale and rotation') +
            '<div class="gp-sub">Animation</div>' + seg('fxAnim', opt.fxAnim, [['off', 'Off', 'Only the effects with their current values'], ['shift', 'Keep', 'Same keyframe timing, from each clip’s start'], ['fit', 'Fit to clip', 'Keyframes stretch or squeeze to each clip’s length']]) +
            '<div class="gp-cap">Align</div><div class="gp-sub">Align to</div>' + seg('alignTo', opt.alignTo, [['auto', 'Auto', 'One layer: the composition; several: the selection'], ['comp', 'Comp', 'Always the composition'], ['selection', 'Selection', 'The bounds of the selected layers']]), function (p) {
            var nm = p.querySelector('#gpName');
            nm.addEventListener('input', function () { opt.name = nm.value; saveOpt(); });
            nm.addEventListener('keydown', function (e) { e.stopPropagation(); });
            bindOpts(p);
        });
    }
    /** checkboxes [data-o] and segmented buttons in a popover write their option straight away */
    function bindOpts(p) {
        Array.prototype.forEach.call(p.querySelectorAll('input[type=checkbox][data-o]'), function (c) {
            c.addEventListener('change', function () { opt[c.getAttribute('data-o')] = c.checked; saveOpt(); });
        });
        Array.prototype.forEach.call(p.querySelectorAll('.gp-seg button'), function (s) {
            s.addEventListener('click', function () {
                var k = s.getAttribute('data-o');
                opt[k] = s.getAttribute('data-v'); saveOpt();
                Array.prototype.forEach.call(s.parentNode.children, function (x) { x.classList.toggle('on', x === s); });
            });
        });
    }

    // ------------------------------------------------------------------ anchor point + align (in the card)

    function svgIcon(d) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>'; }
    // arrows towards the nine points of the layer's bounds (the centre: a dot)
    var ANCHORS = [
        [0, 0, 'top left', 'M7 7h8v2h-4.6l7.3 7.3-1.4 1.4L9 10.4V15H7z'], [0.5, 0, 'top', 'M11 20V7.8l-4.6 4.6L5 11l7-7 7 7-1.4 1.4L13 7.8V20z'],
        [1, 0, 'top right', 'M17 7H9v2h4.6l-7.3 7.3 1.4 1.4L15 10.4V15h2z'], [0, 0.5, 'left', 'M20 11H7.8l4.6-4.6L11 5l-7 7 7 7 1.4-1.4L7.8 13H20z'],
        [0.5, 0.5, 'centre', 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'], [1, 0.5, 'right', 'M4 11h12.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H4z'],
        [0, 1, 'bottom left', 'M7 17h8v-2h-4.6l7.3-7.3-1.4-1.4L9 13.6V9H7z'], [0.5, 1, 'bottom', 'M11 4v12.2l-4.6-4.6L5 13l7 7 7-7-1.4-1.4-4.6 4.6V4z'],
        [1, 1, 'bottom right', 'M17 17H9v-2h4.6L6.3 7.7l1.4-1.4L15 13.6V9h2z']];
    var ALIGNS = [
        ['v', 'top', 'Align top', 'M3 3h18v2H3zM6 7h4v12H6zM14 7h4v7h-4z'], ['v', 'middle', 'Align vertical centres', 'M3 11h3V6h4v5h4V8h4v3h3v2h-3v3h-4v-3h-4v5H6v-5H3z'],
        ['v', 'bottom', 'Align bottom', 'M3 19h18v2H3zM6 5h4v12H6zM14 10h4v7h-4z'], ['h', 'left', 'Align left', 'M3 3h2v18H3zM7 6h12v4H7zM7 14h7v4H7z'],
        ['h', 'center', 'Align horizontal centres', 'M11 3h2v3h6v4h-6v4h3v4h-3v3h-2v-3H8v-4h3v-4H5V6h6z'], ['h', 'right', 'Align right', 'M19 3h2v18h-2zM5 6h12v4H5zM10 14h7v4h-7z']];

    function lockState(btn, on) { btn.classList.toggle('on', !!on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }

    function renderAA() {
        dom.anchor.innerHTML = '';
        ANCHORS.forEach(function (a) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'gen-pad-btn';
            b.innerHTML = svgIcon(a[3]);
            b.title = 'Anchor point on the ' + a[2] + ' of the selected layers (the layers do not move)';
            b.addEventListener('mouseenter', function () { if (!busy.link) info('Anchor point: ' + a[2] + ' of the layer\u2019s bounds' + (opt.anchorLock ? ' \u00B7 locked there' : '') + '.'); });
            b.addEventListener('mouseleave', function () { if (!busy.link) info(IDLE); });
            b.addEventListener('click', function () { padRun(b, '$._dalaSuite.layout.anchor(' + q({ x: a[0], y: a[1], lock: !!opt.anchorLock }) + ')'); });
            dom.anchor.appendChild(b);
        });
        dom.align.innerHTML = '';
        ALIGNS.forEach(function (a) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'gen-pad-btn';
            b.innerHTML = svgIcon(a[3]);
            b.title = a[2] + ' (one layer: to the composition; several: to the selection - change it in the options)';
            b.addEventListener('mouseenter', function () { if (!busy.link) info(a[2] + (opt.alignLock ? ' \u00B7 locked to the composition' : '') + '.'); });
            b.addEventListener('mouseleave', function () { if (!busy.link) info(IDLE); });
            b.addEventListener('click', function () {
                var arg = { to: opt.alignTo, lock: !!opt.alignLock };
                arg[a[0]] = a[1];
                padRun(b, '$._dalaSuite.layout.align(' + q(arg) + ')');
            });
            dom.align.appendChild(b);
        });
        lockState(dom.anchorLock, opt.anchorLock);
        lockState(dom.alignLock, opt.alignLock);
        dom.anchorLock.addEventListener('click', function () { toggleLock('anchor'); });
        dom.alignLock.addEventListener('click', function () { toggleLock('align'); });
    }

    function padRun(b, call) {
        if (b.classList.contains('busy')) return;
        b.classList.add('busy');
        host(call, function (res) {
            b.classList.remove('busy');
            flash(b, !!res.success);
            say(res.message || (res.success ? 'Done' : 'That did not work.'), res.success ? 'success' : 'error');
        });
    }

    /** Lock on: the next anchor / align you press is locked. Lock off: the selected layers are released (they stay put) */
    function toggleLock(what) {
        var k = what + 'Lock', btn = what === 'anchor' ? dom.anchorLock : dom.alignLock;
        opt[k] = !opt[k];
        saveOpt();
        lockState(btn, opt[k]);
        if (opt[k]) { say(what === 'anchor' ? 'Lock on: the anchor point you press next stays locked on that point' : 'Lock on: the alignment you press next stays locked to the composition', 'info'); return; }
        host('$._dalaSuite.layout.unlock(' + q({ what: what }) + ')', function (res) {
            say(res.success && res.data && res.data.count ? res.message : 'Lock off' + (res.success ? '' : ': ' + res.message), res.success ? 'info' : 'error');
        });
    }

    // ------------------------------------------------------------------ Select (layer types of the active comp)

    function selectPop(b) {
        openPop(b, '<div class="gp-cap">Select layers</div>' +
            '<button type="button" class="gp-btn" id="gpCheck">CHECK COMPOSITION</button>' +
            '<div class="gp-state" id="gpCompState">Checking the active composition\u2026</div><div class="gp-list" id="gpTypes"></div>' +
            '<div class="gp-note">Selects them in the timeline of the active comp, ready for effects, delete or edits.</div>', function (p) {
            var compId = null;
            function render(res) {
                var box = p.querySelector('#gpTypes'), st = p.querySelector('#gpCompState');
                box.innerHTML = '';
                if (!res.success || !res.data || !res.data.hasComp) { st.textContent = res.message || 'Open a composition first.'; compId = null; return; }
                compId = res.data.compId;
                st.textContent = res.message;
                var rows = [['all', 'All layers']].concat(res.data.types);
                rows.forEach(function (t) {
                    var n = res.data.counts[t[0]] || 0, r = document.createElement('button');
                    r.type = 'button';
                    r.className = 'gp-row gp-type' + (t[0] === 'all' ? ' main' : '');
                    r.disabled = !n;
                    r.innerHTML = '<span>' + esc(t[1]) + '</span><b>' + (n ? n : 'none') + '</b>';
                    r.title = n ? 'Select the ' + n + ' ' + t[1].toLowerCase() + ' in the timeline' : 'This composition has no ' + t[1].toLowerCase();
                    r.addEventListener('click', function () {
                        host('$._dalaSuite.general.selectType(' + q({ type: t[0], compId: compId }) + ')', function (r2) {
                            say(r2.message, r2.success ? 'success' : 'error');
                            if (r2.success) closePop();
                        });
                    });
                    box.appendChild(r);
                });
            }
            function check() { p.querySelector('#gpCompState').textContent = 'Checking the active composition\u2026'; host('$._dalaSuite.general.layerTypes()', render); }
            p.querySelector('#gpCheck').addEventListener('click', check);
            check();
        });
    }

    // ------------------------------------------------------------------ Gradient Lock

    function gradPop(b) {
        openPop(b, '<div class="gp-cap">Gradient lock</div>' +
            '<div class="gp-note">Gradient Ramp, 4-Color Gradient and shape gradient fills / strokes keep their place inside the layer when the text or shape changes later.</div>' +
            '<button type="button" class="gp-btn main" id="gpGradLock">LOCK GRADIENTS</button>' +
            '<button type="button" class="gp-btn" id="gpGradFree">RELEASE</button>', function (p) {
            p.querySelector('#gpGradLock').addEventListener('click', function () { closePop(); runHost('gradlock', '$._dalaSuite.layout.gradient(' + q({ lock: true }) + ')'); });
            p.querySelector('#gpGradFree').addEventListener('click', function () { closePop(); runHost('gradlock', '$._dalaSuite.layout.gradient(' + q({ lock: false }) + ')'); });
        });
    }

    // ------------------------------------------------------------------ Gap Finder

    function gapsPop(b) {
        openPop(b, '<div class="gp-cap">Gap finder</div>' +
            '<div class="gp-note">The empty stretches between the clips (the selected clips, or every clip). Closing moves the later clips back.</div>' +
            '<button type="button" class="gp-btn" id="gpFind">FIND GAPS</button>' +
            '<div class="gp-state" id="gpGapState"></div><div class="gp-list" id="gpGaps"></div>' +
            '<div class="gp-two"><button type="button" class="gp-btn" id="gpCloseSel" disabled>CLOSE SELECTED</button>' +
            '<button type="button" class="gp-btn main" id="gpCloseAll" disabled>CLOSE ALL</button></div>', function (p) {
            var compId = null, list = [];
            function render(res) {
                var box = p.querySelector('#gpGaps');
                box.innerHTML = '';
                p.querySelector('#gpGapState').textContent = res.message || '';
                list = (res.success && res.data && res.data.gaps) || [];
                compId = res.data ? res.data.compId : null;
                list.forEach(function (g) {
                    var r = document.createElement('label');
                    r.className = 'gp-gap';
                    r.innerHTML = '<input type="checkbox" data-i="' + g.i + '" checked><span>' + esc(g.tc) + '</span><small>' + g.frames + (g.frames === 1 ? ' frame' : ' frames') + '</small><button type="button" class="gp-go" title="Go to this gap">Go</button>';
                    r.querySelector('.gp-go').addEventListener('click', function (e) { e.preventDefault(); host('$._dalaSuite.general.goTo(' + q({ time: g.from }) + ')', function () {}); });
                    box.appendChild(r);
                });
                p.querySelector('#gpCloseSel').disabled = !list.length;
                p.querySelector('#gpCloseAll').disabled = !list.length;
            }
            function close(which) {
                var pick = which;
                if (which === 'sel') { pick = []; Array.prototype.forEach.call(p.querySelectorAll('#gpGaps input:checked'), function (c) { pick.push(+c.getAttribute('data-i')); }); if (!pick.length) { say('Tick the gaps to close.', 'info'); return; } }
                host('$._dalaSuite.general.gaps(' + q({ close: pick, compId: compId }) + ')', function (res) {
                    say(res.message, res.success ? 'success' : 'error');
                    if (res.success) render({ success: true, message: res.data.gaps.length ? res.data.gaps.length + ' gap' + (res.data.gaps.length === 1 ? '' : 's') + ' left' : 'No gaps left', data: res.data });
                });
            }
            p.querySelector('#gpFind').addEventListener('click', function () { host('$._dalaSuite.general.gaps(' + q({}) + ')', render); });
            p.querySelector('#gpCloseSel').addEventListener('click', function () { close('sel'); });
            p.querySelector('#gpCloseAll').addEventListener('click', function () { close('all'); });
            host('$._dalaSuite.general.gaps(' + q({}) + ')', render);
        });
    }

    // ------------------------------------------------------------------ Black Frames

    var blackJob = null;
    /** FFmpeg's blackframe filter over one footage span: cb(err, [file times of black frames], source fps) */
    function blackFrames(exe, sp, cb) {
        var args = ['-hide_banner', '-nostdin', '-ss', Math.max(0, sp.from).toFixed(6), '-i', sp.file, '-t', Math.max(0.04, sp.to - sp.from).toFixed(6), '-map', '0:v:0', '-an', '-sn', '-dn',
            '-vf', 'scale=160:-2,blackframe=amount=98:threshold=32', '-f', 'null', '-'];
        var child, err = '', found = [], fps = 0, buf = '';
        try { child = node('child_process').spawn(exe, args, { windowsHide: true }); } catch (e) { cb('Could not start FFmpeg: ' + e.message); return; }
        if (blackJob) blackJob.child = child;
        child.stderr.on('data', function (d) {
            buf += String(d);
            var ls = buf.split(/\r?\n/); buf = ls.pop();
            ls.forEach(function (l) {
                var m = /pblack:\d+ pts:\d+ t:([\d.]+)/.exec(l);
                if (m) found.push(+m[1] + sp.from);
                var f = !fps && /Stream #0:\d+.*Video:.*?, ([\d.]+) (?:fps|tbr)/.exec(l);
                if (f) fps = +f[1];
                err = l || err;
            });
        });
        child.on('error', function (e) { cb('Could not start FFmpeg: ' + e.message); });
        child.on('close', function (code) { if (blackJob && blackJob.cancelled) return; cb(code === 0 ? null : 'FFmpeg could not read ' + sp.file + ': ' + err, found, fps || 25); });
    }

    function blackPop(b) {
        if (blackJob) {
            openPop(b, '<div class="gp-cap">Black frames</div><div class="gp-state" id="gpBlackState">' + esc(blackJob.state || 'Scanning\u2026') + '</div>' +
                '<button type="button" class="gp-btn" id="gpBlackStop">Stop the scan</button>', function (p) {
                p.querySelector('#gpBlackStop').addEventListener('click', function () { blackJob.cancelled = true; try { if (blackJob.child) blackJob.child.kill(); } catch (e) {} blackJob = null; busy.black = false; $('gen-black').classList.remove('busy'); closePop(); say('Scan stopped', 'info'); });
            });
            return;
        }
        openPop(b, '<div class="gp-cap">Black frames</div>' +
            '<div class="gp-note">Finds frames no clip covers (also inside precomps) and black pictures in the footage, from the first clip to the last.</div>' +
            '<div class="gp-sub">Scan</div>' + seg('blackRange', opt.blackRange, [['comp', 'Whole comp'], ['work', 'Work area']]) +
            check('blackMarks', opt.blackMarks, 'Mark them on the timeline', 'red comp markers, replaced on each scan') +
            '<button type="button" class="gp-btn main" id="gpBlackGo">SCAN</button><div class="gp-list" id="gpBlackList"></div>', function (p) {
            bindOpts(p);
            if (lastBlack) showBlack(p, lastBlack);
            p.querySelector('#gpBlackGo').addEventListener('click', function () { closePop(); scanBlack(b); });
        });
    }
    var lastBlack = null;
    function showBlack(p, res) {
        var box = p.querySelector('#gpBlackList');
        if (!box) return;
        box.innerHTML = '';
        res.ranges.forEach(function (r) {
            var row = document.createElement('div');
            row.className = 'gp-gap';
            row.innerHTML = '<span>' + esc(r.tc) + '</span><small>' + r.frames + (r.frames === 1 ? ' frame' : ' frames') + ' \u00B7 ' + esc(r.why) + '</small><button type="button" class="gp-go" title="Go to this frame">Go</button>';
            row.querySelector('.gp-go').addEventListener('click', function () { host('$._dalaSuite.general.goTo(' + q({ time: r.from }) + ')', function () {}); });
            box.appendChild(row);
        });
    }
    function scanBlack(b) {
        var L = linkSetup();
        busy.black = true;
        b.classList.add('busy');
        blackJob = { cancelled: false, state: 'Reading the timeline\u2026' };
        var job = blackJob;
        info(job.state);
        function done(msg, ok) { if (job.cancelled) return; blackJob = null; busy.black = false; flash(b, ok); info(IDLE); say(msg, ok ? 'success' : 'error'); }
        host('$._dalaSuite.general.blackScan(' + q({ range: opt.blackRange }) + ')', function (res) {
            if (job.cancelled) return;
            if (!res.success) { done(res.message, false); return; }
            var d = res.data, fd = d.frameDuration, frames = {}, why = {};
            d.empty.forEach(function (e) { for (var f = Math.round(e.from / fd); f < Math.round(e.to / fd); f++) { frames[f] = true; why[f] = 'no clip covers it'; } });
            // the same file span once
            var spans = [], seen = {};
            d.spans.forEach(function (sp) { var k = sp.file + '|' + sp.from.toFixed(3) + '|' + sp.to.toFixed(3); if (!seen[k]) { seen[k] = []; spans.push(sp); } seen[k].push(sp); });
            function finishScan(note) {
                var list = Object.keys(frames).map(Number).sort(function (x, y) { return x - y; }), ranges = [];
                list.forEach(function (f) { var r = ranges[ranges.length - 1]; if (r && r.to === f && r.why === why[f]) r.to = f + 1; else ranges.push({ from: f, to: f + 1, why: why[f] }); });
                var out = ranges.map(function (r) { var t = r.from * fd, fps = Math.round(1 / fd), s = Math.floor(r.from / fps), pad = function (n) { return (n < 10 ? '0' : '') + n; };
                    return { from: t, to: r.to * fd, frames: r.to - r.from, why: r.why, tc: Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(r.from % fps) }; });
                lastBlack = { ranges: out };
                var msg = out.length ? out.length + ' black stretch' + (out.length === 1 ? '' : 'es') + ' (' + list.length + ' frame' + (list.length === 1 ? '' : 's') + '), first at ' + out[0].tc : 'No black frames between the clips';
                msg += note || '';
                if (opt.blackMarks) host('$._dalaSuite.general.blackMarkers(' + q({ compId: d.compId, ranges: out }) + ')', function () { done(msg + (out.length ? ' \u00B7 marked on the timeline' : ''), true); });
                else done(msg, true);
            }
            if (!spans.length || !L) { finishScan(!L && spans.length ? ' (footage pictures not checked: FFmpeg needs Node.js)' : ''); return; }
            function withFfmpeg(exe) {
                var i = 0, failed = 0;
                (function next() {
                    if (job.cancelled) return;
                    if (i >= spans.length) { finishScan((failed ? ' \u00B7 ' + failed + ' file' + (failed === 1 ? '' : 's') + ' could not be read' : '') + (d.remapped ? ' \u00B7 ' + d.remapped + ' time-remapped clip' + (d.remapped === 1 ? '' : 's') + ' checked for coverage only' : '')); return; }
                    var sp = spans[i++];
                    job.state = 'Looking for black pictures: clip ' + i + ' of ' + spans.length + '\u2026';
                    info(job.state);
                    blackFrames(exe, sp, function (e, times, fps) {
                        if (job.cancelled) return;
                        if (e) failed++;
                        (seen[sp.file + '|' + sp.from.toFixed(3) + '|' + sp.to.toFixed(3)] || [sp]).forEach(function (use) {
                            (times || []).forEach(function (ft) {
                                var c0 = use.a + use.b * ft, c1 = use.a + use.b * (ft + 1 / fps);
                                for (var f = Math.ceil(c0 / fd - 1e-6); f < Math.ceil(c1 / fd - 1e-6); f++) {
                                    if (f * fd < use.compFrom - 1e-6 || f * fd >= use.compTo - 1e-6) continue;
                                    if (!frames[f]) { frames[f] = true; why[f] = 'black picture in \u201C' + use.name + '\u201D'; }
                                }
                            });
                        });
                        next();
                    });
                })();
            }
            if (L.hasFfmpeg()) withFfmpeg(L.paths.ffmpeg);
            else {
                job.state = 'Getting FFmpeg (only once)\u2026';
                info(job.state);
                L.ffmpeg(function (t) { job.state = t; info(t); }, function (e, exe) { if (e) finishScan(' (footage pictures not checked: FFmpeg could not be downloaded)'); else withFfmpeg(exe); });
            }
        });
    }

    // ------------------------------------------------------------------ Clean Up

    var cleanApi = null, cleanJob = null, cleanScan = null;
    function fmtSize(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' B'; }
    function cleanSetup() {
        if (cleanApi) return cleanApi;
        var N = { fs: node('fs'), path: node('path'), os: node('os'), cp: node('child_process') };
        if (!N.fs || !N.cp || !root.DalaCleanup) return null;
        var proc = (typeof root.process !== 'undefined' && root.process) || node('process');
        cleanApi = root.DalaCleanup.create(N, (proc && proc.env) || {});
        return cleanApi;
    }
    function cleanPop(b) {
        var C = cleanSetup();
        if (!C) { say('Clean Up needs Node.js in the panel (After Effects 2020 or newer).', 'error'); return; }
        openPop(b, '<div class="gp-cap">Clean up old projects</div>' +
            '<div class="gp-note">Finds what older projects left behind and frees the space. Everything the open project uses is kept; project files, footage and models are never touched.</div>' +
            '<button type="button" class="gp-btn" id="gpCleanScan">SCAN</button>' +
            '<div class="gp-state" id="gpCleanState"></div><div class="gp-list" id="gpCleanList"></div>' +
            '<div class="gp-sticky"><button type="button" class="gp-btn main" id="gpCleanGo" disabled>CLEAN UP</button></div>', function (p) {
            var armed = false, disarm = null, st = p.querySelector('#gpCleanState'), go = p.querySelector('#gpCleanGo');
            function picked() { return Array.prototype.filter.call(p.querySelectorAll('#gpCleanList input:checked'), function () { return true; }).map(function (c) { return c.getAttribute('data-k'); }); }
            /** bytes of the ticked groups (no side effects) */
            function sum() {
                var keys = picked(), t = 0;
                (cleanScan ? cleanScan.groups : []).forEach(function (g) { if (keys.indexOf(g.key) >= 0) t += g.bytes; });
                return t;
            }
            /** the button back to its plain state (a changed tick, a new scan, the confirm timing out) */
            function total() {
                var t = sum();
                armed = false;
                if (disarm) { clearTimeout(disarm); disarm = null; }
                go.classList.remove('armed');
                go.disabled = !t;
                go.textContent = t ? 'CLEAN UP ' + fmtSize(t) : 'CLEAN UP';
                return t;
            }
            function render() {
                var box = p.querySelector('#gpCleanList');
                box.innerHTML = '';
                if (!cleanScan) return;
                cleanScan.groups.forEach(function (g) {
                    var r = document.createElement('label');
                    r.className = 'gp-opt gp-clean';
                    var has = g.files.length > 0;
                    r.innerHTML = '<input type="checkbox" data-k="' + g.key + '"' + (has && g.on ? ' checked' : '') + (has ? '' : ' disabled') + '><span>' + esc(g.label) +
                        ' <b>' + (has ? fmtSize(g.bytes) : 'nothing') + '</b><small>' + (has ? g.files.length + ' file' + (g.files.length === 1 ? '' : 's') + ' \u00B7 ' : '') + esc(g.note) +
                        (g.kept ? ' \u00B7 ' + g.kept + ' kept for the open project' : '') + '</small></span>';
                    r.querySelector('input').addEventListener('change', total);
                    box.appendChild(r);
                });
                total();
            }
            function scan() {
                if (cleanJob) return;
                st.textContent = 'Reading the open project\u2026';
                go.disabled = true;
                cleanJob = { what: 'scan' };
                host('$._dalaSuite.general.cleanupInfo()', function (res) {
                    if (!res.success) { cleanJob = null; st.textContent = res.message; return; }
                    C.scan(res.data, function (t) { st.textContent = t; }, function (e, groups) {
                        cleanJob = null;
                        if (e) { st.textContent = 'The scan failed: ' + (e.message || e); return; }
                        cleanScan = { info: res.data, groups: groups };
                        var all = groups.reduce(function (a, g) { return a + g.bytes; }, 0);
                        st.textContent = all ? fmtSize(all) + ' can be freed' + (res.data.project ? '' : ' (the open project is not saved yet: only its footage is kept)') : 'Nothing to clean up.';
                        render();
                    });
                });
            }
            p.querySelector('#gpCleanScan').addEventListener('click', scan);
            go.addEventListener('click', function () {
                if (!cleanScan || cleanJob) return;
                var keys = picked(), t = sum();
                if (!t) return;
                // first press: arm (the size stays on the button, red); a second press within 8 s cleans up
                if (!armed) {
                    armed = true;
                    go.classList.add('armed');
                    go.textContent = 'PRESS AGAIN TO DELETE ' + fmtSize(t);
                    st.textContent = 'Press the button once more to clean up ' + fmtSize(t) + '.';
                    disarm = setTimeout(function () { if (armed && !cleanJob) { total(); st.textContent = 'Not cleaned: press CLEAN UP twice to confirm.'; } }, 8000);
                    return;
                }
                if (disarm) { clearTimeout(disarm); disarm = null; }
                armed = false;
                go.classList.remove('armed');
                cleanJob = { what: 'clean' };
                go.disabled = true;
                go.textContent = 'CLEANING UP\u2026';
                Array.prototype.forEach.call(p.querySelectorAll('#gpCleanList input, #gpCleanScan'), function (x) { x.disabled = true; });
                b.classList.add('busy');
                C.clean(cleanScan.groups, keys, cleanScan.info, host, function (t2) { st.textContent = t2; go.textContent = t2; info(t2); }, function (e, r) {
                    cleanJob = null;
                    b.classList.remove('busy');
                    p.querySelector('#gpCleanScan').disabled = false;
                    info(IDLE);
                    var msg = e ? 'Clean up failed: ' + (e.message || e) : 'Freed ' + fmtSize(r.freed) + (r.recycled ? ' \u00B7 ' + r.recycled + ' file' + (r.recycled === 1 ? '' : 's') + ' in the Recycle Bin (empty it to free that space too)' : '') +
                        (r.failed ? ' \u00B7 ' + r.failed + ' in use, left' : '');
                    st.textContent = msg;
                    flash(b, !e);
                    say(msg, e ? 'error' : 'success');
                    cleanScan = null;
                    p.querySelector('#gpCleanList').innerHTML = '';
                    go.textContent = 'CLEAN UP';
                });
            });
            if (cleanScan) render(); else scan();
        });
    }

    // ------------------------------------------------------------------ the buttons

    function r(x, y, w, h) { return 'M' + x + ' ' + y + 'h' + w + 'v' + h + 'h-' + w + 'z'; }
    var TOOLS = [
        { id: 'curves', label: 'Curves', page: true, desc: 'Curves: draw the ease between keyframes, read the keys, save your own; apply to the selected keyframes.',
          icon: 'M3 20c6 0 6-16 18-16v2C11 6 11 22 3 22v-2z', run: function () { showPage('curves'); } },
        { id: 'text', label: 'Text', desc: 'Text: a centred white text layer, above the selected layer.',
          icon: 'M5 4h14v4h-2V6h-4v12h2v2H9v-2h2V6H7v2H5V4z', run: createLayer('text') },
        { id: 'precomp', label: 'Precomp', desc: 'Precomp: the selected layers go into a new comp, trimmed to their length. Several layers: all together or each on its own.',
          icon: r(3, 5, 18, 14) + 'M5 7v10h14V7H5z' + r(8, 10, 8, 4), run: function (b) { doPrecomp(b); } },
        { id: 'precompEach', label: 'Precomp each', desc: 'Precomp each: every selected layer goes into its own precomp, trimmed to its length.',
          icon: r(2, 5, 9, 14) + 'M4 7v10h5V7H4z' + r(13, 5, 9, 14) + 'M15 7v10h5V7h-5z', run: function () { precompRun(true); } },
        { id: 'decomp', label: 'Decomp', desc: 'Decomp: brings the layers of the selected precomps back into this comp, timing and position kept.',
          icon: r(3, 3, 8, 8) + r(13, 3, 8, 8) + r(3, 13, 8, 8) + 'M14 16h3v-3l5 4.5-5 4.5v-3h-3v-3z',
          run: function () { runHost('decomp', '$._dalaSuite.unprecompose.run(' + q({ removeItem: !!opt.removeItem }) + ')'); } },
        { id: 'copyfx', label: 'Copy fx', desc: 'Copy fx: remembers the effects (with their keyframes) and the look of the selected layer.',
          icon: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
          run: function () { runHost('copyfx', '$._dalaSuite.edit.copyFx()'); } },
        { id: 'pastefx', label: 'Paste fx', desc: 'Paste fx: puts the copied effects and look on every selected layer (what exactly: in the options).',
          icon: 'M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z',
          run: function () { runHost('pastefx', '$._dalaSuite.edit.pasteFx(' + q(pasteOpts()) + ')'); } },
        { id: 'duplicate', label: 'Duplicate', desc: 'Duplicate: an independent copy of the selected precomp; editing inside it never changes the original.',
          icon: r(8, 8, 13, 13) + 'M10 10v9h9v-9h-9z' + 'M3 3h13v3h-2V5H5v9h1v2H3V3z', run: function () {
              runHost('duplicate', '$._dalaSuite.edit.duplicate(' + q({ mode: opt.dupMode, deep: !!opt.dupDeep }) + ')'); } },
        { id: 'null', label: 'Null', desc: 'Null: one null on each selected layer, with its timing; each layer is parented to its own null without moving.',
          icon: 'M4 4h16v16H4V4zm2 2v12h12V6H6z', run: createLayer('null') },
        { id: 'solid', label: 'Solid', dot: true, desc: 'Solid: pick a colour, then one comp-sized solid above each selected layer, with its timing.',
          icon: r(4, 4, 16, 16), run: function (b) { solidPicker(b); } },
        { id: 'adjust', label: 'Adjust', desc: 'Adjust: one adjustment layer above each selected layer, with its in / out points.',
          icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 2v14a7 7 0 010-14z', run: createLayer('adjustment') },
        { id: 'link', label: 'Link', desc: 'Link: paste a TikTok, YouTube, Instagram, Pinterest or X link; the video (or the picture, or the sound) lands in the comp.',
          icon: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
          run: function (b) { linkPicker(b); } },
        { id: 'beatcheck', label: 'Beat Checker', desc: 'Beat Checker: a coloured solid from each beat marker to the next, so the colour changes show the beats while you listen.',
          icon: r(3, 3, 1.5, 18) + r(5.5, 7, 5, 10) + r(11.25, 3, 1.5, 18) + r(13.5, 7, 5, 10) + r(19.5, 3, 1.5, 18),
          run: function () { runHost('beatcheck', '$._dalaSuite.general.beatCheck()'); } },
        { id: 'arrange', label: 'Beat Clips Arranger', desc: 'Beat Clips Arranger: the footage / precomp clips are laid one per beat interval (beat markers), in their current order. Audio is not touched.',
          icon: r(2, 4, 7, 4) + r(9, 10, 7, 4) + r(16, 16, 6, 4) + r(8.25, 2, 1.5, 20) + r(15.25, 2, 1.5, 20),
          run: function () { runHost('arrange', '$._dalaSuite.general.arrangeClips()'); } },
        { id: 'sequence', label: 'Sequence Layers', desc: 'Sequence Layers: the selected video clips one after another in their layer order, the first at its own start, each keeping its length - no gaps, no overlaps.',
          icon: r(2, 5, 7, 4) + r(9, 10, 6, 4) + r(15, 15, 7, 4) + 'M2 20h20v1.5H2z',
          run: function () { runHost('sequence', '$._dalaSuite.general.sequence()'); } },
        { id: 'select', label: 'Select', desc: 'Select: every video, audio, text, shape, adjustment, solid, null, camera, light or precomp layer of the active comp, in one click (CHECK COMPOSITION lists what it has).',
          icon: 'M4 4h4v2H6v2H4zM10 4h4v2h-4zM16 4h4v4h-2V6h-2zM4 10h2v4H4zM18 10h2v3h-2zM4 16h2v2h2v2H4zM10 18h3v2h-3zM14 13l7 3-3 1.2 2.8 2.8-1.4 1.4-2.8-2.8L15.4 21z',
          run: function (b) { selectPop(b); } },
        { id: 'gradlock', label: 'Gradient Lock', desc: 'Gradient Lock: gradients (Gradient Ramp, 4-Color Gradient, shape gradient fills) keep their place inside the layer when the text or shape changes later.',
          icon: 'M3 4h12v16H3z M5 6v12h8V6z M7 8h4v2H7zM7 12h4v2H7z M17 13h1v-1.5a2.5 2.5 0 0 1 5 0V13h1v8h-7zm2.5-3a1 1 0 0 0-1 1V13h2v-1.5a1 1 0 0 0-1-1z',
          run: function (b) { gradPop(b); } },
        { id: 'organise', label: 'Organise Project', desc: 'Organise Project: comps, precomps, video, audio, images and solids into tidy folders. Only the folders change: footage links, comps and expressions stay as they are.',
          icon: 'M3 5h7l2 2h9v3H3zM3 11h18v8H3z M6 14h5v2H6z',
          run: function () { runHost('organise', '$._dalaSuite.general.organise()'); } },
        { id: 'gaps', label: 'Gap Finder', desc: 'Gap Finder: the empty stretches between clips; close all of them or the ones you tick - the later clips move back.',
          icon: r(2, 9, 7, 6) + r(15, 9, 7, 6) + 'M10 11.2h4v1.6h-4z M11 7l1-2 1 2zM11 17l1 2 1-2z',
          run: function (b) { gapsPop(b); } },
        { id: 'black', label: 'Black Frames', desc: 'Black Frames: finds black frames between and inside clips and shows where they are on the timeline (markers + a list to jump to).',
          icon: r(2, 5, 20, 14) + 'M4 7v10h16V7z' + r(10, 7, 4, 10),
          run: function (b) { blackPop(b); } },
        { id: 'cleanup', label: 'Clean Up', desc: 'Clean Up: frees the space older projects take - After Effects caches, their auto-saves, Dala Suite files and temp files - and keeps everything the open project uses.',
          icon: 'M15 4h-2V2h-2v2H9v2h6V4zM6 7h12l-1 14H7L6 7zm3 3v8h1.5v-8H9zm4.5 0v8H15v-8h-1.5z',
          run: function (b) { cleanPop(b); } }
    ];

    var IDLE = 'Hover a tool to see what it does.';
    function info(text) { if (dom.info) dom.info.textContent = text; }

    function renderGrid() {
        dom.grid.innerHTML = '';
        TOOLS.forEach(function (t) {
            var b = document.createElement('button');
            b.className = 'gen-tile';
            b.id = 'gen-' + t.id;
            b.type = 'button';
            b.title = t.desc;
            b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + t.icon + '"/></svg><span>' + t.label + '</span>' +
                (t.page ? '<i class="gen-more" aria-hidden="true">›</i>' : '') + (t.dot ? '<i class="gen-dot" style="background:' + opt.solid + '"></i>' : '');
            b.addEventListener('mouseenter', function () { if (!busy[t.id] && !busy.link && !busy.black) info(t.desc); });
            b.addEventListener('mouseleave', function () { if (!busy.link && !busy.black) info(IDLE); });
            b.addEventListener('click', function () { if (!busy[t.id] || t.id === 'link' || t.id === 'black' || t.id === 'cleanup') t.run(b); });
            dom.grid.appendChild(b);
        });
    }

    function showPage(p) {
        closePop();
        page = p;
        var curves = p === 'curves';
        dom.main.style.display = curves ? 'none' : '';
        dom.page.style.display = curves ? '' : 'none';
        dom.back.style.display = curves ? '' : 'none';
        dom.title.textContent = curves ? 'Curves' : 'General';
        if (curves) root.DalaCurves.render(dom.page, { host: host, q: q, say: say, pop: openPop, closePop: closePop });
        else { root.DalaCurves.stop(); dom.page.innerHTML = ''; }
    }

    function init() {
        if (!$('gen-card')) return;
        try { cs = new root.CSInterface(); } catch (e) { cs = null; }
        dom = { grid: $('gen-grid'), info: $('gen-info'), page: $('gen-page'), back: $('gen-back'), title: $('gen-title'), opts: $('gen-opts'), main: $('gen-main'),
            anchor: $('gen-anchor'), align: $('gen-align'), anchorLock: $('gen-anchor-lock'), alignLock: $('gen-align-lock') };
        var qg = $('quick-general');
        if (qg) qg.addEventListener('click', function () { var n = document.querySelector('.nav-item[data-view="general"]'); if (n) n.click(); });
        dom.back.addEventListener('click', function () { showPage('grid'); });
        dom.opts.addEventListener('click', function () { optionsPop(dom.opts); });
        root.addEventListener('resize', function () { fitPop(); if (page === 'curves') root.DalaCurves.resize(); });
        renderAA();
        renderGrid();
        info(IDLE);
        // the Curves page redraws when the GENERAL tab comes back into view
        var nav = document.querySelector('.nav-item[data-view="general"]');
        if (nav) nav.addEventListener('click', function () { if (page === 'curves') setTimeout(function () { root.DalaCurves.render(dom.page, { host: host, q: q, say: say, pop: openPop, closePop: closePop }); }, 30); });
    }

    root.DalaGeneral = { tools: function () { return TOOLS.slice(); }, run: function (id) { var b = $('gen-' + id); if (b) b.click(); }, page: showPage, options: function () { return opt; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
