/**
 * CFX Suite - Auto Captions > CUSTOM: caption styles made from the user's own text animation (ES5, Node in the panel)
 *
 *   CHECK SELECTED LAYER          host captionPresets.check(): what the selected layers / precomps make - each
 *                                 precomp with text is one look, the other selected layers together one more look
 *   CREATE CAPTION PRESET STYLE   host captionPresets.capture() records every look as a layer recipe (fonts,
 *                                 character and paragraph settings, effects, keyframes, expressions, everything in
 *                                 the precomps); here each look gets its profile (text parts, their order, sizes and
 *                                 roles, the look's intent and strength - what tools/make_caption_styles.py does for
 *                                 the built-in Text Presets) and the preview is made: the real caption build of a
 *                                 sample line per look in a small comp (host captions.preview), rendered to frames
 *   SAVE PRESET / rename / delete the style lives in %APPDATA%\CFXSuite\caption-presets\<id> (style.json = a style
 *                                 family like txt-preset-1.json, preset.json, preview\f_*.jpg, thumb.jpg) and shows
 *                                 up in the CAPTION STYLE tab next to the built-in styles
 */
(function (root) {
    'use strict';

    var cs = null, N = null, dom = {};
    var S = { check: null, draft: null, busy: false, playTimer: null };
    var STEP = 0.1, PW = 480, PH = 270;      // preview: a frame every 0.1 s, 480 x 270

    function req(m) {
        try {
            if (typeof root.require === 'function') return root.require(m);
            if (root.cep_node && typeof root.cep_node.require === 'function') return root.cep_node.require(m);
        } catch (e) {}
        return null;
    }
    function nodeOk() {
        if (N) return true;
        var fs = req('fs'), path = req('path'), os = req('os');
        if (fs && path && os) N = { fs: fs, path: path, os: os };
        return !!N;
    }
    function $(id) { return document.getElementById(id); }
    function toast(m, t) { if (root.CFXToast) root.CFXToast(m, t); }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function host(call, arg, cb) {
        var expr = '$._cfxSuite.' + call + '(' + (arg === undefined ? '' : JSON.stringify(JSON.stringify(arg))) + ')';
        if (!cs) { cb({ success: false, message: 'After Effects is not connected.' }); return; }
        cs.evalScript(expr, function (raw) {
            var res;
            try { res = JSON.parse(raw); } catch (e) { res = { success: false, message: (raw && raw !== 'undefined') ? String(raw) : 'After Effects did not answer.' }; }
            cb(res);
        });
    }

    // ------------------------------------------------------------------ files

    function baseDir() {
        var proc = root.process || req('process'), env = (proc && proc.env) || {};
        return N.path.join(env.APPDATA || N.path.join(N.os.homedir(), 'AppData', 'Roaming'), 'CFXSuite', 'caption-presets');
    }
    function mkdirs(p) {
        if (N.fs.existsSync(p)) return;
        mkdirs(N.path.dirname(p));
        N.fs.mkdirSync(p);
    }
    function rmrf(p) {
        try {
            if (!N.fs.existsSync(p)) return;
            if (N.fs.statSync(p).isDirectory()) {
                N.fs.readdirSync(p).forEach(function (n) { rmrf(N.path.join(p, n)); });
                N.fs.rmdirSync(p);
            } else N.fs.unlinkSync(p);
        } catch (e) {}
    }
    function readJson(p) { try { return JSON.parse(N.fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
    function writeJson(p, o) { N.fs.writeFileSync(p, JSON.stringify(o)); }
    function fileUrl(p) {
        return 'file:///' + String(p).replace(/\\/g, '/').split('/').map(function (seg, i) {
            return (i === 0 && /^[A-Za-z]:$/.test(seg)) ? seg : encodeURIComponent(seg);
        }).join('/');
    }

    /** Saved custom styles (newest first), as CAPTION STYLE entries. */
    function list() {
        if (!nodeOk()) return [];
        var dir = baseDir(), out = [];
        try { if (!N.fs.existsSync(dir)) return []; } catch (e) { return []; }
        N.fs.readdirSync(dir).forEach(function (n) {
            var p = readJson(N.path.join(dir, n, 'preset.json'));
            if (p && !p.draft && N.fs.existsSync(N.path.join(dir, n, 'style.json'))) out.push(entryOf(p, N.path.join(dir, n)));
        });
        out.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
        return out;
    }
    function entryOf(p, dir) {
        return { id: p.id, name: p.name, kind: 'family', custom: true, path: N.path.join(dir, 'style.json'), dir: dir,
            about: p.about, styles: p.styles, needs: p.needs || {}, fonts: p.fonts || [], created: p.created, looks: p.looks,
            comp: p.comp, seconds: p.seconds, step: p.step || STEP,
            frames: (p.frames || []).map(function (f) { return fileUrl(N.path.join(dir, 'preview', f)); }),
            thumbUrl: p.thumb ? fileUrl(N.path.join(dir, p.thumb)) : '' };
    }
    /** Drafts (created, never saved) older than a day are removed. */
    function sweepDrafts() {
        try {
            var dir = baseDir();
            if (!N.fs.existsSync(dir)) return;
            N.fs.readdirSync(dir).forEach(function (n) {
                var d = N.path.join(dir, n), p = readJson(N.path.join(d, 'preset.json'));
                if ((!p || p.draft) && Date.now() - N.fs.statSync(d).mtime.getTime() > 864e5) rmrf(d);
            });
        } catch (e) {}
    }

    // ------------------------------------------------------------------ recipe fixes and profile
    // (the same rules tools/make_caption_styles.py applies to the built-in Text Presets)

    var DEEP_GLOW_FALLBACK = {
        why: "Deep Glow (a third-party plug-in) is not installed, so the captions use After Effects' own Glow instead (close, but not identical). Install Deep Glow for the exact look.",
        recipe: { mn: 'ADBE Glo2', name: 'Glow', g: 1, c: [
            { mn: 'ADBE Glo2-0001', name: 'Glow Based On', t: 6012, v: 2 }, { mn: 'ADBE Glo2-0002', name: 'Glow Threshold', t: 6012, v: 153 },
            { mn: 'ADBE Glo2-0003', name: 'Glow Radius', t: 6012, v: 90 }, { mn: 'ADBE Glo2-0004', name: 'Glow Intensity', t: 6012, v: 0.8 }] }
    };
    var VENDORS = [[/^S_/, 'Sapphire'], [/^PEDG$/, 'Deep Glow'], [/^BCC/, 'Boris FX BCC'], [/^Pseudo\/MHAC/, 'Animation Composer']];
    function adobeFx(mn) { return /^(ADBE |CC |APC |ADBE)/.test(mn); }

    function walk(n, fn, path) {
        path = path || [];
        fn(n, path);
        (n.c || []).forEach(function (c) { walk(c, fn, path.concat([n])); });
    }
    function child(n, mn) { var c = (n && n.c) || [], i; for (i = 0; i < c.length; i++) if (c[i].mn === mn) return c[i]; return null; }
    function eachLayer(rec, fn) {
        rec.layers.forEach(fn);
        Object.keys(rec.comps || {}).forEach(function (k) { (rec.comps[k].layers || []).forEach(fn); });
    }

    function fixRecipe(rec) {
        eachLayer(rec, function (L) {
            if (!L.props) return;
            walk(L.props, function (n) {
                if (n.expr && n.expr.indexOf('Fade In+Out - frames') >= 0) {
                    n.expr = n.expr.replace(/effect\("Fade In\+Out - frames"\)\("Fade In Duration \(frames\)"\)/g, 'effect("Fade In+Out - frames")(1)')
                        .replace(/effect\("Fade In\+Out - frames"\)\("Fade Out Duration \(frames\)"\)/g, 'effect("Fade In+Out - frames")(2)');
                }
                if (n.mn === 'PEDG') n.c = (n.c || []).filter(function (c) { return c.g || (c.v !== undefined && (typeof c.v === 'number' || c.v instanceof Array)); });
                if (n.mn === 'ADBE Text Animator') {
                    var sels = child(n, 'ADBE Text Selectors');
                    ((sels && sels.c) || []).forEach(function (s) {
                        if (s.mn !== 'ADBE Text Expressible Selector') return;
                        var amt = child(s, 'ADBE Text Expressible Amount');
                        if (amt && amt.bakeTag) n.bakeTag = amt.bakeTag;
                    });
                }
            });
        });
        rec.fallbacks = { PEDG: DEEP_GLOW_FALLBACK };
        return rec;
    }

    function textDoc(L) {
        var t = child(L.props, 'ADBE Text Properties'), d = t ? child(t, 'ADBE Text Document') : null;
        if (!d) return null;
        if (d.v && d.v.textDocument) return d.v.textDocument;
        var k = (d.keys || [])[0];
        return (k && k.v && k.v.textDocument) || null;
    }
    function staticVal(prop, at) {
        if (!prop) return null;
        if (prop.v !== undefined) return prop.v;
        var ks = prop.keys || (prop.bk && prop.bk.keys) || [];
        if (!ks.length) return prop.bk ? prop.bk.v : null;
        if (at === undefined) return ks[ks.length - 1].v;
        var best = ks[0];
        ks.forEach(function (k) { if (k.t <= at) best = k; });
        return best.v;
    }
    function markersOf(L) {
        var m = child(L.props, 'ADBE Marker'), out = {};
        ((m && m.keys) || []).forEach(function (k) {
            var c = (k.v && k.v.marker && k.v.marker.comment) || '';
            if (c === 'TR In' || c === 'TR Out') out[c] = k.t - L.startTime;
        });
        return out;
    }
    function effectsOf(L) {
        var fx = child(L.props, 'ADBE Effect Parade');
        return ((fx && fx.c) || []).map(function (c) { return { mn: c.mn, name: c.name }; });
    }
    function needsOf(rec, into) {
        eachLayer(rec, function (L) {
            effectsOf(L).forEach(function (e) {
                if (!e.mn || adobeFx(e.mn)) return;
                var vendor = null;
                VENDORS.forEach(function (v) { if (!vendor && v[0].test(e.mn)) vendor = v[1]; });
                vendor = vendor || e.name || e.mn;
                into[vendor] = into[vendor] || [];
                if (into[vendor].indexOf(e.mn) < 0) into[vendor].push(e.mn);
            });
        });
        return into;
    }
    function fontsOf(rec, into) {
        eachLayer(rec, function (L) {
            var td = L.kind === 'text' ? textDoc(L) : null;
            if (td && td.font && into.indexOf(td.font) < 0) into.push(td.font);
        });
        return into;
    }
    function intentOf(t) { t = t.trim(); return /\?\s*$/.test(t) ? 'question' : (/!\s*$/.test(t) ? 'exclaim' : 'calm'); }
    function oneLine(t) { return String(t).replace(/\r/g, ' ').replace(/\s+/g, ' ').trim(); }

    /** The caption director's view of a look: its text parts in reading order (layers, sample text, size, role,
     *  timing), the intent of its sample and how strong it is. */
    function profileOf(rec, fps) {
        var outer = rec.layers[0], inner = rec.comps[outer.source.comp], layers = inner.layers, groups = {}, order = [];
        layers.forEach(function (L, i) {
            var td = L.kind === 'text' ? textDoc(L) : null;
            if (!td) return;
            var key = oneLine(td.text).toLowerCase();
            if (!groups[key]) { groups[key] = []; order.push(key); }
            groups[key].push({ i: i, L: L, td: td });
        });
        var slots = order.map(function (key) {
            var ms = groups[key], L = ms[0].L, td = ms[0].td, T = child(L.props, 'ADBE Transform Group');
            var sc = staticVal(child(T, 'ADBE Scale')) || [100, 100], pos = staticVal(child(T, 'ADBE Position'), (L.inPoint + L.outPoint) / 2) || [0, 0];
            var size = (td.fontSize || 50) * ((sc instanceof Array) ? sc[0] : 100) / 100, mk = {}, text = String(td.text || '');
            ms.forEach(function (m) { var x = markersOf(m.L); Object.keys(x).forEach(function (k) { mk[k] = x[k]; }); });
            return { layers: ms.map(function (m) { return m.i + 1; }), text: text, size: Math.round(size * 100) / 100, font: td.font,
                inPoint: Math.round(Math.min.apply(null, ms.map(function (m) { return m.L.inPoint; })) * 1000) / 1000,
                outPoint: Math.round(Math.max.apply(null, ms.map(function (m) { return m.L.outPoint; })) * 1000) / 1000,
                y: Math.round(((pos instanceof Array) ? pos[1] : 0) * 100) / 100, chars: oneLine(text).length,
                lines: text.split('\r').length, words: oneLine(text).split(' ').filter(Boolean).length,
                caps: text === text.toUpperCase() && text !== text.toLowerCase(), lower: text === text.toLowerCase(), tr: mk };
        });
        if (!slots.length) return null;
        slots.sort(function (a, b) { return (Math.round(a.inPoint / 0.2) - Math.round(b.inPoint / 0.2)) || (a.y - b.y); });
        var biggest = Math.max.apply(null, slots.map(function (s) { return s.size; }));
        slots.forEach(function (s) { s.role = s.size >= biggest * 0.8 ? 'hero' : 'small'; });
        // a look with one text part may take a second line: a long caption then keeps its size instead of shrinking
        // to the width of the (usually short) line it was designed with. Looks with more parts keep their layout
        // (a second line would run into the part above or below).
        if (slots.length === 1) slots[0].lines = Math.max(2, slots[0].lines);
        var sample = slots.map(function (s) { return oneLine(s.text); }).join(' ');
        var fx = effectsOf(outer).map(function (e) { return e.mn; });
        layers.forEach(function (L) { fx = fx.concat(effectsOf(L).map(function (e) { return e.mn; })); });
        var strong = fx.filter(function (mn) { return /^(S_Texture|ADBE Fractal Noise|ADBE Tritone|ADBE Bevel Alpha|ADBE Gaussian Blur 2)/.test(mn || ''); }).length;
        var overshoot = layers.some(function (L) { return effectsOf(L).some(function (e) { return /W4O/.test(e.name || ''); }); });
        var caps = slots.filter(function (s) { return s.role === 'hero'; }).every(function (s) { return s.caps; });
        var energy = Math.min(3, (biggest >= 130 ? 1 : 0) + (strong >= 2 ? 1 : 0) + (caps ? 1 : 0) + (overshoot ? 1 : 0));
        return { slots: slots, sample: sample, intent: intentOf(sample), energy: energy, hero: caps && energy >= 2,
            dur: inner.dur, w: inner.w, h: inner.h, fps: inner.fps || fps, words: sample.split(' ').filter(Boolean).length, chars: sample.length };
    }

    /** The captured looks as a style family (the form of captions/styles/txt-preset-*.json). */
    function familyOf(cap, id, name) {
        var styles = [], needs = {}, fonts = [], used = {}, skipped = [];
        cap.looks.forEach(function (rec, i) {
            fixRecipe(rec);
            var prof = profileOf(rec, cap.fps);
            if (!prof) { skipped.push(rec.style); return; }
            var sid = String(rec.style || 'look').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'look';
            if (used[sid]) sid += '_' + (i + 1);
            used[sid] = 1;
            needsOf(rec, needs);
            fontsOf(rec, fonts);
            styles.push({ id: sid, span: rec.span || [0, prof.dur], profile: prof, recipe: rec });
        });
        return { family: { version: 1, id: id, name: name, custom: true, about: aboutOf(styles.length, cap.comp),
            generated: 'CFX Suite CUSTOM from ' + cap.comp + ' (' + cap.project + ')', needs: needs, fonts: fonts.sort(), styles: styles }, skipped: skipped };
    }
    function aboutOf(n, comp) { return 'Your own style from "' + comp + '": ' + n + ' look' + (n === 1 ? '' : 's') + (n > 1 ? ', picked line by line' : ''); }

    // ------------------------------------------------------------------ preview

    /** One sample caption per look (its own text), timed like spoken lines, placed by the director in order. */
    function previewPlan(fam) {
        var caps = [], t = 0.3, n = Math.min(fam.styles.length, 6), i;
        for (i = 0; i < n; i++) {
            var st = fam.styles[i], p = st.profile, D = Math.max(2.2, Math.min(3.6, (st.span[1] - st.span[0]) || p.dur || 3));
            var text = oneLine(p.sample) || 'YOUR CAPTION HERE', ws = text.split(' '), s = t + 0.45, e = s + Math.max(0.7, D * 0.45);
            var len = 0, acc = 0, words = [];
            ws.forEach(function (w) { len += w.length + 1; });
            ws.forEach(function (w) { var a = s + (e - s) * acc / len; acc += w.length + 1; words.push({ w: w, s: a, e: s + (e - s) * acc / len }); });
            caps.push({ id: (i + 1 < 10 ? '0' : '') + (i + 1), s: s, e: e, lines: [text], words: words });
            t += D;
        }
        return { captions: caps, assign: root.DalaCaptionDirector.direct(caps, fam, { mode: 'order' }), dur: Math.round((t + 0.9) * 10) / 10 };
    }

    /** Waits until every frame exists and its size stopped changing (After Effects 26 writes them in the
     *  background), then cb(true) - or cb(false) after timeoutMs. */
    function waitFrames(paths, timeoutMs, cb) {
        var last = {}, stable = {}, t0 = Date.now();
        (function poll() {
            var all = true;
            paths.forEach(function (p) {
                var n = -1;
                try { n = N.fs.statSync(p).size; } catch (e) {}
                stable[p] = (n > 0 && last[p] === n) ? (stable[p] || 0) + 1 : 0;
                last[p] = n;
                if (stable[p] < 2) all = false;
            });
            if (all) { cb(true); return; }
            if (Date.now() - t0 > timeoutMs) { cb(false); return; }
            setTimeout(poll, 150);
        })();
    }

    /** PNG frames -> small JPEGs (canvas): a few MB per style instead of tens. */
    function toJpegs(pngs, outDir, cb) {
        mkdirs(outDir);
        var names = [], i = 0, cv = document.createElement('canvas'), g;
        cv.width = PW; cv.height = PH; g = cv.getContext('2d');
        (function next() {
            if (i >= pngs.length) { cb(null, names); return; }
            var img = new Image(), src = pngs[i];
            img.onload = function () {
                try {
                    g.drawImage(img, 0, 0, PW, PH);
                    var b64 = cv.toDataURL('image/jpeg', 0.82).split(',')[1], nm = 'f_' + ('00' + i).slice(-3) + '.jpg', B = req('buffer').Buffer;
                    N.fs.writeFileSync(N.path.join(outDir, nm), B.from ? B.from(b64, 'base64') : new B(b64, 'base64'));
                    names.push(nm);
                } catch (e) { cb(e); return; }
                i++;
                setTimeout(next, 0);
            };
            img.onerror = function () { cb(new Error('A preview frame could not be read: ' + src)); };
            // read through Node as a data URL: a file:// image would taint the canvas (no toDataURL then)
            try { img.src = 'data:image/png;base64,' + N.fs.readFileSync(src).toString('base64'); } catch (eR) { cb(eR); }
        })();
    }

    /** Builds the preview of the family in dir: frames in dir/preview, dir/thumb.jpg. cb(err, { frames, seconds, warnings }). */
    function makePreview(fam, dir, onStatus, cb) {
        var plan = previewPlan(fam), planPath = N.path.join(dir, 'preview-plan.json'), pngDir = N.path.join(dir, 'frames-png');
        writeJson(planPath, { captions: plan.captions, assign: plan.assign });
        onStatus('Building the preview captions in After Effects…');
        host('captions.preview', { familyPath: N.path.join(dir, 'style.json').replace(/\\/g, '/'), planPath: planPath.replace(/\\/g, '/'),
            outDir: pngDir.replace(/\\/g, '/'), dur: plan.dur, w: PW, h: PH, fps: 30, step: STEP }, function (res) {
            if (!res.success) { cb(new Error(res.message)); return; }
            var R = res.data;
            onStatus('Rendering the preview (' + R.frames.length + ' frames)…');
            waitFrames(R.frames, 120000, function (ok) {
                host('captions.previewCleanup', { compId: R.compId, had: R.had }, function () {
                    if (!ok) { cb(new Error('After Effects did not finish the preview frames.')); return; }
                    onStatus('Saving the preview…');
                    toJpegs(R.frames, N.path.join(dir, 'preview'), function (err, names) {
                        rmrf(pngDir);
                        rmrf(planPath);
                        if (err) { cb(err); return; }
                        // the thumbnail: the first look, fully shown (just after its line is spoken)
                        var c0 = plan.captions[0], at = Math.min(names.length - 1, Math.round((c0.e + 0.35) / STEP));
                        try { N.fs.writeFileSync(N.path.join(dir, 'thumb.jpg'), N.fs.readFileSync(N.path.join(dir, 'preview', names[at]))); } catch (eT) {}
                        cb(null, { frames: names, seconds: Math.round(names.length * STEP * 10) / 10, warnings: R.warnings || [] });
                    });
                });
            });
        });
    }

    // ------------------------------------------------------------------ preview player (also used by CAPTION STYLE)

    var players = [];
    /** Plays an entry's frames in img (a flip-book at the frame step); bar (optional) shows the progress. */
    function play(img, entry, bar) {
        stop(img);
        var frames = entry.frames || [];
        if (!frames.length) return false;
        var pre = frames.map(function (u) { var im = new Image(); im.src = u; return im; }), i = 0;
        var timer = setInterval(function () {
            img.src = frames[i];
            if (bar) { bar.style.animation = 'none'; bar.style.width = Math.round((i + 1) / frames.length * 100) + '%'; }
            i = (i + 1) % frames.length;
        }, Math.round((entry.step || STEP) * 1000));
        players.push({ img: img, timer: timer, pre: pre });
        img.src = frames[0];
        return true;
    }
    function stop(img) {
        players = players.filter(function (p) { if (p.img === img) { clearInterval(p.timer); return false; } return true; });
    }

    // ------------------------------------------------------------------ CUSTOM tab

    function setState(msg, kind) { dom.state.textContent = msg || ''; dom.state.className = 'at-note cap-note' + (kind ? ' cc-' + kind : ''); }
    function setBusy(b) {
        S.busy = b;
        dom.check.disabled = b;
        dom.create.disabled = b || !S.check;
        dom.save.disabled = b;
        dom.discard.disabled = b;
    }

    function reportHtml(d) {
        var h = '<div class="cc-report-head">' + d.looks.length + ' look' + (d.looks.length === 1 ? '' : 's') + ' in "' + esc(d.comp) + '"</div>';
        d.looks.forEach(function (L, i) {
            var fx = L.effects.map(function (e) { return esc(e.name) + (e.adobe ? '' : '*'); });
            h += '<div class="cc-look"><b>' + (i + 1) + '. ' + esc(L.name) + '</b> <span class="cc-kind">' + (L.kind === 'precomp' ? 'precomp' : L.layers + ' layer' + (L.layers === 1 ? '' : 's')) + '</span>' +
                '<div class="cc-facts">' + L.texts + ' text layer' + (L.texts === 1 ? '' : 's') + ' · ' + L.keyed + ' animated propert' + (L.keyed === 1 ? 'y' : 'ies') +
                (L.expressions ? ' · ' + L.expressions + ' expression' + (L.expressions === 1 ? '' : 's') : '') + ' · ' + L.dur + ' s' +
                (fx.length ? '<br>Effects: ' + fx.join(', ') : '') + (L.fonts.length ? '<br>Fonts: ' + L.fonts.map(esc).join(', ') : '') +
                (L.samples.length ? '<br>Text: "' + esc(L.samples.slice(0, 3).join('", "')) + '"' : '') + '</div>' +
                L.notes.map(function (n) { return '<div class="cc-warn">' + esc(n) + '</div>'; }).join('') + '</div>';
        });
        var third = d.looks.some(function (L) { return L.effects.some(function (e) { return !e.adobe; }); });
        if (third) h += '<div class="cc-foot">* not part of After Effects: on a PC without it the look builds without that effect (Deep Glow falls back to Glow).</div>';
        if (d.ignored && d.ignored.length) h += '<div class="cc-foot">Not used (no text with them): ' + d.ignored.map(esc).join(', ') + '</div>';
        if (d.deep && d.deep.length) h += '<div class="cc-foot">Not used (text only in a deeper precomp): ' + d.deep.map(esc).join(', ') + '</div>';
        return h;
    }

    function checkSelected() {
        if (S.busy) return;
        if (!nodeOk()) { setState('Restart After Effects: this panel cannot save caption styles.', 'bad'); return; }
        S.check = null;
        setBusy(true);
        setState('Checking the selected layers…');
        host('captionPresets.check', undefined, function (res) {
            setBusy(false);
            dom.report.style.display = 'none';
            if (!res.success) { setState(res.message, 'bad'); dom.create.disabled = true; return; }
            S.check = res.data;
            dom.report.innerHTML = reportHtml(res.data);
            dom.report.style.display = '';
            dom.create.disabled = false;
            setState('Ready. Press Create caption preset style to capture ' + (res.data.looks.length === 1 ? 'this look' : 'these ' + res.data.looks.length + ' looks') + ' and preview it.', 'ok');
        });
    }

    function uniqueName(base) {
        var names = list().map(function (e) { return e.name.toLowerCase(); }), n = base, k = 2;
        while (names.indexOf(n.toLowerCase()) >= 0) n = base + ' (' + (k++) + ')';
        return n;
    }

    function createPreset() {
        if (S.busy || !S.check) return;
        discardDraft(true);
        var id = 'custom-' + Date.now(), dir = N.path.join(baseDir(), id), capPath = N.path.join(dir, 'capture.json');
        try { mkdirs(dir); } catch (e) { setState('Cannot write ' + dir + ': ' + e.message, 'bad'); return; }
        setBusy(true);
        setState('Capturing your layers (fonts, text, effects, keyframes, precomps)…');
        host('captionPresets.capture', { out: capPath.replace(/\\/g, '/') }, function (res) {
            if (!res.success) { setBusy(false); rmrf(dir); setState(res.message, 'bad'); return; }
            var cap = readJson(capPath);
            if (!cap || !cap.looks || !cap.looks.length) { setBusy(false); rmrf(dir); setState('The captured layers could not be read.', 'bad'); return; }
            var name = uniqueName(cap.looks.length === 1 ? String(cap.looks[0].style || cap.comp) : cap.comp + ' style');
            var made = familyOf(cap, id, name), fam = made.family;
            if (!fam.styles.length) { setBusy(false); rmrf(dir); setState('No look has a text layer Dala can put caption words into.', 'bad'); return; }
            try { writeJson(N.path.join(dir, 'style.json'), fam); rmrf(capPath); } catch (eW) { setBusy(false); rmrf(dir); setState('Saving the style failed: ' + eW.message, 'bad'); return; }
            makePreview(fam, dir, setState, function (err, pv) {
                setBusy(false);
                if (err) { rmrf(dir); setState('The preview failed: ' + err.message, 'bad'); return; }
                var meta = { id: id, name: name, draft: true, created: Date.now(), comp: cap.comp, project: cap.project, looks: fam.styles.length,
                    styles: fam.styles.map(function (s) { return s.id; }), needs: fam.needs, fonts: fam.fonts, about: fam.about,
                    frames: pv.frames, step: STEP, seconds: pv.seconds, thumb: 'thumb.jpg' };
                writeJson(N.path.join(dir, 'preset.json'), meta);
                S.draft = { dir: dir, meta: meta };
                dom.name.value = name;
                dom.draft.style.display = '';
                dom.chip.textContent = fam.styles.length + ' look' + (fam.styles.length === 1 ? '' : 's');
                play(dom.anim, entryOf(meta, dir), dom.bar);
                var warn = (pv.warnings || []).concat(made.skipped.length ? ['Left out (no text layer inside): ' + made.skipped.join(', ')] : []);
                setState('This is how your captions will look. Name it and press Save preset.' + (warn.length ? ' Note: ' + warn.join(' ') : ''), 'ok');
                dom.name.focus();
                dom.name.select();
            });
        });
    }

    function saveDraft() {
        var D = S.draft;
        if (!D || S.busy) return;
        var name = dom.name.value.replace(/\s+/g, ' ').trim();
        if (!name) { setState('Give the style a name first.', 'bad'); dom.name.focus(); return; }
        if (list().some(function (e) { return e.name.toLowerCase() === name.toLowerCase(); })) { setState('A style called "' + name + '" exists already: pick another name.', 'bad'); return; }
        D.meta.name = name;
        D.meta.draft = false;
        try {
            var fam = readJson(N.path.join(D.dir, 'style.json'));
            fam.name = name;
            writeJson(N.path.join(D.dir, 'style.json'), fam);
            writeJson(N.path.join(D.dir, 'preset.json'), D.meta);
        } catch (e) { setState('Saving failed: ' + e.message, 'bad'); return; }
        S.draft = null;
        stop(dom.anim);
        dom.draft.style.display = 'none';
        dom.report.style.display = 'none';
        S.check = null;
        dom.create.disabled = true;
        setState('Saved "' + name + '". It is in the CAPTION STYLE tab now, ready for Generate captions.', 'ok');
        toast('Caption style "' + name + '" saved.', 'success');
        changed(D.meta.id);
    }

    function discardDraft(quiet) {
        var D = S.draft;
        if (!D) return;
        S.draft = null;
        stop(dom.anim);
        rmrf(D.dir);
        dom.draft.style.display = 'none';
        if (!quiet) setState('Discarded.');
    }

    // ------------------------------------------------------------------ my styles

    function changed(selectId) { if (root.DalaCaptionsUI && root.DalaCaptionsUI.stylesChanged) root.DalaCaptionsUI.stylesChanged(selectId); renderList(); }

    var ICON = {
        play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        edit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
        del: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
    };

    function renderList() {
        if (!dom.list) return;
        var items = list();
        dom.list.innerHTML = items.length ? '' : '<div class="cc-empty">No custom styles yet.</div>';
        items.forEach(function (e) {
            var row = document.createElement('div');
            row.className = 'cc-item';
            row.innerHTML = '<span class="cc-thumb"><img alt="" src="' + esc(e.thumbUrl) + '"></span>' +
                '<span class="cc-meta"><span class="cc-nm"></span><span class="cc-sub"></span></span>' +
                '<span class="cc-acts"><button type="button" class="cc-btn" data-a="play" title="Preview">' + ICON.play + '</button>' +
                '<button type="button" class="cc-btn" data-a="rename" title="Rename">' + ICON.edit + '</button>' +
                '<button type="button" class="cc-btn cc-del" data-a="delete" title="Delete">' + ICON.del + '</button></span>';
            row.querySelector('.cc-nm').textContent = e.name;
            row.querySelector('.cc-sub').textContent = e.looks + ' look' + (e.looks === 1 ? '' : 's') + (e.comp ? ' · from ' + e.comp : '');
            row.querySelector('[data-a="play"]').addEventListener('click', function () { playInList(row, e); });
            row.querySelector('[data-a="rename"]').addEventListener('click', function () { renameRow(row, e); });
            var del = row.querySelector('[data-a="delete"]'), armed = null;
            del.addEventListener('click', function () {
                if (!armed) {
                    del.classList.add('armed');
                    del.title = 'Click again to delete';
                    setState('Click the delete button again to delete "' + e.name + '".');
                    armed = setTimeout(function () { armed = null; del.classList.remove('armed'); del.title = 'Delete'; }, 4000);
                    return;
                }
                clearTimeout(armed);
                rmrf(e.dir);
                setState('Deleted "' + e.name + '".');
                changed();
            });
            dom.list.appendChild(row);
        });
    }

    function playInList(row, e) {
        var img = row.querySelector('.cc-thumb img');
        if (row.classList.contains('playing')) { stop(img); row.classList.remove('playing'); img.src = e.thumbUrl; return; }
        Array.prototype.forEach.call(dom.list.querySelectorAll('.cc-item.playing'), function (r) { r.querySelector('.cc-btn[data-a="play"]').click(); });
        row.classList.add('playing');
        play(img, e);
    }

    function renameRow(row, e) {
        var nm = row.querySelector('.cc-nm');
        if (row.querySelector('input')) return;
        var inp = document.createElement('input');
        inp.className = 'form-input cc-rename';
        inp.maxLength = 40;
        inp.value = e.name;
        nm.style.display = 'none';
        nm.parentNode.insertBefore(inp, nm);
        inp.focus();
        inp.select();
        function done(save) {
            if (!inp.parentNode) return;
            var v = inp.value.replace(/\s+/g, ' ').trim();
            inp.parentNode.removeChild(inp);
            nm.style.display = '';
            if (!save || !v || v === e.name) return;
            if (list().some(function (x) { return x.id !== e.id && x.name.toLowerCase() === v.toLowerCase(); })) { setState('A style called "' + v + '" exists already.', 'bad'); return; }
            try {
                var pj = N.path.join(e.dir, 'preset.json'), meta = readJson(pj), fam = readJson(e.path);
                meta.name = v; fam.name = v;
                writeJson(pj, meta); writeJson(e.path, fam);
            } catch (er) { setState('Renaming failed: ' + er.message, 'bad'); return; }
            setState('Renamed to "' + v + '".', 'ok');
            changed();
        }
        inp.addEventListener('keydown', function (ev) { if (ev.keyCode === 13) done(true); if (ev.keyCode === 27) done(false); });
        inp.addEventListener('blur', function () { done(true); });
    }

    function onShow() { renderList(); }

    function init() {
        if (!$('cap-tab-custom')) return;
        try { cs = new root.CSInterface(); } catch (e) { cs = null; }
        if (!nodeOk()) return;
        dom.check = $('cc-check'); dom.report = $('cc-report'); dom.create = $('cc-create'); dom.state = $('cc-state');
        dom.draft = $('cc-draft'); dom.anim = $('cc-anim'); dom.bar = $('cc-bar'); dom.chip = $('cc-chip');
        dom.name = $('cc-name'); dom.save = $('cc-save'); dom.discard = $('cc-discard'); dom.list = $('cc-list');
        if (dom.check) dom.check.addEventListener('click', checkSelected);
        if (dom.create) dom.create.addEventListener('click', createPreset);
        if (dom.save) dom.save.addEventListener('click', saveDraft);
        if (dom.discard) dom.discard.addEventListener('click', function () { discardDraft(false); });
        if (dom.name) dom.name.addEventListener('keydown', function (ev) { if (ev.keyCode === 13) saveDraft(); });
        sweepDrafts();
    }

    root.CFXCustomStyles = root.DalaCustomStyles = { list: list, play: play, stop: stop, onShow: onShow, profileOf: profileOf, familyOf: familyOf, previewPlan: previewPlan, state: function () { return S; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
