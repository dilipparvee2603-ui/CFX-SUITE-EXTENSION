/**
 * CFX Suite - layer recipes (ExtendScript, ECMAScript 3)
 *
 * Describes layers as plain JSON and builds them again, in any project and any After Effects version from
 * 2020 on - no .aep / .ffx file involved (an .aep saved by a newer After Effects cannot be opened by an older
 * one: "This project was created with a newer version"). Used by:
 *   - Auto Captions: the caption preset ships as captions/styles/CFX-default.json and is built in the comp
 *   - Layer Setups: saved arrangements of selected layers / precomps (host/layerSetups.jsx)
 *
 *   serializeLayers(comp, layers)   -> { layers: [...], comps: {id: compRecipe}, t0 }   (precomps nested)
 *   buildLayers(comp, set, opts)    -> { layers: [Layer], warnings: [string] }
 *       opts.at        comp time the set's earliest layer starts at (default: the recorded times)
 *       opts.compCache shared between calls so a precomp used twice is built once
 *
 * A layer recipe records the layer type and source, switches, timing, parenting / track matte (as indexes
 * inside the set) and its whole property tree: values, keyframes (interpolation, temporal ease, spatial
 * tangents, continuity, roving), expressions, effects (by match name, so any language works), masks, text
 * (Source Text and animators), shape contents, markers. Anything the running version does not have - a
 * newer property, a third-party effect that is not installed - is skipped and reported in warnings.
 */

$._cfxSuite.recipe = (function () {
    var PT = PropertyType, PVT = PropertyValueType;
    var TD_FIELDS = ["font", "fontSize", "applyFill", "fillColor", "applyStroke", "strokeColor", "strokeWidth",
        "strokeOverFill", "tracking", "leading", "autoLeading", "justification", "allCaps", "smallCaps", "fauxBold",
        "fauxItalic", "baselineShift", "horizontalScale", "verticalScale", "tsume", "lineJoinType"];

    function num(x) { return (typeof x === "number" && !isNaN(x)) ? x : 0; }

    // ------------------------------------------------------------------ values

    function shapeToObj(s) {
        var o = { v: s.vertices, i: s.inTangents, o: s.outTangents, c: s.closed };
        try { if (s.featherSegLocs && s.featherSegLocs.length) { o.fs = s.featherSegLocs; o.fr = s.featherRelSegLocs; o.fd = s.featherRadii; o.fi = s.featherInterps; o.ft = s.featherTensions; o.fy = s.featherTypes; o.fa = s.featherRelCornerAngles; } } catch (e) {}
        return o;
    }
    function objToShape(o) {
        var s = new Shape();
        s.vertices = o.v; s.inTangents = o.i; s.outTangents = o.o; s.closed = !!o.c;
        if (o.fs) { try { s.featherSegLocs = o.fs; s.featherRelSegLocs = o.fr; s.featherRadii = o.fd; s.featherInterps = o.fi; s.featherTensions = o.ft; s.featherTypes = o.fy; s.featherRelCornerAngles = o.fa; } catch (e) {} }
        return s;
    }
    function markerToObj(m) {
        var o = { comment: m.comment, duration: m.duration, chapter: m.chapter, url: m.url, frameTarget: m.frameTarget,
            cuePointName: m.cuePointName, eventCuePoint: m.eventCuePoint };
        try { o.label = m.label; } catch (e) {}
        try { o.protectedRegion = m.protectedRegion; } catch (e2) {}
        try { o.params = m.getParameters(); } catch (e3) {}
        return o;
    }
    function objToMarker(o) {
        var m = new MarkerValue(o.comment || "");
        try { m.duration = num(o.duration); } catch (e) {}
        try { if (o.chapter) m.chapter = o.chapter; if (o.url) m.url = o.url; if (o.frameTarget) m.frameTarget = o.frameTarget; } catch (e2) {}
        try { if (o.cuePointName) m.cuePointName = o.cuePointName; m.eventCuePoint = !!o.eventCuePoint; } catch (e3) {}
        try { if (o.label) m.label = o.label; } catch (e4) {}
        try { if (o.protectedRegion) m.protectedRegion = true; } catch (e5) {}
        try { if (o.params) m.setParameters(o.params); } catch (e6) {}
        return m;
    }
    function textToObj(d) {
        var o = { text: String(d.text) };
        for (var i = 0; i < TD_FIELDS.length; i++) { try { var v = d[TD_FIELDS[i]]; if (v !== undefined && v !== null) o[TD_FIELDS[i]] = v; } catch (e) {} }
        try { o.pointText = d.pointText; if (d.boxText) { o.boxText = true; o.boxTextSize = d.boxTextSize; } } catch (e2) {}
        return o;
    }
    /** Writes the recorded text settings; reports the ones this version would not take (older After
     *  Effects cannot set e.g. All Caps / Faux Bold / character scale from a script). */
    function applyText(doc, o, failed) {
        var order = ["font", "fontSize", "applyFill", "fillColor", "applyStroke", "strokeColor", "strokeWidth", "strokeOverFill",
            "tracking", "autoLeading", "leading", "justification", "allCaps", "smallCaps", "fauxBold", "fauxItalic",
            "baselineShift", "horizontalScale", "verticalScale", "tsume", "lineJoinType"];
        if (o.text !== undefined) doc.text = o.text;
        for (var i = 0; i < order.length; i++) {
            var k = order[i];
            if (o[k] === undefined) continue;
            if (k === "fillColor" && !o.applyFill) continue;
            if ((k === "strokeColor" || k === "strokeWidth" || k === "strokeOverFill") && !o.applyStroke) continue;
            if (k === "allCaps" || k === "smallCaps") {
                try {
                    if (typeof FontCapsOption !== "undefined") {
                        if (o.allCaps) doc.fontCapsOption = FontCapsOption.FONT_ALL_CAPS;
                        else if (o.smallCaps) doc.fontCapsOption = FontCapsOption.FONT_SMALL_CAPS;
                        continue;
                    }
                } catch (eC) {}
            }
            if (k === "leading" && o.autoLeading) continue;
            try { doc[k] = o[k]; } catch (e) { failed[k] = true; }
        }
        return doc;
    }
    function same(a, b) {
        if (a === b) return true;
        if (a instanceof Array && b instanceof Array) {
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) if (Math.abs(num(a[i]) - num(b[i])) > 1e-6) return false;
            return true;
        }
        if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
        return false;
    }

    // ------------------------------------------------------------------ serialize

    function serValue(p, v) {
        var t = p.propertyValueType;
        if (t === PVT.SHAPE) return { shape: shapeToObj(v) };
        if (t === PVT.TEXT_DOCUMENT) return { textDocument: textToObj(v) };
        if (t === PVT.MARKER) return { marker: markerToObj(v) };
        return v;
    }

    function serProp(p, ctx) {
        var o = { mn: p.matchName, name: p.name };
        var t;
        try { t = p.propertyValueType; } catch (e) { return null; }
        if (t === PVT.NO_VALUE) return null;
        if (t === PVT.CUSTOM_VALUE) { o.custom = true; return o; }
        o.t = t;
        try { if (p.dimensionsSeparated) o.sep = true; } catch (eS) {}
        try { if (p.canSetExpression && p.expression) { o.expr = p.expression; o.exprOn = p.expressionEnabled; } } catch (eE) {}
        // build-time option: an expression a plug-in computes (Animation Composer) is also kept as plain keyframes
        // sampled from it, for After Effects without that plug-in
        if (o.expr && ctx.bake && ctx.bake.test(o.expr) && o.exprOn !== false && t !== PVT.SHAPE && t !== PVT.TEXT_DOCUMENT && t !== PVT.MARKER) {
            o.bakeTag = ctx.bakeTag;
            try { o.bk = bakeKeys(p, ctx); } catch (eB) {}
        }
        var nk = 0;
        try { nk = p.numKeys; } catch (eK) { nk = 0; }
        if (nk > 0) {
            o.keys = [];
            for (var k = 1; k <= nk; k++) {
                var kk = { t: p.keyTime(k) - ctx.t0 };
                try { kk.v = serValue(p, p.keyValue(k)); } catch (eV) {}
                try { kk.it = p.keyInInterpolationType(k); kk.ot = p.keyOutInterpolationType(k); } catch (e1) {}
                if (t !== PVT.MARKER) {
                    try {
                        var ie = p.keyInTemporalEase(k), oe = p.keyOutTemporalEase(k), a = [], b = [];
                        for (var e = 0; e < ie.length; e++) { a.push([ie[e].speed, ie[e].influence]); b.push([oe[e].speed, oe[e].influence]); }
                        kk.ie = a; kk.oe = b;
                    } catch (e2) {}
                    try { kk.tc = p.keyTemporalContinuous(k); kk.ta = p.keyTemporalAutoBezier(k); } catch (e3) {}
                    try { if (p.isSpatial) { kk.si = p.keyInSpatialTangent(k); kk.so = p.keyOutSpatialTangent(k); kk.sc = p.keySpatialContinuous(k); kk.sa = p.keySpatialAutoBezier(k); kk.rv = p.keyRoving(k); } } catch (e4) {}
                }
                o.keys.push(kk);
            }
        } else if (t !== PVT.MARKER) {
            // the value before any expression: an expression that uses `value` (Fade In+Out...) needs the real one
            try { o.v = serValue(p, o.expr ? p.valueAtTime(0, true) : p.value); } catch (eV2) {}
        }
        if (t === PVT.LAYER_INDEX && ctx.layerIndexMap) {
            // an effect's layer reference: kept as a position inside the saved set (0 = none / outside)
            var conv = function (v) { return (v && ctx.layerIndexMap[v] !== undefined) ? ctx.layerIndexMap[v] : 0; };
            if (o.keys) for (var q = 0; q < o.keys.length; q++) o.keys[q].v = conv(o.keys[q].v); else o.v = conv(o.v);
            o.layerRef = true;
        }
        return o;
    }

    /** The values an expression gives over the layer's visible span, one sample per frame, thinned to the keys
     *  that matter (Ramer-Douglas-Peucker on every dimension): { keys: [{t, v, it, ot}] } or { v } if constant. */
    function bakeKeys(p, ctx) {
        var step = ctx.bakeStep, a = ctx.bakeFrom, b = ctx.bakeTo, ts = [], vs = [], t, i, d;
        for (t = a; t <= b + step * 0.5; t += step) { ts.push(Math.min(t, b)); vs.push(p.valueAtTime(Math.min(t, b), false)); }
        function dimsOf(v) { return (v instanceof Array) ? v : [v]; }
        var n = ts.length, D = dimsOf(vs[0]).length, lo = [], hi = [];
        for (d = 0; d < D; d++) { lo[d] = 1e30; hi[d] = -1e30; }
        for (i = 0; i < n; i++) { var dv = dimsOf(vs[i]); for (d = 0; d < D; d++) { lo[d] = Math.min(lo[d], num(dv[d])); hi[d] = Math.max(hi[d], num(dv[d])); } }
        var flat = true;
        for (d = 0; d < D; d++) if (hi[d] - lo[d] > 1e-6) flat = false;
        if (flat) return { v: vs[0] };
        var eps = [];
        for (d = 0; d < D; d++) eps[d] = Math.max(1e-4, (hi[d] - lo[d]) * 0.004);
        var keep = [], stack = [[0, n - 1]];
        for (i = 0; i < n; i++) keep[i] = false;
        keep[0] = keep[n - 1] = true;
        while (stack.length) {
            var seg = stack.pop(), s = seg[0], e = seg[1], worst = -1, wi = -1;
            if (e - s < 2) continue;
            var vsS = dimsOf(vs[s]), vsE = dimsOf(vs[e]);
            for (i = s + 1; i < e; i++) {
                var f = (ts[i] - ts[s]) / Math.max(1e-9, ts[e] - ts[s]), vi = dimsOf(vs[i]), over = 0;
                for (d = 0; d < D; d++) over = Math.max(over, Math.abs(num(vi[d]) - (num(vsS[d]) + (num(vsE[d]) - num(vsS[d])) * f)) / eps[d]);
                if (over > worst) { worst = over; wi = i; }
            }
            if (worst > 1) { keep[wi] = true; stack.push([s, wi]); stack.push([wi, e]); }
        }
        var keys = [], LIN = KeyframeInterpolationType.LINEAR;
        for (i = 0; i < n; i++) if (keep[i]) keys.push({ t: ts[i] - ctx.t0, v: vs[i], it: LIN, ot: LIN });
        return { keys: keys };
    }

    function serGroup(g, ctx) {
        var o = { mn: g.matchName, name: g.name, g: (g.propertyType === PT.INDEXED_GROUP) ? 2 : 1, c: [] };
        try { if (g.canSetEnabled) o.on = g.enabled; } catch (e) {}
        if (g.matchName === "ADBE Mask Atom") {
            o.mask = {};
            try { o.mask.mode = g.maskMode; o.mask.inverted = g.inverted; o.mask.roto = g.rotoBezier; o.mask.color = g.color; } catch (eM) {}
            try { o.mask.mmb = g.maskMotionBlur; o.mask.falloff = g.maskFeatherFalloff; } catch (eM2) {}
        }
        for (var i = 1; i <= g.numProperties; i++) {
            var p = g.property(i);
            if (!p) continue;
            var s = (p.propertyType === PT.PROPERTY) ? serProp(p, ctx) : serGroup(p, ctx);
            // (a plug-in's effect whose expressions were baked is tagged, so a build without the plug-in skips it quietly)
            if (s && ctx.bakeFx && p.propertyType !== PT.PROPERTY && g.matchName === "ADBE Effect Parade" && ctx.bakeFx.test(p.matchName)) s.bakeTag = ctx.bakeTag;
            if (s) o.c.push(s);
        }
        return o;
    }

    function serLayer(L, ctx) {
        var o = { name: L.name, index: L.index, comment: L.comment, label: L.label, enabled: L.enabled,
            startTime: L.startTime - ctx.t0, inPoint: L.inPoint - ctx.t0, outPoint: L.outPoint - ctx.t0, stretch: L.stretch,
            shy: L.shy, locked: false };
        try { o.solo = L.solo; } catch (e0) {}
        if (L instanceof TextLayer) o.kind = "text";
        else if (L instanceof ShapeLayer) o.kind = "shape";
        else if (L instanceof CameraLayer) o.kind = "camera";
        else if (L instanceof LightLayer) { o.kind = "light"; try { o.lightType = L.lightType; } catch (eL) {} }
        else if (L.nullLayer) o.kind = "null";
        else if (L.source instanceof CompItem) { o.kind = "precomp"; o.source = serComp(L.source, ctx); }
        else if (L.source && L.source.mainSource instanceof SolidSource) {
            o.kind = L.adjustmentLayer ? "adjustment" : "solid";
            o.solid = { color: L.source.mainSource.color, w: L.source.width, h: L.source.height, pa: L.source.pixelAspect, name: L.source.name };
        } else if (L.source) {
            o.kind = "footage";
            var f = null;
            try { f = L.source.mainSource.file; } catch (eF) {}
            o.footage = { file: f ? f.fsName : null, name: L.source.name, w: L.source.width, h: L.source.height,
                dur: L.source.duration, hasVideo: L.source.hasVideo, hasAudio: L.source.hasAudio, still: (function () { try { return L.source.mainSource.isStill; } catch (e) { return false; } })() };
        } else o.kind = "unknown";
        try { o.threeD = L.threeDLayer; o.motionBlur = L.motionBlur; o.adjustment = L.adjustmentLayer; o.blendingMode = L.blendingMode;
            o.quality = L.quality; o.collapse = L.collapseTransformation; o.frameBlendingType = L.frameBlendingType;
            o.preserveTransparency = L.preserveTransparency; o.audioEnabled = L.audioEnabled; o.guide = L.guideLayer;
            o.autoOrient = L.autoOrient; o.timeRemap = L.timeRemapEnabled; o.effectsActive = L.effectsActive; } catch (eA) {}
        try { o.samplingQuality = L.samplingQuality; } catch (eQ) {}
        try { o.trackMatteType = L.trackMatteType; } catch (eT) {}
        try { if (L.hasTrackMatte && L.trackMatteLayer) o.matte = ctx.layerIndexMap[L.trackMatteLayer.index] || 0; } catch (eM) {}
        try { if (L.parent) o.parent = ctx.layerIndexMap[L.parent.index] || 0; } catch (eP) {}
        ctx.bakeFrom = L.inPoint; ctx.bakeTo = L.outPoint;          // baked expressions: the layer's visible span
        o.props = serGroup(L, ctx);
        return o;
    }

    function serComp(comp, ctx) {
        var id = String(comp.id);
        if (!ctx.comps[id]) {
            ctx.comps[id] = { name: comp.name };                // placeholder: a comp nested in itself never loops
            var sub = { t0: 0, comps: ctx.comps, layerIndexMap: {}, bake: ctx.bake, bakeFx: ctx.bakeFx, bakeTag: ctx.bakeTag, bakeStep: comp.frameDuration }, layers = [], i;
            for (i = 1; i <= comp.numLayers; i++) sub.layerIndexMap[i] = i;
            for (i = 1; i <= comp.numLayers; i++) layers.push(serLayer(comp.layer(i), sub));
            ctx.comps[id] = { name: comp.name, w: comp.width, h: comp.height, pa: comp.pixelAspect, fps: comp.frameRate,
                dur: comp.duration, bg: comp.bgColor, ws: comp.workAreaStart, wd: comp.workAreaDuration,
                displayStart: comp.displayStartTime, motionBlur: comp.motionBlur, frameBlending: comp.frameBlending,
                shutterAngle: comp.shutterAngle, shutterPhase: comp.shutterPhase, renderer: (function () { try { return comp.renderer; } catch (e) { return null; } })(),
                layers: layers };
        }
        return { comp: id };
    }

    /** layers: Layer objects of comp. Times are stored relative to the earliest in point.
     *  opts (build tools only): { bake: RegExp, bakeFx: RegExp, tag: "ac" } - expressions matching bake are also
     *  recorded as sampled keyframes (bk), effects matching bakeFx are tagged; see buildLayers' opts.skipTags */
    function serializeLayers(comp, layers, opts) {
        opts = opts || {};
        var t0 = 1e9, i, idx = [];
        for (i = 0; i < layers.length; i++) { if (layers[i].inPoint < t0) t0 = layers[i].inPoint; idx.push(layers[i]); }
        idx.sort(function (a, b) { return a.index - b.index; });     // keep the stacking order
        var map = {};
        for (i = 0; i < idx.length; i++) map[idx[i].index] = i + 1;
        var ctx = { t0: t0, comps: {}, layerIndexMap: map, bake: opts.bake || null, bakeFx: opts.bakeFx || null, bakeTag: opts.tag || "baked",
            bakeStep: comp.frameDuration }, out = [];
        for (i = 0; i < idx.length; i++) out.push(serLayer(idx[i], ctx));
        return { version: 1, ae: app.version, compSize: [comp.width, comp.height], fps: comp.frameRate, t0: t0, layers: out, comps: ctx.comps };
    }

    // ------------------------------------------------------------------ build

    function setKeys(p, o, ctx) {
        var t = o.t, k, times = [], vals = [];
        for (k = 0; k < o.keys.length; k++) {
            var v = o.keys[k].v;
            if (v === undefined) continue;
            if (t === PVT.SHAPE && v.shape) v = objToShape(v.shape);
            else if (t === PVT.TEXT_DOCUMENT && v.textDocument) { var d = p.valueAtTime(ctx.base + o.keys[k].t, true); v = applyText(d, v.textDocument, {}); }
            else if (t === PVT.MARKER && v.marker) v = objToMarker(v.marker);
            else if (o.layerRef) v = ctx.layerRefs[v] || 0;
            times.push(ctx.base + o.keys[k].t); vals.push(v);
        }
        if (!times.length) return;
        if (t === PVT.MARKER) { for (k = 0; k < times.length; k++) p.setValueAtTime(times[k], vals[k]); return; }
        try { p.setValuesAtTimes(times, vals); } catch (eM) { for (k = 0; k < times.length; k++) p.setValueAtTime(times[k], vals[k]); }
        for (k = 0; k < o.keys.length && k < p.numKeys; k++) {
            var kk = o.keys[k], idx = p.nearestKeyIndex(ctx.base + kk.t);
            try { if (kk.it !== undefined) p.setInterpolationTypeAtKey(idx, kk.it, kk.ot); } catch (e1) {}
            try {
                if (kk.ie) {
                    var a = [], b = [], e;
                    for (e = 0; e < kk.ie.length; e++) { a.push(new KeyframeEase(kk.ie[e][0], Math.max(0.1, kk.ie[e][1]))); b.push(new KeyframeEase(kk.oe[e][0], Math.max(0.1, kk.oe[e][1]))); }
                    p.setTemporalEaseAtKey(idx, a, b);
                }
            } catch (e2) {}
            try { if (kk.tc !== undefined) { p.setTemporalContinuousAtKey(idx, kk.tc); p.setTemporalAutoBezierAtKey(idx, kk.ta); } } catch (e3) {}
            try { if (kk.si) { p.setSpatialTangentsAtKey(idx, kk.si, kk.so); p.setSpatialContinuousAtKey(idx, kk.sc); p.setSpatialAutoBezierAtKey(idx, kk.sa); } } catch (e4) {}
            try { if (kk.rv) p.setRovingAtKey(idx, true); } catch (e5) {}
        }
    }

    function applyProp(p, o, ctx) {
        if (o.custom) {
            // plug-ins keep internal rows (about box, licence, "<error>") as custom values: not settings, no warning
            // (Sapphire's "mocha" rows hold tracking data, not settings of the look)
            if (o.name && o.name !== "<error>" && !/^\s*$/.test(o.name) && !/^mocha/i.test(o.name)) ctx.warn("A setting of \"" + o.name + "\" cannot be rebuilt by a script (gradient / curve value) and keeps its default.");
            return;
        }
        // the plug-in behind this expression is not installed: its baked keyframes stand in for it
        // (one that could not be sampled just loses the expression: a broken expression would stop the render)
        if (o.bakeTag && ctx.skipTags && ctx.skipTags[o.bakeTag]) o = { mn: o.mn, name: o.name, t: o.t, sep: o.sep, keys: o.bk ? o.bk.keys : o.keys, v: o.bk ? o.bk.v : o.v };
        try { if (o.sep && !p.dimensionsSeparated) p.dimensionsSeparated = true; } catch (eS) {}
        if (o.keys && o.keys.length) {
            try { while (p.numKeys > 0) p.removeKey(1); } catch (eR) {}
            try { setKeys(p, o, ctx); } catch (eK) {}
        } else if (o.v !== undefined) {
            var v = o.v, t = o.t;
            try {
                if (t === PVT.SHAPE && v && v.shape) p.setValue(objToShape(v.shape));
                else if (t === PVT.TEXT_DOCUMENT && v && v.textDocument) {
                    var failed = {}, d = applyText(p.value, v.textDocument, failed);
                    p.setValue(d);
                    ctx.textFallback(p, v.textDocument, failed);
                } else if (o.layerRef) p.setValue(ctx.layerRefs[v] || 0);
                else if (p.canSetValue !== false && !same(p.value, v)) p.setValue(v);
            } catch (eV) {}
        }
        if (o.expr) {
            try { p.expression = o.expr; p.expressionEnabled = o.exprOn !== false; }
            catch (eX) { ctx.warn("An expression on \"" + o.name + "\" was not accepted by this After Effects version."); }
        }
    }

    // A text animator's properties only count once added (Animate > Opacity...). After Effects lists all of
    // them (inactive ones hold their defaults), so a recorded property is added when it is keyed, has an
    // expression or differs from the default it shows while inactive.
    function animatorProps(group, rec, ctx) {
        for (var i = 0; i < rec.c.length; i++) {
            var o = rec.c[i];
            if (o.g) continue;
            var keep = (o.keys && o.keys.length) || o.expr;
            if (!keep && o.v !== undefined) {
                var listed = null, dflt;
                try { listed = group.property(o.mn); dflt = listed ? listed.value : undefined; } catch (e0) { listed = null; }
                if (listed && same(dflt, o.v)) continue;
            }
            var p = null;
            try { if (group.canAddProperty(o.mn)) p = group.addProperty(o.mn); } catch (e1) { p = null; }
            if (!p) continue;
            if (!keep && o.v !== undefined) {
                var fresh;
                try { fresh = p.value; } catch (e2) {}
                if (same(fresh, o.v)) { try { p.remove(); } catch (e3) {} continue; }
            }
            applyProp(p, o, ctx);
        }
    }

    function applyGroup(g, rec, ctx, depth) {
        if (rec.mn === "ADBE Layer Styles") return;      // layer styles cannot be added from a script in every version
        if (rec.mn === "ADBE Text Animator Properties") { animatorProps(g, rec, ctx); return; }
        var i;
        if (rec.g === 2) {
            // indexed group (effects, masks, animators, selectors, shape contents): add each child in order
            for (i = 0; i < rec.c.length; i++) {
                var cr = rec.c[i], child = null;
                if (!cr.g) {
                    try { child = g.property(i + 1); } catch (eI) {}
                    if (child && child.matchName === cr.mn) applyProp(child, cr, ctx);
                    continue;
                }
                if (cr.bakeTag && ctx.skipTags && ctx.skipTags[cr.bakeTag]) continue;     // its expressions were baked
                var mn = cr.mn;
                var canAdd = false;
                try { canAdd = g.canAddProperty(mn); } catch (eC) {}
                if (!canAdd && ctx.fallbacks && ctx.fallbacks[mn]) {
                    var fb = ctx.fallbacks[mn];
                    ctx.warn(fb.why);
                    cr = fb.recipe; mn = cr.mn;
                    try { canAdd = g.canAddProperty(mn); } catch (eC2) {}
                }
                if (!canAdd) { ctx.warn("\"" + cr.name + "\" (" + cr.mn + ") is not available in this After Effects (not installed or newer than this version) and was skipped."); continue; }
                try { child = g.addProperty(mn); } catch (eA) { ctx.warn("\"" + cr.name + "\" could not be added: " + eA.toString()); continue; }
                try { if (cr.name && child.name !== cr.name) child.name = cr.name; } catch (eN) {}
                if (cr.mask) {
                    try { child.maskMode = cr.mask.mode; child.inverted = !!cr.mask.inverted; child.rotoBezier = !!cr.mask.roto; if (cr.mask.color) child.color = cr.mask.color; } catch (eMa) {}
                    try { if (cr.mask.mmb !== undefined) child.maskMotionBlur = cr.mask.mmb; if (cr.mask.falloff !== undefined) child.maskFeatherFalloff = cr.mask.falloff; } catch (eMb) {}
                }
                applyGroup(child, cr, ctx, depth + 1);
                try { if (cr.on !== undefined && child.canSetEnabled) child.enabled = cr.on; } catch (eEn) {}
            }
            return;
        }
        for (i = 0; i < rec.c.length; i++) {
            var r = rec.c[i], p = null;
            if (r.mn === "ADBE Time Remapping" && !ctx.layerTimeRemap) continue;
            try { p = g.property(r.mn); } catch (eP) { p = null; }
            if (!p) continue;                               // not in this version (or this layer type)
            if (r.g) {
                applyGroup(p, r, ctx, depth + 1);
                try { if (r.on !== undefined && p.canSetEnabled) p.enabled = r.on; } catch (eEn2) {}
            } else {
                if (r.mn === "ADBE Marker" && !(r.keys && r.keys.length)) continue;
                applyProp(p, r, ctx);
            }
        }
    }

    function findFootage(file) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            try { if (it instanceof FootageItem && it.mainSource.file && it.mainSource.file.fsName === file) return it; } catch (e) {}
        }
        return null;
    }

    function buildComp(cid, set, opts, parentFolder) {
        var cache = opts.compCache;
        if (cache[cid]) return cache[cid];
        var cr = set.comps[cid];
        var c = app.project.items.addComp(cr.name, Math.max(4, Math.round(cr.w)), Math.max(4, Math.round(cr.h)), cr.pa || 1, Math.max(0.04, cr.dur), cr.fps || 30);
        cache[cid] = c;
        try { if (parentFolder) c.parentFolder = parentFolder; } catch (eF) {}
        try { c.bgColor = cr.bg; c.motionBlur = !!cr.motionBlur; c.frameBlending = !!cr.frameBlending; c.shutterAngle = cr.shutterAngle; c.shutterPhase = cr.shutterPhase; } catch (eS) {}
        try { c.displayStartTime = cr.displayStart || 0; } catch (eD) {}
        try { if (cr.wd > 0) { c.workAreaStart = cr.ws; c.workAreaDuration = cr.wd; } } catch (eW) {}
        try { if (cr.renderer) c.renderer = cr.renderer; } catch (eR) {}
        buildInto(c, { layers: cr.layers, comps: set.comps }, { at: 0, compCache: cache, warnings: opts.warnings, fallbacks: opts.fallbacks, folder: parentFolder, relative: false, skipTags: opts.skipTags });
        return c;
    }

    function makeLayer(comp, r, set, opts, dur) {
        var L = null;
        switch (r.kind) {
            case "text": L = comp.layers.addText(""); break;
            case "shape": L = comp.layers.addShape(); break;
            case "null": L = comp.layers.addNull(dur); break;
            case "camera": L = comp.layers.addCamera(r.name, [comp.width / 2, comp.height / 2]); break;
            case "light": L = comp.layers.addLight(r.name, [comp.width / 2, comp.height / 2]); try { L.lightType = r.lightType; } catch (eLt) {} break;
            case "solid": case "adjustment":
                var s = r.solid;
                L = comp.layers.addSolid(s.color || [0, 0, 0], s.name || r.name, Math.max(4, Math.round(s.w)), Math.max(4, Math.round(s.h)), s.pa || 1, dur);
                break;
            case "precomp":
                L = comp.layers.add(buildComp(r.source.comp, set, opts, opts.folder));
                break;
            case "footage":
                var f = r.footage, item = null;
                if (f.file) {
                    item = findFootage(f.file);
                    if (!item && new File(f.file).exists) {
                        try { item = app.project.importFile(new ImportOptions(new File(f.file))); if (opts.folder) item.parentFolder = opts.folder; } catch (eI) { item = null; }
                    }
                }
                if (item) L = comp.layers.add(item);
                else {
                    opts.warnings.push("Footage \"" + (f.name || r.name) + "\" was not found" + (f.file ? " (" + f.file + ")" : "") + "; a placeholder solid stands in for it - use Replace Footage to relink.");
                    L = comp.layers.addSolid([0.35, 0.1, 0.1], "MISSING " + (f.name || r.name), Math.max(4, Math.round(f.w || comp.width)), Math.max(4, Math.round(f.h || comp.height)), 1, Math.max(dur, f.dur || dur));
                }
                break;
            default:
                opts.warnings.push("Layer \"" + r.name + "\" is of a type that cannot be rebuilt and was skipped.");
                return null;
        }
        return L;
    }

    /** Builds set.layers into comp (top of the stack, recorded order). Returns { layers, warnings }. */
    function buildInto(comp, set, opts) {
        opts = opts || {};
        if (!opts.compCache) opts.compCache = {};
        if (!opts.warnings) opts.warnings = [];
        var base = (opts.at !== undefined && opts.at !== null) ? opts.at : (opts.relative === false ? 0 : (set.t0 || 0));
        var made = [], i, recs = set.layers;
        var warnSeen = {};
        function warn(m) { if (!warnSeen[m]) { warnSeen[m] = true; opts.warnings.push(m); } }
        // bottom layer first, each new layer lands on top: the recorded order comes out unchanged
        for (i = recs.length - 1; i >= 0; i--) {
            var r = recs[i];
            var dur = Math.max(comp.frameDuration, r.outPoint - r.inPoint);
            var L = makeLayer(comp, r, set, opts, Math.max(dur, comp.duration));
            made[i] = L;
            if (!L) continue;
            try { L.name = r.name; } catch (eN) {}
        }
        var refs = {}, flags = [];
        for (i = 0; i < recs.length; i++) refs[i + 1] = made[i] ? made[i].index : 0;
        for (i = 0; i < recs.length; i++) {
            var r2 = recs[i], L2 = made[i];
            if (!L2) continue;
            try { if (r2.timeRemap && L2.canSetTimeRemapEnabled) L2.timeRemapEnabled = true; } catch (eTR) {}
            try { L2.stretch = r2.stretch || 100; } catch (eSt) {}
            try { L2.startTime = base + r2.startTime; } catch (eSt2) {}
            flags[i] = {};
            var ctx = {
                base: base, layerRefs: refs, layerTimeRemap: !!r2.timeRemap, fallbacks: opts.fallbacks, warn: warn, skipTags: opts.skipTags,
                textFallback: (function (L, fl) { return function (p, td, failed) { textFallback(L, p, td, failed, warn, fl); }; })(L2, flags[i])
            };
            try { applyGroup(L2, r2.props, ctx, 0); } catch (eG) { warn("Part of layer \"" + r2.name + "\" could not be rebuilt: " + eG.toString()); }
            try { L2.inPoint = base + r2.inPoint; L2.outPoint = base + r2.outPoint; } catch (eIO) {}
            try {
                L2.threeDLayer = !!r2.threeD;
                if (r2.motionBlur !== undefined) L2.motionBlur = r2.motionBlur;
                if (r2.adjustment) L2.adjustmentLayer = true;
                if (r2.blendingMode) L2.blendingMode = r2.blendingMode;
                if (r2.quality) L2.quality = r2.quality;
                if (r2.collapse !== undefined && L2.canSetCollapseTransformation) L2.collapseTransformation = r2.collapse;
                if (r2.frameBlendingType !== undefined) L2.frameBlendingType = r2.frameBlendingType;
                if (r2.preserveTransparency) L2.preserveTransparency = true;
                if (r2.autoOrient !== undefined) L2.autoOrient = r2.autoOrient;
                if (r2.guide) L2.guideLayer = true;
                if (r2.audioEnabled === false) L2.audioEnabled = false;
                if (r2.effectsActive === false) L2.effectsActive = false;
            } catch (eSw) {}
            try { if (r2.samplingQuality !== undefined) L2.samplingQuality = r2.samplingQuality; } catch (eSq) {}
            try { L2.label = r2.label; L2.shy = !!r2.shy; L2.comment = r2.comment || ""; } catch (eL) {}
        }
        // parenting and track mattes once every layer exists
        for (i = 0; i < recs.length; i++) {
            var r3 = recs[i], L3 = made[i];
            if (!L3) continue;
            // the recorded transform is already relative to the parent: link without compensating it
            if (r3.parent && made[r3.parent - 1]) {
                try { L3.setParentWithJump(made[r3.parent - 1]); } catch (eP) { try { L3.parent = made[r3.parent - 1]; } catch (eP2) {} }
            }
            if (r3.trackMatteType && r3.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) {
                var done = false;
                try { if (r3.matte && made[r3.matte - 1] && typeof L3.setTrackMatte === "function") { L3.setTrackMatte(made[r3.matte - 1], r3.trackMatteType); done = true; } } catch (eTM) {}
                if (!done) { try { L3.trackMatteType = r3.trackMatteType; } catch (eTM2) {} }
            }
        }
        for (i = 0; i < recs.length; i++) { try { if (made[i]) made[i].enabled = recs[i].enabled !== false; } catch (eE) {} }
        var list = [], upper = [];
        for (i = 0; i < made.length; i++) if (made[i]) { list.push(made[i]); upper.push(!!(flags[i] && flags[i].upper)); }
        return { layers: list, upper: upper, warnings: opts.warnings };
    }

    /** Older After Effects cannot set All Caps / character scale / faux styles from a script: fall back to
     *  what looks the same (upper-case text, a font size scaled by the character scale). */
    function textFallback(L, p, td, failed, warn, flags) {
        var d = p.value, changed = false;
        try {
            if (td.horizontalScale !== undefined && Math.abs((d.horizontalScale || 1) - td.horizontalScale) > 0.005 && td.fontSize) {
                var sc = (td.horizontalScale + (td.verticalScale || td.horizontalScale)) / 2;
                d.fontSize = td.fontSize * sc;
                changed = true;
                warn("This After Effects version cannot set character scale from a script; the font size was scaled instead (same size, slightly different spacing).");
            }
        } catch (e1) {}
        try {
            if (td.allCaps && !d.allCaps) {
                d.text = String(d.text).toUpperCase();
                changed = true;
                flags.upper = true;          // All Caps is not settable here: the text itself is written in capitals
            }
        } catch (e2) {}
        if (changed) { try { p.setValue(d); } catch (e3) {} }
        if (failed.fauxBold && td.fauxBold) warn("This After Effects version cannot switch on Faux Bold from a script; the captions are slightly thinner.");
    }

    function buildLayers(comp, set, opts) { return buildInto(comp, set, opts || {}); }

    return { serializeLayers: serializeLayers, buildLayers: buildLayers };
})();
