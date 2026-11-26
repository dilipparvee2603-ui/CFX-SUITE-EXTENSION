/**
 * CFX Suite - Auto Captions (ExtendScript host side, ECMAScript 3)
 *
 * Driven by client/js/captions/captionsUI.js:
 *   info()            comp, work area and audio state (selected audio layer / precomp) for the panel
 *   renderAudio()     renders the work area's audio to an AIFF with the render queue (optionally only the
 *                     selected layers' audio, e.g. the dialogue clip or a precomp holding it)
 *   build()           one caption per line, in the chosen caption style:
 *                     Woodl Style (captions/styles/CFX-default.json): one text layer per caption
 *                       - the style's text layer is built once in the comp and duplicated, so every caption
 *                         keeps its exact animators, effects and expressions
 *                       - each layer starts with its reveal, the style's lead before its line is spoken, and
 *                         runs to the next line's speech start, so one line sweeps out while the next one
 *                         reveals (the timing reference: green / blue / pink boxes)
 *                       - the style's keyframes are placed for that span, each group on its own keyframes
 *                         (all still free to drag): reveal (fade in), sweep out (fade out), tracking
 *                     update: { gen, ids } rebuilds the captions of an earlier build (all of them, or only the
 *                     ids listed) after the caption lines were edited in the panel; renumber: { oldId: newId }
 *                     first gives the build's layers their new numbers (a caption was inserted)
 *   timeline()        Check timeline: the time indicator and the CFX captions of the active comp
 *                     a style family (Text Preset 1 / 2, captions/styles/txt-preset-*.json): one precomp per
 *                     caption in the look the director picked (client/js/captions/captionDirector.js), its
 *                     words in that look's text slots, each slot revealed when its words are spoken
 *   removeCaptions()  "Clear created layers": deletes only the layers CFX built in the comp (and their comps)
 */

$._cfxSuite.captions = (function () {
    var TAG = "cfx-caption";

    // caption timing (seconds); the rest comes from the preset itself
    var FADE_OUT_BEFORE_SPEECH_END = 0.55;   // style families: the sweep-out begins this long before the line finishes
    var FADE_OUT_MAX = 2.5;                  // longest sweep-out, so a long pause holds the full line
    var TRACKING_PAST_END = 0.25;            // tracking keeps opening right up to the layer's end
    var LAST_LINE_HOLD = 1.0;                // the last caption stays this long after its speech
    var MIN_REVEAL = 0.35;                   // fade-in reaches full no sooner than this after the speech start
    var REVEAL_LEAD = 0.467;                 // Woodl's reveal lead before the speech (timing reference): custom looks without one

    function R(success, message, data) { return $._cfxSuite.formatResult(success, message, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : json; }

    var lastCompId = null;
    /** The comp to caption. activeItem is null while a floating panel has focus, so fall back to the comp
     *  in the active viewer, then to the last comp seen. */
    function activeComp() {
        var c = app.project ? app.project.activeItem : null;
        if (c && c instanceof CompItem) { lastCompId = c.id; return c; }
        try {
            var v = app.activeViewer;
            if (v && v.type === ViewerType.VIEWER_COMPOSITION) {
                v.setActive();
                c = app.project.activeItem;
                if (c && c instanceof CompItem) { lastCompId = c.id; return c; }
            }
        } catch (eV) {}
        if (lastCompId !== null) {
            c = findItemById(lastCompId);
            if (c && c instanceof CompItem) return c;
        }
        return null;
    }
    function findItemById(id) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            try { if (it.id === id) return it; } catch (e) {}
        }
        return null;
    }
    function readUtf8(path) {
        var f = new File(path);
        if (!f.exists) return null;
        f.encoding = "UTF-8";
        if (!f.open("r")) return null;
        var s = f.read(); f.close();
        if (s && s.charCodeAt(0) === 0xFEFF) s = s.substring(1);
        return s;
    }
    function isCaption(L) { try { return String(L.comment || "").indexOf(TAG) === 0; } catch (e) { return false; } }
    function hasAudio(L) { try { return L.hasAudio && L.audioEnabled; } catch (e) { return false; } }
    function isPrecomp(L) { try { return L.source instanceof CompItem; } catch (e) { return false; } }

    // ------------------------------------------------------------------ info

    function info() {
        try {
            var comp = activeComp();
            if (!comp) return R(true, "No active composition.", { hasComp: false });
            var audio = 0, selAudio = [], caps = 0, i;
            var ws = comp.workAreaStart, we = ws + comp.workAreaDuration;
            for (i = 1; i <= comp.numLayers; i++) {
                var L = comp.layer(i);
                if (isCaption(L)) caps++;
                if (hasAudio(L) && L.outPoint > ws && L.inPoint < we) audio++;
            }
            var sel = comp.selectedLayers;
            for (i = 0; i < sel.length; i++) if (hasAudio(sel[i])) selAudio.push({ name: sel[i].name, precomp: isPrecomp(sel[i]) });
            return R(true, "ok", {
                hasComp: true, compId: comp.id, compName: comp.name, width: comp.width, height: comp.height,
                fps: comp.frameRate, workStart: ws, workDuration: comp.workAreaDuration,
                audioLayers: audio, selectedAudio: selAudio, captions: caps
            });
        } catch (e) { return R(false, e.toString()); }
    }

    // ------------------------------------------------------------------ audio

    function renderAudio(json) {
        var a = parse(json);
        var comp = activeComp();
        if (!comp) return R(false, "Open the composition you want to caption first.");
        var ws = comp.workAreaStart, wd = comp.workAreaDuration, we = ws + wd, i;
        // a little audio either side of the work area gives Whisper the context of a sentence the work area
        // cuts into (otherwise the cut-off fragment's time is given to the first whole word); the panel keeps
        // only the words inside the work area
        var pad = (a.pad === undefined) ? 1.5 : Math.max(0, Number(a.pad) || 0);
        var rs = Math.max(0, ws - pad), re = Math.min(comp.duration, we + pad);
        // an explicit span (Audio tools: the selected layer's own in / out points) instead of the work area
        if (a.rangeStart !== undefined && a.rangeEnd !== undefined && a.rangeEnd > a.rangeStart) {
            ws = rs = Math.max(0, Number(a.rangeStart)); we = re = Math.min(comp.duration, Number(a.rangeEnd));
        }
        var audioLayers = [], selected = [];
        for (i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (hasAudio(L) && L.outPoint > ws && L.inPoint < we) audioLayers.push(L);
        }
        if (!audioLayers.length) return R(false, "There is no audio in this comp's work area. Add the dialogue clip or precomp (audio switched on) and try again.");
        var sel = comp.selectedLayers;
        for (i = 0; i < sel.length; i++) if (hasAudio(sel[i])) selected.push(sel[i]);

        var muted = [];
        if (a.selectedOnly && selected.length) {
            for (i = 0; i < audioLayers.length; i++) {
                var keep = false;
                for (var j = 0; j < selected.length; j++) if (selected[j] === audioLayers[i]) keep = true;
                if (!keep) { try { audioLayers[i].audioEnabled = false; muted.push(audioLayers[i]); } catch (eM) {} }
            }
        }

        var rq = app.project.renderQueue, saved = [], rqItem = null, savedDST = null, produced = null, err = "";
        for (i = 1; i <= rq.numItems; i++) {
            var it = rq.item(i);
            saved.push({ item: it, render: it.render });
            try { it.render = false; } catch (e0) {}
        }
        try {
            // the render span is read against a zero ruler start; only touched when it is not zero already
            try { if (comp.displayStartTime !== 0) { savedDST = comp.displayStartTime; comp.displayStartTime = 0; } } catch (eD) { savedDST = null; }
            rqItem = rq.items.add(comp);
            try { rqItem.timeSpanStart = rs; rqItem.timeSpanDuration = re - rs; } catch (eT) {}
            var om = rqItem.outputModule(1), names = om.templates, tpl = null, pats = [/aiff/i, /wav/i, /audio only/i, /\baudio\b/i], p, t;
            for (p = 0; p < pats.length && !tpl; p++) for (t = 0; t < names.length; t++) if (pats[p].test(names[t])) { tpl = names[t]; break; }
            if (!tpl) throw new Error("After Effects has no audio output template (AIFF / WAV).");
            om.applyTemplate(tpl);
            var outFile = new File(a.out);
            try { if (outFile.exists) outFile.remove(); } catch (eRm) {}
            om.file = outFile;
            rqItem.render = true;
            rq.render();
            try { if (om.file && om.file.exists) produced = om.file.fsName; } catch (eF) {}
            if (!produced) {
                var stem = outFile.name.replace(/\.[^.]+$/, "");
                var found = outFile.parent.getFiles(function (f) { return (f instanceof File) && f.name.indexOf(stem) === 0; });
                if (found && found.length) produced = found[0].fsName;
            }
        } catch (eR) {
            err = eR.toString();
        } finally {
            try { if (rqItem) rqItem.remove(); } catch (eX) {}
            try { if (savedDST !== null) comp.displayStartTime = savedDST; } catch (eD2) {}
            for (i = 0; i < saved.length; i++) { try { saved[i].item.render = saved[i].render; } catch (eS) {} }
            for (i = 0; i < muted.length; i++) { try { muted[i].audioEnabled = true; } catch (eU) {} }
            try { comp.openInViewer(); } catch (eV) {}      // the render brings the Render Queue to the front
        }
        if (err) return R(false, "Could not render the audio: " + err);
        if (!produced) return R(false, "The audio render finished but no file was written.");
        var names2 = [];
        for (i = 0; i < selected.length; i++) names2.push(selected[i].name);
        return R(true, "Audio rendered.", {
            path: produced, start: rs, duration: re - rs, workStart: ws, workEnd: we, compId: comp.id, fps: comp.frameRate,
            width: comp.width, height: comp.height, onlySelected: !!(a.selectedOnly && selected.length), layers: names2
        });
    }

    // ------------------------------------------------------------------ caption preset

    /** The caption preset: a layer recipe (captions/styles/CFX-default.json, see host/layerRecipe.jsx). It used
     *  to be an .aep, which After Effects versions older than the one that saved it refuse to open ("created
     *  with After Effects version 2x.0 ... cannot be opened with this version"). Returns { recipe, dur, w, h }. */
    function styleSource(recipePath) {
        var raw = readUtf8(recipePath);
        if (raw === null) throw new Error("Caption preset not found: " + recipePath + ". Reinstall CFX Suite.");
        var rec = $._cfxSuite.parseOwnJson(raw);
        if (!rec.layers || !rec.layers.length) throw new Error("The caption preset is empty. Reinstall CFX Suite.");
        var L0 = rec.layers[0], dur = L0.outPoint - L0.inPoint;
        return { recipe: rec, dur: dur > 0.05 ? dur : 2, w: rec.compSize[0], h: rec.compSize[1] };
    }

    /** Builds the preset's text layer in comp as the (disabled) template for the duplicates. */
    function placeTemplate(st, comp) {
        var sel = comp.selectedLayers, i;
        for (i = 0; i < sel.length; i++) { try { sel[i].selected = false; } catch (eS) {} }
        // built at 1 s so the reveal's lead-in keys (before the layer starts) stay at positive comp times
        var res = $._cfxSuite.recipe.buildLayers(comp, st.recipe, { at: 1, fallbacks: st.recipe.fallbacks || {} });
        if (!res.layers.length) throw new Error("The caption preset could not be built: " + res.warnings.join(" "));
        var L = res.layers[0];
        L.enabled = false;
        // tagged so Clear created layers / Replace also clear a template left behind by an interrupted build
        try { L.comment = TAG + "-template"; } catch (eCm) {}
        try { L.selected = false; } catch (e) {}
        return { layer: L, dur: st.dur, w: st.w, h: st.h, roles: keyRoles(L), upper: !!res.upper[0], warnings: res.warnings };
    }

    // ------------------------------------------------------------------ keyframe groups of the preset

    /** Path from a layer down to a property, by property index (valid on every duplicate of the layer). */
    function propPath(p) {
        var path = [];
        while (p && p.parentProperty) { path.unshift(p.propertyIndex); p = p.parentProperty; }
        return path;
    }
    function propAt(L, path) {
        var p = L;
        for (var i = 0; i < path.length; i++) p = p.property(path[i]);
        return p;
    }

    /** Finds the preset's keyframed properties and what each does, relative to the template layer:
     *    fadeIn   - the opacity sweep that starts first (green box in the timing reference)
     *    fadeOut  - the opacity sweep that starts later (blue box)
     *    tracking - the tracking amount animation (pink box)
     *    other    - anything else keyed: spread over the layer like the preset */
    function keyRoles(L) {
        var sweeps = [], roles = { fadeIn: [], fadeOut: [], tracking: [], other: [] };
        var tIn = L.inPoint;
        function walk(g, inOpacityAnimator) {
            for (var i = 1; i <= g.numProperties; i++) {
                var p = g.property(i);
                if (!p) continue;
                if (p.propertyType === PropertyType.PROPERTY) {
                    var n = 0;
                    try { n = (p.matchName !== "ADBE Marker") ? p.numKeys : 0; } catch (eK) { n = 0; }
                    if (n < 1) continue;
                    var item = { path: propPath(p), t0: p.keyTime(1) - tIn, t1: p.keyTime(n) - tIn };
                    if (p.matchName === "ADBE Text Tracking Amount") roles.tracking.push(item);
                    else if (inOpacityAnimator) sweeps.push(item);
                    else roles.other.push(item);
                } else {
                    var isAnim = p.matchName === "ADBE Text Animator";
                    var hasOp = false;
                    if (isAnim) {
                        try {
                            var op = p.property("ADBE Text Animator Properties").property("ADBE Text Opacity");
                            hasOp = !!op && op.value !== 100;
                        } catch (eO) { hasOp = false; }
                    }
                    walk(p, isAnim ? hasOp : inOpacityAnimator);
                }
            }
        }
        walk(L, false);
        if (sweeps.length) {
            var first = sweeps[0].t0, k;
            for (k = 1; k < sweeps.length; k++) if (sweeps[k].t0 < first) first = sweeps[k].t0;
            for (k = 0; k < sweeps.length; k++) {
                if (sweeps[k].t0 - first < 0.15) roles.fadeIn.push(sweeps[k]); else roles.fadeOut.push(sweeps[k]);
            }
        }
        // the preset's own spacing: how far the reveal starts before the layer, how far the sweep-out
        // finishes before the layer ends
        var dur = L.outPoint - L.inPoint;
        roles.lead = roles.fadeIn.length ? Math.max(0, -roles.fadeIn[0].t0) : 0.45;
        roles.outGap = roles.fadeOut.length ? Math.max(0, dur - roles.fadeOut[0].t1) : 0.1;
        // where the sweep-out starts within the reveal (Woodl: 77 % of the way through it, as in the timing reference)
        var fi = roles.fadeIn[0], fo = roles.fadeOut[0];
        roles.foAt = (fi && fo && fi.t1 - fi.t0 > 0.05) ? Math.max(0.3, Math.min(1, (fo.t0 - fi.t0) / (fi.t1 - fi.t0))) : 0.77;
        roles.dur = dur;
        return roles;
    }

    /** Moves a property's keyframes so the first lands on t0 and the last on t1 (inner ones in proportion),
     *  keeping values, interpolation and ease curves. */
    function setKeySpan(p, t0, t1) {
        var n = p.numKeys, k;
        if (n < 1) return;
        var old0 = p.keyTime(1), old1 = p.keyTime(n);
        var ratio = (n > 1 && old1 - old0 > 1e-6) ? (t1 - t0) / (old1 - old0) : 1;
        var keys = [];
        for (k = 1; k <= n; k++) {
            var d = { t: (n > 1) ? t0 + (p.keyTime(k) - old0) * ratio : t0, v: p.keyValue(k) };
            try { d.ii = p.keyInInterpolationType(k); d.oi = p.keyOutInterpolationType(k); } catch (e1) {}
            try {
                var ie = p.keyInTemporalEase(k), oe = p.keyOutTemporalEase(k), ni = [], no = [];
                for (var e = 0; e < ie.length; e++) {
                    ni.push(new KeyframeEase(ratio > 0 ? ie[e].speed / ratio : ie[e].speed, ie[e].influence));
                    no.push(new KeyframeEase(ratio > 0 ? oe[e].speed / ratio : oe[e].speed, oe[e].influence));
                }
                d.ie = ni; d.oe = no;
            } catch (e2) {}
            keys.push(d);
        }
        while (p.numKeys > 0) p.removeKey(1);
        for (k = 0; k < keys.length; k++) p.setValueAtTime(keys[k].t, keys[k].v);
        for (k = 0; k < keys.length; k++) {
            var idx = k + 1;
            try { if (keys[k].ii !== undefined) p.setInterpolationTypeAtKey(idx, keys[k].ii, keys[k].oi); } catch (e3) {}
            try { if (keys[k].ie) p.setTemporalEaseAtKey(idx, keys[k].ie, keys[k].oe); } catch (e4) {}
        }
    }

    /** Where a caption's keys go, for speech [sIn, sEnd] on a layer [tIn, tOut] (see the timing reference):
     *  green  fade in:  starts at fiStart (the style's lead before the speech; the layer starts with it, so the
     *                   reveal is seen from its first frame), full when the line has been spoken
     *  blue   fade out: starts where the style starts it within the reveal (roles.foAt), gone just before the
     *                   layer ends (the next line's speech start: that line is already revealing by then)
     *  pink   tracking: from the layer start to just past its end */
    function woodlTimes(roles, tIn, tOut, sIn, sEnd, fiStart) {
        var foFull = tOut - roles.outGap;
        var fiFull = Math.min(Math.max(sEnd, sIn + MIN_REVEAL), foFull - 0.15);
        if (fiFull <= fiStart + 0.1) fiFull = fiStart + 0.1;
        // a long hold keeps the whole line up: its sweep-out waits until FADE_OUT_MAX before the end
        var foStart = Math.max(fiStart + roles.foAt * (fiFull - fiStart), foFull - FADE_OUT_MAX, fiStart + 0.1);
        if (foStart > foFull - 0.2) foStart = Math.max(fiStart + 0.05, foFull - 0.2);
        return { fiStart: fiStart, fiFull: fiFull, foStart: foStart, foFull: foFull, trStart: tIn, trEnd: tOut + TRACKING_PAST_END };
    }

    /** Places a caption layer on its span (spansFor) with its keys (woodlTimes). */
    function placeKeys(L, roles, sp) {
        var tIn = sp.tIn, tOut = sp.tOut, k = sp.keys, i;
        L.startTime += tIn - L.inPoint;     // keyframes travel with the layer
        L.inPoint = tIn;
        L.outPoint = tOut;
        for (i = 0; i < roles.fadeIn.length; i++) setKeySpan(propAt(L, roles.fadeIn[i].path), k.fiStart, k.fiFull);
        for (i = 0; i < roles.fadeOut.length; i++) setKeySpan(propAt(L, roles.fadeOut[i].path), k.foStart, k.foFull);
        for (i = 0; i < roles.tracking.length; i++) setKeySpan(propAt(L, roles.tracking[i].path), k.trStart, k.trEnd);
        for (i = 0; i < roles.other.length; i++) {
            var o = roles.other[i], f = (tOut - tIn) / Math.max(0.05, roles.dur);
            setKeySpan(propAt(L, o.path), tIn + o.t0 * f, tIn + o.t1 * f);
        }
    }

    // ------------------------------------------------------------------ text helpers

    function textProp(L) { return L.property("ADBE Text Properties").property("ADBE Text Document"); }

    var fontCache = {};
    function fontAvailable(ps) {
        if (fontCache.hasOwnProperty(ps)) return fontCache[ps];
        var ok = true;
        try {
            if (app.fonts && app.fonts.getFontsByPostScriptName) ok = app.fonts.getFontsByPostScriptName(ps).length > 0;
        } catch (e) { ok = true; }
        fontCache[ps] = ok;
        return ok;
    }
    function pickFont(list) {
        for (var i = 0; i < list.length; i++) if (fontAvailable(list[i])) return list[i];
        return null;
    }

    function setText(L, lines, upper) {
        var st = textProp(L);
        while (st.numKeys > 0) st.removeKey(1);
        var d = st.value;
        d.text = lines.join("\r");
        if (upper) d.text = d.text.toUpperCase();
        st.setValue(d);
    }

    /** Captions written in a non-Latin script need a font that has its letters (the preset font is Latin only). */
    function applyScriptFont(L, fonts) {
        if (!fonts || !fonts.length) return;
        var f = pickFont(fonts);
        if (!f) return;
        try { var st = textProp(L), d = st.value; d.font = f; d.fauxBold = false; st.setValue(d); } catch (e) {}
    }

    // ------------------------------------------------------------------ layout

    function measure(L) {
        // widest moment of the caption (the tracking animation grows it towards the end)
        var fd = 1 / 30, r1 = L.sourceRectAtTime((L.inPoint + L.outPoint) / 2, false), r2 = L.sourceRectAtTime(Math.max(L.inPoint, L.outPoint - fd * 2), false);
        var r = (r2.width > r1.width) ? r2 : r1;
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    /** Centres the text block on its anchor, scales it for the comp and keeps it inside the frame. */
    function place(L, ctx, x, y) {
        var tg = L.property("ADBE Transform Group");
        var r = measure(L);
        var ap = tg.property("ADBE Anchor Point");
        if (ap.numKeys === 0) ap.setValue([r.left + r.width / 2, r.top + r.height / 2]);
        var k = ctx.k;
        var maxW = ctx.W * 0.9;
        if (r.width * k > maxW) k = maxW / Math.max(1, r.width);
        var sc = tg.property("ADBE Scale");
        if (sc.numKeys === 0) sc.setValue([k * 100, k * 100]);
        var pos = tg.property("ADBE Position");
        if (pos.dimensionsSeparated) {
            tg.property("ADBE Position_0").setValue(x);
            tg.property("ADBE Position_1").setValue(y);
        } else if (pos.numKeys === 0) {
            pos.setValue([x, y]);
        }
    }

    // ------------------------------------------------------------------ build

    /** A comp time no caption covers, to park the time indicator on while building. */
    function idleTime(comp, spans) {
        var fd = comp.frameDuration, i;
        if (!spans.length) return comp.time;
        if (spans[0].tIn > fd * 2) return 0;
        if (spans[spans.length - 1].tOut < comp.duration - fd * 2) return comp.duration - fd;
        for (i = 1; i < spans.length; i++) if (spans[i].tIn - spans[i - 1].tOut > fd * 2) return spans[i - 1].tOut + fd;
        return comp.time;
    }

    /** Layer spans (frame-exact), each running to the next caption's speech start. A style family's caption
     *  starts at its speech; with roles (Woodl Style) a caption starts with its reveal, the style's lead before
     *  its speech, so it overlaps the line before while that one sweeps out - though never before that sweep has
     *  begun (fast speech), and sp.keys holds its key times. */
    function spansFor(caps, offset, fd, workStart, workEnd, roles) {
        function snap(t) { return Math.round(t / fd) * fd; }
        var out = [], i, w0 = (workStart !== undefined) ? Math.ceil(workStart / fd - 0.001) * fd : 0;
        for (i = 0; i < caps.length; i++) {
            var c = caps[i], prev = out.length ? out[out.length - 1] : null;
            var sIn = c.s + offset, sEnd = c.e + offset, fiStart = sIn, tIn;
            if (roles) {
                fiStart = sIn - roles.lead;
                if (prev && fiStart < prev.keys.foStart) fiStart = Math.min(sIn, prev.keys.foStart);
                tIn = Math.floor(fiStart / fd + 1e-6) * fd;          // the reveal's first frame is on the layer
            } else tIn = snap(sIn);
            if (tIn < w0) tIn = w0;
            var tOut;
            if (i + 1 < caps.length) tOut = snap(caps[i + 1].s + offset);
            else {
                tOut = snap(sEnd + LAST_LINE_HOLD);
                if (workEnd !== undefined && tOut > workEnd) tOut = Math.max(snap(sEnd), snap(workEnd));
            }
            if (tOut - tIn < fd * 3) tOut = tIn + fd * 3;
            var sp = { tIn: tIn, tOut: tOut, sIn: sIn, sEnd: sEnd };
            if (roles) sp.keys = woodlTimes(roles, tIn, tOut, sIn, sEnd, fiStart);
            out.push(sp);
        }
        return out;
    }

    /** Captions of an earlier build in comp: { id: layer } for the layers tagged "#gen:id". */
    function builtLayers(comp, gen) {
        var map = {}, i, m;
        for (i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (!isCaption(L)) continue;
            m = /#([^\s:]+):(\S+)$/.exec(String(L.comment));
            if (m && m[1] === gen) map[m[2]] = L;
        }
        return map;
    }

    /** The captions to (re)build: all, or for an update only the ids asked for. Removes what they replace:
     *  every CFX caption (Replace option) or the earlier build's layers. Returns { only, old }: old[id] is the
     *  layer a rebuilt caption takes the place of (moved into its stacking position, then removed). */
    function prepareRebuild(comp, a) {
        var only = null, old = {}, i;
        if (a.update && a.update.gen && a.renumber) renumber(comp, a.update.gen, a.renumber);
        if (a.update && a.update.gen) {
            var map = builtLayers(comp, a.update.gen), id;
            if (a.update.ids) { only = {}; for (i = 0; i < a.update.ids.length; i++) only[a.update.ids[i]] = 1; }
            for (id in map) if (map.hasOwnProperty(id)) {
                if (!only) { try { removeCaptionLayer(map[id]); } catch (eR) {} }
                else if (only[id]) old[id] = map[id];
            }
        } else if (a.replace) {
            for (i = comp.numLayers; i >= 1; i--) if (isCaption(comp.layer(i))) { try { removeCaptionLayer(comp.layer(i)); } catch (eRm) {} }
        }
        return { only: only, old: old };
    }
    /** A caption was inserted: the build's later captions move up a number ({ oldId: newId }, all at once). A
     *  layer the user renamed keeps its name; its tag follows. */
    function renumber(comp, gen, map) {
        var layers = builtLayers(comp, gen), id;
        for (id in layers) if (layers.hasOwnProperty(id) && map.hasOwnProperty(id)) {
            var L = layers[id], nid = map[id];
            try { L.comment = String(L.comment).replace(new RegExp("#" + gen + ":" + id + "$"), "#" + gen + ":" + nid); } catch (eC) {}
            try { if (L.name === "CAP " + id) L.name = "CAP " + nid; } catch (eN) {}
            try { if (L.source && isCaptionComp(L.source) && L.source.name.indexOf("CAP " + id + " ") === 0) L.source.name = "CAP " + nid + L.source.name.substring(4 + id.length); } catch (eS) {}
        }
    }

    /** Check timeline (Insert a caption): the active comp, its time indicator and the CFX captions in it. */
    function timeline() {
        try {
            var comp = activeComp();
            if (!comp) return R(false, "Open the composition with the captions first.");
            var caps = [], i, m;
            for (i = 1; i <= comp.numLayers; i++) {
                var L = comp.layer(i);
                if (!isCaption(L)) continue;
                m = /#([^\s:]+):(\S+)$/.exec(String(L.comment));
                caps.push({ index: i, name: L.name, gen: m ? m[1] : "", id: m ? m[2] : "", tIn: L.inPoint, tOut: L.outPoint });
            }
            return R(true, "ok", { compId: comp.id, compName: comp.name, time: comp.time, fps: comp.frameRate,
                workStart: comp.workAreaStart, workEnd: comp.workAreaStart + comp.workAreaDuration, captions: caps });
        } catch (e) { return R(false, e.toString()); }
    }

    /** After an insert: the build's captions back in caption order (each one above the one before it), as one
     *  block where the build's top layer was. */
    function restack(comp, gen, caps) {
        var map = builtLayers(comp, gen), top = null, prev = null, id, i;
        for (id in map) if (map.hasOwnProperty(id) && (!top || map[id].index < top.index)) top = map[id];
        for (i = caps.length - 1; i >= 0; i--) {
            var L = map[caps[i].id];
            if (!L) continue;
            try { if (!prev) { if (L !== top) L.moveBefore(top); } else L.moveAfter(prev); } catch (eM) {}
            prev = L;
        }
    }

    /** A rebuilt caption takes its old layer's place in the stack. */
    function takePlace(L, oldL) {
        if (!oldL) return;
        try { L.moveBefore(oldL); } catch (eM) {}
        try { removeCaptionLayer(oldL); } catch (eR) {}
    }
    function tagFor(a, c, styleId) { return TAG + " " + (a.target || "") + (styleId ? " " + styleId : "") + (a.gen ? " #" + a.gen + ":" + c.id : ""); }

    /** Which of the layers CFX does not build are selected, in stacking order (Layer.id needs After Effects
     *  2022; building captions only adds / removes caption layers, so the others keep their order). */
    function selectionOf(comp) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) { var L = comp.layer(i); if (!isCaption(L)) out.push(!!L.selected); }
        return out;
    }
    function restoreSelection(comp, saved) {
        var k = 0;
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            try { if (isCaption(L)) L.selected = false; else L.selected = !!saved[k++]; } catch (e) {}
        }
    }

    function build(json) {
        var a = parse(json);
        // the comp whose audio was transcribed, even if another one was opened meanwhile
        var comp = null;
        if (a.compId) { var c2 = findItemById(a.compId); if (c2 && c2 instanceof CompItem) comp = c2; }
        if (!comp) comp = activeComp();
        if (!comp) return R(false, "Open the composition you want to caption first.");
        var raw = readUtf8(a.planPath);
        if (raw === null) return R(false, "The caption data is missing. Generate the captions again.");
        var plan = JSON.parse(raw), caps = plan.captions || [];
        if (!caps.length) return R(false, "No speech was found to caption.");
        // a style family (Text Preset 1 / 2): the director's choice of look and words per caption
        if (a.familyPath) {
            if (!plan.assign || plan.assign.length !== caps.length) return R(false, "The caption plan is incomplete. Generate the captions again.");
            return buildFamily(a, comp, caps, plan.assign);
        }

        var offset = Number(a.offset) || 0, fd = comp.frameDuration, i;
        var src = null, tpl = null, made = [], spans = null;
        try { src = styleSource(a.templatePath); }
        catch (eImp) { return R(false, eImp.toString()); }
        var savedTime = comp.time, savedSel = selectionOf(comp);
        try { comp.time = idleTime(comp, spansFor(caps, offset, fd, a.workStart, a.workEnd)); } catch (eT) {}
        // one undo step: the template copy, every caption and the template's removal
        app.beginUndoGroup("CFX Suite: Auto Captions");
        try {
            var rb = prepareRebuild(comp, a);
            tpl = placeTemplate(src, comp);
            spans = spansFor(caps, offset, fd, a.workStart, a.workEnd, tpl.roles);
            var W = comp.width, H = comp.height;
            var k = Math.sqrt((W * H) / (tpl.w * tpl.h));
            if (a.sizeScale) k *= Number(a.sizeScale);
            var yFrac = a.position === "lower" ? 0.76 : (a.position === "upper" ? 0.24 : 0.5);
            var ctx = { W: W, H: H, k: k };
            for (i = 0; i < caps.length; i++) {
                var c = caps[i], sp = spans[i];
                if (rb.only && !rb.only[c.id]) continue;
                var L = tpl.layer.duplicate();     // disabled like the template: nothing re-renders while it is built
                L.moveToBeginning();
                try { L.selected = false; } catch (eSel) {}
                L.name = "CAP " + c.id;
                L.comment = tagFor(a, c);
                setText(L, c.lines, tpl.upper);
                applyScriptFont(L, a.scriptFonts);
                placeKeys(L, tpl.roles, sp);
                place(L, ctx, W / 2, H * yFrac);
                if (rb.only && !rb.old[c.id]) rb.inserted = true;
                takePlace(L, rb.old[c.id]);
                made.push(L);
            }
            if (rb.inserted) restack(comp, a.update.gen, caps);
        } catch (e) {
            for (i = 0; i < made.length; i++) { try { made[i].enabled = true; } catch (eEn2) {} }
            try { if (tpl && tpl.layer) tpl.layer.remove(); } catch (e1) {}
            app.endUndoGroup();
            try { comp.time = savedTime; } catch (eT3) {}
            return R(false, "Building the captions failed: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""), { made: made.length });
        }
        for (i = 0; i < made.length; i++) { try { made[i].enabled = true; } catch (eEn) {} }
        try { tpl.layer.remove(); } catch (e3) {}
        // give the selection back (e.g. the dialogue layer, so the next run uses the same audio)
        restoreSelection(comp, savedSel);
        app.endUndoGroup();
        try { comp.time = savedTime; } catch (eT2) {}
        var note = (tpl && tpl.warnings && tpl.warnings.length) ? " " + tpl.warnings.join(" ") : "";
        var verb = a.update ? "Updated " : "Built ";
        return R(true, verb + made.length + " caption layer" + (made.length === 1 ? "" : "s") + "." + note, { made: made.length, compName: comp.name, warnings: tpl ? tpl.warnings : [] });
    }

    // ------------------------------------------------------------------ style families (Text Preset 1 / 2)

    var FOLDER = "CFX Captions";
    function captionFolder() {
        for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === FOLDER) return it; }
        return app.project.items.addFolder(FOLDER);
    }
    function isCaptionComp(it) { try { return (it instanceof CompItem) && String(it.comment || "").indexOf(TAG) === 0; } catch (e) { return false; } }

    /** Removes a caption layer and, when nothing else uses it, the comp CFX made for it. */
    function removeCaptionLayer(L) {
        var src = null;
        try { if (L.source && isCaptionComp(L.source)) src = L.source; } catch (eS) {}
        L.remove();
        if (src) { try { if (src.usedIn.length === 0) src.remove(); } catch (eR) {} }
    }

    /** Was this layer of the style animated by Animation Composer (its expressions baked to keyframes)? */
    function bakedLayer(st, index) {
        var outer = st.recipe.layers[0], inner = st.recipe.comps[outer.source.comp], found = false;
        function walk(n) { if (found || !n) return; if (n.bakeTag) { found = true; return; } if (n.c) for (var i = 0; i < n.c.length; i++) walk(n.c[i]); }
        try { walk(inner.layers[index - 1].props); } catch (e) {}
        return found;
    }

    function markerTimes(L) {
        var out = {}, mk = L.property("ADBE Marker"), k;
        if (!mk) return out;
        for (k = 1; k <= mk.numKeys; k++) { try { var c = mk.keyValue(k).comment; if (c === "TR In" || c === "TR Out") out[c] = mk.keyTime(k) - L.inPoint; } catch (e) {} }
        return out;
    }

    /** Every keyed property of a layer (paths, so they are found again on each duplicate). */
    function keyedProps(L) {
        var out = [];
        function walk(g) {
            for (var i = 1; i <= g.numProperties; i++) {
                var p = g.property(i);
                if (!p) continue;
                if (p.propertyType === PropertyType.PROPERTY) { var n = 0; try { n = p.numKeys; } catch (e) {} if (n > 0) out.push(propPath(p)); }
                else walk(p);
            }
        }
        walk(L);
        return out;
    }

    /** Moves every keyframe of p to map(t) (values, interpolation, eases kept; eases follow a local stretch). */
    function retimeKeys(p, map) {
        var n = p.numKeys, k, keys = [], isMarker = p.propertyValueType === PropertyValueType.MARKER;
        if (n < 1) return;
        for (k = 1; k <= n; k++) {
            var t = p.keyTime(k), d = { t: map(t), v: p.keyValue(k) }, st = (map(t + 0.01) - map(t - 0.01)) / 0.02;
            if (!isMarker) {
                try { d.ii = p.keyInInterpolationType(k); d.oi = p.keyOutInterpolationType(k); } catch (e1) {}
                try {
                    var ie = p.keyInTemporalEase(k), oe = p.keyOutTemporalEase(k), ni = [], no = [];
                    for (var e = 0; e < ie.length; e++) {
                        ni.push(new KeyframeEase(st > 0.01 ? ie[e].speed / st : ie[e].speed, ie[e].influence));
                        no.push(new KeyframeEase(st > 0.01 ? oe[e].speed / st : oe[e].speed, oe[e].influence));
                    }
                    d.ie = ni; d.oe = no;
                } catch (e2) {}
                try { d.tc = p.keyTemporalContinuous(k); d.ta = p.keyTemporalAutoBezier(k); } catch (e3) {}
                try { if (p.isSpatial) { d.si = p.keyInSpatialTangent(k); d.so = p.keyOutSpatialTangent(k); d.sc = p.keySpatialContinuous(k); d.sa = p.keySpatialAutoBezier(k); } } catch (e4) {}
            }
            keys.push(d);
        }
        for (k = 1; k < keys.length; k++) if (keys[k].t <= keys[k - 1].t) keys[k].t = keys[k - 1].t + 0.0005;   // never two keys on one time
        while (p.numKeys > 0) p.removeKey(1);
        if (isMarker) { for (k = 0; k < keys.length; k++) p.setValueAtTime(keys[k].t, keys[k].v); return; }
        var times = [], vals = [];
        for (k = 0; k < keys.length; k++) { times.push(keys[k].t); vals.push(keys[k].v); }
        try { p.setValuesAtTimes(times, vals); } catch (eM) { for (k = 0; k < keys.length; k++) p.setValueAtTime(times[k], vals[k]); }
        for (k = 0; k < keys.length; k++) {
            var idx = p.nearestKeyIndex(times[k]), q = keys[k];
            try { if (q.ii !== undefined) p.setInterpolationTypeAtKey(idx, q.ii, q.oi); } catch (x1) {}
            try { if (q.tc !== undefined) { p.setTemporalContinuousAtKey(idx, q.tc); p.setTemporalAutoBezierAtKey(idx, q.ta); } } catch (x2) {}
            try { if (q.ie && !q.ta) p.setTemporalEaseAtKey(idx, q.ie, q.oe); } catch (x3) {}
            try { if (q.si) { p.setSpatialTangentsAtKey(idx, q.si, q.so); p.setSpatialContinuousAtKey(idx, q.sc); p.setSpatialAutoBezierAtKey(idx, q.sa); } } catch (x4) {}
        }
    }

    /** Builds one look of the family in comp (disabled) and records what its layers do, once per build. */
    function makeStyleTemplate(comp, st, folder, skipTags, warnings, custom) {
        var sel = comp.selectedLayers, i;
        for (i = 0; i < sel.length; i++) { try { sel[i].selected = false; } catch (eS) {} }
        var res = $._cfxSuite.recipe.buildLayers(comp, st.recipe, { at: 0, fallbacks: st.recipe.fallbacks || {}, skipTags: skipTags, folder: folder });
        for (i = 0; i < res.warnings.length; i++) warnings.push(res.warnings[i]);
        if (!res.layers.length || !(res.layers[0].source instanceof CompItem)) throw new Error("The look " + st.id + " could not be built.");
        var L0 = res.layers[0], C0 = L0.source, prof = st.profile;
        L0.enabled = false;
        try { L0.comment = TAG + "-template"; C0.comment = TAG + "-template"; } catch (eC) {}
        var slotOf = {}, info = [], s, j;
        for (s = 0; s < prof.slots.length; s++) for (j = 0; j < prof.slots[s].layers.length; j++) slotOf[prof.slots[s].layers[j]] = s;
        for (i = 1; i <= C0.numLayers; i++) {
            var L = C0.layer(i), sl = slotOf[i];
            if (sl === undefined) {
                // a shape / other layer belongs to the slot it shares most of its time with
                var best = 0, bestOv = -1;
                for (s = 0; s < prof.slots.length; s++) {
                    var ov = Math.min(L.outPoint, prof.slots[s].outPoint) - Math.max(L.inPoint, prof.slots[s].inPoint);
                    // (a user's own style: a decoration shared equally goes with the main text, so it is not hidden
                    //  when a short line only fills the main part)
                    var better = custom ? (ov > bestOv + 0.04 || (Math.abs(ov - bestOv) <= 0.04 && prof.slots[s].role === "hero")) : ov > bestOv;
                    if (better) { bestOv = Math.max(ov, bestOv); best = s; }
                }
                sl = best;
            }
            var mk = markerTimes(L), dur = L.outPoint - L.inPoint, w = 0;
            if (L instanceof TextLayer) { try { w = L.sourceRectAtTime((L.inPoint + L.outPoint) / 2, false).width; } catch (eW) {} }
            info.push({
                index: i, slot: sl, text: L instanceof TextLayer, start: L.startTime, tin: L.inPoint, tout: L.outPoint, width: w,
                zoneIn: (mk["TR In"] !== undefined) ? Math.max(0.1, mk["TR In"]) : Math.min(0.9, dur * 0.45),
                zoneOut: (mk["TR Out"] !== undefined) ? Math.max(0.1, dur - mk["TR Out"]) : Math.min(0.8, dur * 0.4),
                roles: (L instanceof TextLayer) ? keyRoles(L) : null, keyed: keyedProps(L),
                // Animation Composer's in and out animations both start at the layer's start: they keep their own
                // speed (intro / outro zones) instead of the Woodl reveal / sweep-out timing
                ac: bakedLayer(st, i)
            });
        }
        return { layer: L0, comp: C0, prof: prof, layers: info, w: C0.width, h: C0.height, dur: C0.duration };
    }

    /** A user's own look (CUSTOM) that reveals and sweeps out its text like Woodl - opacity range animators, not
     *  Animation Composer: { lead, foAt } for the timing reference, else null. The lead is the design's own (its reveal
     *  starting before its layer) or, when the design starts the reveal with the layer, Woodl's - so the reveal is
     *  always seen before the voice. foAt: where the design starts its sweep-out within the reveal. */
    function revealOf(tp) {
        if (tp.reveal !== undefined) return tp.reveal;
        var r = null, i;
        for (i = 0; i < tp.layers.length; i++) {
            var li = tp.layers[i];
            if (!li.text || !li.roles || li.ac || !(li.roles.fadeIn.length || li.roles.fadeOut.length)) continue;
            if (!r) r = { lead: 0, foAt: li.roles.foAt };
            if (li.roles.fadeIn.length) r.lead = Math.max(r.lead, li.roles.lead);
        }
        if (r && r.lead < 0.05) r.lead = REVEAL_LEAD;
        tp.reveal = r;
        return r;
    }

    /** Re-times one layer of a caption's look (comp times inside the look's comp: 0 = the caption's start).
     *  A = when its part appears, E = when the part is gone; wS / wE = when its words are spoken; sEnd = the
     *  end of the whole line's speech. */
    function retimeLayer(L, li, A, E, wS, wE, sEnd, fd, rv) {
        var newIn = A + (li.tin - li.slotTin), newOut = E - (li.slotTout - li.tout);
        if (newOut < newIn + fd * 6) newOut = newIn + fd * 6;
        var durT = Math.max(fd, li.tout - li.tin), durN = Math.max(fd, newOut - newIn);
        var zIn = Math.min(li.zoneIn, durT * 0.5), zOut = Math.min(li.zoneOut, durT * 0.5);
        var squeeze = durN < zIn + zOut;
        function map(t) {                                    // template comp time -> new comp time
            var r = t - li.tin, out;
            if (squeeze) out = r * durN / durT;
            else if (r <= zIn) out = r;                       // the intro plays at its own speed
            else if (r >= durT - zOut) out = durN - (durT - r);   // so does the outro, against the end
            else out = zIn + (r - zIn) * (durN - zIn - zOut) / Math.max(1e-6, durT - zIn - zOut);
            return newIn + out;
        }
        var woodl = li.roles && !li.ac && (li.roles.fadeIn.length || li.roles.fadeOut.length);
        var special = {};
        if (woodl) {
            // the reveal / sweep-out text animators follow the speech, like Woodl Style (rv: a user's own look, timed
            // exactly like Woodl - the timing reference: reveal from the lead before the words to their end, sweep-out
            // starting where the design starts it within the reveal, gone just before the next line)
            var lead = rv ? rv.lead : li.roles.lead, fiStart = wS - lead, foFull = newOut - (rv ? Math.max(0.1, li.roles.outGap) : li.roles.outGap);
            var fiFull = Math.min(Math.max(wE, wS + MIN_REVEAL), foFull - 0.15);
            if (fiFull <= fiStart + 0.1) fiFull = fiStart + 0.1;
            var foStart = rv ? Math.max(fiStart + li.roles.foAt * (fiFull - fiStart), foFull - FADE_OUT_MAX, fiStart + 0.1)
                : Math.max(sEnd - FADE_OUT_BEFORE_SPEECH_END, foFull - FADE_OUT_MAX, fiStart + 0.1);
            if (foStart > foFull - 0.2) foStart = Math.max(fiStart + 0.05, foFull - 0.2);
            var k;
            for (k = 0; k < li.roles.fadeIn.length; k++) { setKeySpan(propAt(L, li.roles.fadeIn[k].path), fiStart, fiFull); special[li.roles.fadeIn[k].path.join("/")] = 1; }
            for (k = 0; k < li.roles.fadeOut.length; k++) { setKeySpan(propAt(L, li.roles.fadeOut[k].path), foStart, foFull); special[li.roles.fadeOut[k].path.join("/")] = 1; }
            for (k = 0; k < li.roles.tracking.length; k++) { setKeySpan(propAt(L, li.roles.tracking[k].path), newIn, newOut + TRACKING_PAST_END); special[li.roles.tracking[k].path.join("/")] = 1; }
        }
        for (var q = 0; q < li.keyed.length; q++) {
            if (special[li.keyed[q].join("/")]) continue;
            var p = null;
            try { p = propAt(L, li.keyed[q]); } catch (eP) { p = null; }
            if (p && p.numKeys) retimeKeys(p, map);
        }
        // the layer's own span (its keys were already placed in comp time above); the order keeps in < out
        if (newIn < L.outPoint) { L.inPoint = newIn; L.outPoint = newOut; }
        else { L.outPoint = newOut; L.inPoint = newIn; }
    }

    function setLayerText(L, lines, scriptFonts, maxW, custom) {
        var st = textProp(L);
        while (st.numKeys > 0) st.removeKey(1);
        var d = st.value, oneLine = String(d.text).split(/\r|\n/).length === 1;
        d.text = lines.join("\r");
        // a user's own single-line design taking a second line: its leading was never meant for two lines
        if (custom && oneLine && lines.length > 1) { try { if (!d.autoLeading && d.leading < d.fontSize * 0.95) d.leading = Math.round(d.fontSize * 1.15); } catch (eL) {} }
        st.setValue(d);
        if (scriptFonts && /[^\u0000-\u024F\u2000-\u206F\s]/.test(lines.join(""))) applyScriptFont(L, scriptFonts);
        if (maxW > 0) {
            // longer words than the design had: the size comes down so the part keeps its place in the layout
            var w = 0;
            try { w = L.sourceRectAtTime((L.inPoint + L.outPoint) / 2, false).width; } catch (eW) {}
            if (w > maxW) {
                d = st.value;
                var f0 = d.fontSize;
                d.fontSize = Math.max(f0 * 0.4, f0 * maxW / w);
                if (custom) { try { if (!d.autoLeading) d.leading = d.leading * d.fontSize / f0; } catch (eL2) {} }     // lines keep their spacing
                st.setValue(d);
            }
        }
    }

    /** The visible box of a caption's look at time t inside its comp (union of its enabled layers, 2D). */
    function contentBox(C, t) {
        var box = null, i;
        for (i = 1; i <= C.numLayers; i++) {
            var L = C.layer(i);
            if (!L.enabled || t < L.inPoint || t > L.outPoint) continue;
            var r;
            try { r = L.sourceRectAtTime(t, false); } catch (e) { continue; }
            if (!r || r.width <= 0) continue;
            var T = L.property("ADBE Transform Group"), p = T.property("ADBE Position").valueAtTime(t, false), a = T.property("ADBE Anchor Point").valueAtTime(t, false), s = T.property("ADBE Scale").valueAtTime(t, false);
            var x0 = p[0] + (r.left - a[0]) * s[0] / 100, y0 = p[1] + (r.top - a[1]) * s[1] / 100;
            var x1 = x0 + r.width * s[0] / 100, y1 = y0 + r.height * s[1] / 100;
            if (!box) box = { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) };
            else { box.l = Math.min(box.l, x0, x1); box.t = Math.min(box.t, y0, y1); box.r = Math.max(box.r, x0, x1); box.b = Math.max(box.b, y0, y1); }
        }
        return box;
    }

    function buildFamily(a, comp, caps, assign) {
        var fd = comp.frameDuration, offset = Number(a.offset) || 0, i, j;
        var raw = readUtf8(a.familyPath);
        if (raw === null) return R(false, "Caption style not found: " + a.familyPath + ". Reinstall CFX Suite.");
        var fam = $._cfxSuite.parseOwnJson(raw), byId = {};
        for (i = 0; i < fam.styles.length; i++) byId[fam.styles[i].id] = fam.styles[i];
        var spans = spansFor(caps, offset, fd, a.workStart, a.workEnd);
        var savedTime = comp.time, savedSel = selectionOf(comp), made = [], tpls = {}, warnings = [];
        try { comp.time = idleTime(comp, spans); } catch (eT) {}
        app.beginUndoGroup("CFX Suite: Auto Captions");
        try {
            var rb = prepareRebuild(comp, a);
            var folder = captionFolder();
            // Animation Composer's own expressions do not survive being rebuilt by a script (tested: the text
            // never shows), so its animation always comes from the keyframes baked when the style was made: the
            // same look on every PC, with or without the plug-in
            var skipTags = { ac: true };
            var W = comp.width, H = comp.height, yFrac = a.position === "lower" ? 0.76 : (a.position === "upper" ? 0.24 : 0.5);
            var prevFo = -1e9, w0 = (a.workStart !== undefined) ? Math.ceil(a.workStart / fd - 0.001) * fd : 0;
            for (i = 0; i < caps.length; i++) {
                var c = caps[i], sp = spans[i], g = assign[i], st = byId[g.style] || fam.styles[0];
                // (every caption's look and timing: an update of a few still times them against their neighbours)
                var tp = tpls[st.id] || (tpls[st.id] = makeStyleTemplate(comp, st, folder, skipTags, warnings, !!fam.custom));
                // a user's own look that reveals its text like Woodl follows the timing reference too: the caption starts
                // with its reveal, the lead before its line is spoken, and overlaps the caption before while that one
                // sweeps out (never before that sweep has begun)
                var rv = fam.custom ? revealOf(tp) : null, rvNow = null;
                if (rv) {
                    var fs0 = sp.sIn - rv.lead, tIn2 = Math.floor(fs0 / fd + 1e-6) * fd;
                    if (tIn2 < prevFo) tIn2 = Math.min(Math.floor(sp.sIn / fd + 1e-6) * fd, Math.ceil(prevFo / fd - 1e-6) * fd);
                    tIn2 = Math.max(tIn2, w0);
                    if (tIn2 < sp.tIn) sp.tIn = tIn2;
                    rvNow = { lead: Math.max(0, Math.min(rv.lead, sp.sIn - sp.tIn)), foAt: rv.foAt };
                    var fs1 = sp.sIn - rvNow.lead;
                    prevFo = fs1 + rv.foAt * (Math.max(sp.sEnd, sp.sIn + MIN_REVEAL) - fs1);
                } else prevFo = sp.sEnd;
                if (rb.only && !rb.only[c.id]) continue;
                var C = tp.comp.duplicate();
                C.name = "CAP " + c.id + " \u00B7 " + st.id;
                try { C.parentFolder = folder; C.comment = TAG + " " + st.id; } catch (eF) {}
                var D = Math.max(fd * 6, sp.tOut - sp.tIn);
                C.duration = Math.max(D, fd * 6);
                var used = {}, k;
                for (k = 0; k < g.slots.length; k++) used[g.slots[k].slot] = g.slots[k];
                // when each part appears / goes: its words' speech, its exit kept against the end like the design
                var A = {}, E = {}, prevA = 0, sEnd = sp.sEnd - sp.tIn, prof = tp.prof;
                // the parts in use: the last of them to leave in the design leaves with the caption; the others keep
                // their order of leaving, the gaps shrunk in proportion when the caption is shorter than the design
                var tEndUsed = 0, tStartUsed = 1e9;
                for (k = 0; k < prof.slots.length; k++) if (used[k]) { tEndUsed = Math.max(tEndUsed, prof.slots[k].outPoint); tStartUsed = Math.min(tStartUsed, prof.slots[k].inPoint); }
                var gapScale = Math.max(0.25, Math.min(1, D / Math.max(fd, tEndUsed - tStartUsed)));
                for (k = 0; k < prof.slots.length; k++) {
                    var u = used[k];
                    if (!u) continue;
                    var wS = u.s + offset - sp.tIn;
                    A[k] = Math.max(prevA, k === g.slots[0].slot ? 0 : wS - (rvNow ? rvNow.lead : 0.06), 0);
                    A[k] = Math.min(A[k], D - 0.4);
                    E[k] = D - (tEndUsed - prof.slots[k].outPoint) * gapScale;
                    E[k] = Math.min(D, Math.max(A[k] + Math.min(0.6, D - A[k]), E[k]));
                    prevA = A[k];
                }
                for (j = 0; j < tp.layers.length; j++) {
                    var li = tp.layers[j], L = C.layer(li.index), us = used[li.slot];
                    if (!us) { L.enabled = false; continue; }
                    li.slotTin = prof.slots[li.slot].inPoint; li.slotTout = prof.slots[li.slot].outPoint;
                    if (li.text) {
                        var maxW = Math.min(tp.w * 0.92, Math.max(li.width * 1.3, li.width + 120));
                        setLayerText(L, us.lines, a.scriptFonts, maxW, !!fam.custom);
                    }
                    retimeLayer(L, li, A[li.slot], E[li.slot], us.s + offset - sp.tIn, us.e + offset - sp.tIn, sEnd, fd, rvNow);
                }
                var Lc = tp.layer.duplicate();
                Lc.moveToBeginning();
                try { Lc.selected = false; } catch (eSel) {}
                Lc.replaceSource(C, false);
                Lc.name = "CAP " + c.id;
                Lc.comment = tagFor(a, c, st.id);
                Lc.startTime = sp.tIn;
                Lc.inPoint = sp.tIn;
                Lc.outPoint = sp.tIn + D;
                // centred on what is visible half-way through, sized for this comp
                var box = contentBox(C, Math.min(D * 0.6, D - fd)) || { l: 0, t: 0, r: tp.w, b: tp.h };
                var kk = Math.sqrt((W * H) / (tp.w * tp.h)) * (Number(a.sizeScale) || 1);
                if ((box.r - box.l) * kk > W * 0.9) kk = W * 0.9 / Math.max(1, box.r - box.l);
                var T = Lc.property("ADBE Transform Group");
                T.property("ADBE Anchor Point").setValue([(box.l + box.r) / 2, (box.t + box.b) / 2]);
                T.property("ADBE Scale").setValue([kk * 100, kk * 100]);
                if (T.property("ADBE Position").dimensionsSeparated) { T.property("ADBE Position_0").setValue(W / 2); T.property("ADBE Position_1").setValue(H * yFrac); }
                else T.property("ADBE Position").setValue([W / 2, H * yFrac]);
                if (rb.only && !rb.old[c.id]) rb.inserted = true;
                takePlace(Lc, rb.old[c.id]);
                made.push(Lc);
            }
            if (rb.inserted) restack(comp, a.update.gen, caps);
        } catch (e) {
            for (i = 0; i < made.length; i++) { try { made[i].enabled = true; } catch (eEn2) {} }
            for (var t1 in tpls) if (tpls.hasOwnProperty(t1)) { try { var cc = tpls[t1].comp; tpls[t1].layer.remove(); cc.remove(); } catch (eX) {} }
            app.endUndoGroup();
            try { comp.time = savedTime; } catch (eT3) {}
            return R(false, "Building the captions failed: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""), { made: made.length });
        }
        for (i = 0; i < made.length; i++) { try { made[i].enabled = true; } catch (eEn) {} }
        for (var t2 in tpls) if (tpls.hasOwnProperty(t2)) { try { var c2 = tpls[t2].comp; tpls[t2].layer.remove(); c2.remove(); } catch (eX2) {} }
        restoreSelection(comp, savedSel);
        app.endUndoGroup();
        try { comp.time = savedTime; } catch (eT2) {}
        // what is missing on this PC, once (plug-in effects are skipped / replaced, the rest builds as designed)
        var seen = {}, notes = [];
        for (i = 0; i < warnings.length; i++) if (!seen[warnings[i]]) { seen[warnings[i]] = 1; notes.push(warnings[i]); }
        return R(true, (a.update ? "Updated " : "Built ") + made.length + " caption" + (made.length === 1 ? "" : "s") + " in " + fam.name + ".", { made: made.length, compName: comp.name, warnings: notes, ac: !skipTags.ac });
    }

    // ------------------------------------------------------------------ preview (Auto Captions > CUSTOM)

    var PREVIEW_TAG = "cfx-caption-preview";
    function folderNamed(name) {
        for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === name) return it; }
        return null;
    }

    /** A style's preview: the plan's captions (a = { familyPath, planPath, outDir, dur, w, h, fps, step }) built in a
     *  small comp of its own over a dark background - the real caption build, so the preview shows how the captions
     *  will appear, animate and leave - and rendered to PNG frames (outDir/f_000.png ...) every `step` seconds.
     *  The comp stays until previewCleanup: recent After Effects writes the frames in the background. */
    function preview(json) {
        var a = parse(json), comp = null;
        try {
            var raw = readUtf8(a.planPath);
            if (raw === null) return R(false, "The preview plan is missing.");
            var plan = JSON.parse(raw), had = { solids: !!folderNamed("Solids"), caps: !!folderNamed(FOLDER) };
            app.beginUndoGroup("CFX Suite: caption style preview");
            comp = app.project.items.addComp("CFX caption preview", a.w || 640, a.h || 360, 1, a.dur, a.fps || 30);
            comp.comment = PREVIEW_TAG;
            var bg = comp.layers.addSolid([0.05, 0.075, 0.12], "CFX preview background", comp.width, comp.height, 1, a.dur);
            app.endUndoGroup();
            var res = JSON.parse(buildFamily({ familyPath: a.familyPath, offset: 0, workStart: 0, workEnd: a.dur, position: "center",
                sizeScale: a.sizeScale || 1, gen: "preview", target: "" }, comp, plan.captions, plan.assign));
            if (!res.success) { previewCleanup({ compId: comp.id, had: had }); return R(false, res.message); }
            var step = a.step || 0.1, n = Math.floor(a.dur / step + 1e-6), frames = [], dir = new Folder(a.outDir), i;
            if (!dir.exists) dir.create();
            for (i = 0; i < n; i++) {
                var f = new File(dir.fsName + "/f_" + ("00" + i).slice(-3) + ".png");
                comp.saveFrameToPng(Math.min(a.dur - comp.frameDuration, i * step), f);
                frames.push(f.fsName);
            }
            return R(true, "ok", { compId: comp.id, had: had, frames: frames, warnings: res.data ? res.data.warnings : [] });
        } catch (e) {
            try { app.endUndoGroup(); } catch (eU) {}
            if (comp) { try { previewCleanup({ compId: comp.id }); } catch (eC) {} }
            return R(false, "The preview could not be made: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
        }
    }

    /** Removes a preview comp and everything made for it (caption comps, the background solid, folders it added). */
    function previewCleanup(json) {
        var a = parse(json), comp = findItemById(a.compId), had = a.had || { solids: true, caps: true }, i;
        if (!comp || !(comp instanceof CompItem) || comp.comment !== PREVIEW_TAG) return R(true, "nothing to remove");
        app.beginUndoGroup("CFX Suite: caption style preview");
        try {
            var sources = [];
            for (i = 1; i <= comp.numLayers; i++) { try { if (comp.layer(i).source) sources.push(comp.layer(i).source); } catch (eS) {} }
            comp.remove();
            for (i = 0; i < sources.length; i++) { try { if (sources[i].usedIn.length === 0) sources[i].remove(); } catch (eR) {} }
            var f1 = folderNamed(FOLDER), f2 = folderNamed("Solids");
            try { if (!had.caps && f1 && f1.numItems === 0) f1.remove(); } catch (eF1) {}
            try { if (!had.solids && f2 && f2.numItems === 0) f2.remove(); } catch (eF2) {}
        } catch (e) {}
        app.endUndoGroup();
        return R(true, "removed");
    }

    // ------------------------------------------------------------------ clear

    /** Clear created layers: only the caption layers CFX built (and any template an interrupted build left),
     *  with the comps CFX made for them. */
    function removeCaptions() {
        var comp = activeComp();
        if (!comp) return R(false, "Open a composition first.");
        var n = 0, i;
        app.beginUndoGroup("CFX Suite: Clear created layers");
        for (i = comp.numLayers; i >= 1; i--) if (isCaption(comp.layer(i))) { try { removeCaptionLayer(comp.layer(i)); n++; } catch (e) {} }
        app.endUndoGroup();
        return R(n > 0, n ? ("Cleared " + n + " caption layer" + (n === 1 ? "" : "s") + ".") : "There are no caption layers from CFX in this comp.", { removed: n });
    }

    /** Which of a style's third-party effects and fonts this After Effects lacks (read-only: nothing is added).
     *  Animation Composer is not checked: without it the style uses its baked keyframes. */
    function styleCheck(json) {
        var a = parse(json) || {}, have = {}, miss = [], fonts = [], i, fontsChecked = false;
        try { var fx = app.effects; for (i = 0; i < fx.length; i++) have[fx[i].matchName] = true; } catch (e) {}
        for (i = 0; i < (a.effects || []).length; i++) {
            var mn = a.effects[i];
            if (/^Pseudo\/MHAC/.test(mn)) continue;
            if (!have[mn]) miss.push(mn);
        }
        try {
            if (app.fonts && app.fonts.getFontsByPostScriptName) {
                fontsChecked = true;
                for (i = 0; i < (a.fonts || []).length; i++) if (!app.fonts.getFontsByPostScriptName(a.fonts[i]).length) fonts.push(a.fonts[i]);
            }
        } catch (eF) { fontsChecked = false; }
        return R(true, "ok", { missingEffects: miss, missingFonts: fonts, fontsChecked: fontsChecked });
    }

    return { info: info, renderAudio: renderAudio, build: build, removeCaptions: removeCaptions, styleCheck: styleCheck, timeline: timeline,
        preview: preview, previewCleanup: previewCleanup };
})();
