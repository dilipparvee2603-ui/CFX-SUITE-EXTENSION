/**
 * Dala Suite - GENERAL > Edit tools, host side (ExtendScript, ECMAScript 3). $._dalaSuite.edit
 *   create(json)        { type: text | adjustment | solid | null, name, color: [r, g, b] 0-1, match }
 *                       text: one text layer above the top selected layer. adjustment / solid / null: one new
 *                       layer FOR EACH selected layer, directly above it, with its in / out points (match); each
 *                       selected layer is parented to its own null without moving (keyframes kept). They share
 *                       one solid in the project. Nothing selected: one comp-long layer at the top
 *   precompose(json)    { each, trim } the selected layers in one precomp (or one precomp per layer), trimmed
 *                       to the layers' length - frame-exact: the precomp starts and ends on the comp's frames
 *                       and every layer inside keeps exactly the frames it showed, so no first or last frame is
 *                       lost and no black frame appears between clips
 *   duplicate(json)     { mode: new | unique, deep } an independent copy of each selected precomp: a new layer
 *                       next to it (new) or the selected layer itself switched to the copy (unique); deep also
 *                       copies the precomps nested inside
 *   copyFx()            remembers the effects (values, keyframes, expressions) and the look of the first
 *                       selected layer; pasteFx(json) { effects, replace, blend, transform, keys, timing:
 *                       shift | fit } puts them on every selected layer
 *   curveRead()         the temporal ease of the selected keyframe pairs (influence + speed / average speed)
 *   curveApply(json)    { outInf, outRatio, inInf, inRatio } that ease on every selected pair of keyframes
 *                       (no keyframes selected: the Time Remap keys of the selected layers)
 *   importMedia(json)   { path } a downloaded video / picture into the comp, or into a new comp when none is open
 * Every action is one undo step. Decompose is host/unprecompose.jsx.
 */

$._dalaSuite.edit = (function () {
    var STYLE_KEY = "dalaCopiedFx";

    function R(ok, msg, data) { return $._dalaSuite.formatResult(ok, msg, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : (json || {}); }
    function activeComp() { var c = app.project.activeItem; return (c && c instanceof CompItem) ? c : null; }
    function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
    function quote(s) { return "\u201C" + s + "\u201D"; }
    function tg(L) { return L.property("ADBE Transform Group"); }
    function isCamLight(L) { return (L instanceof CameraLayer) || (L instanceof LightLayer); }
    function isPrecomp(L) { try { return !!(L.source && L.source instanceof CompItem); } catch (e) { return false; } }
    function deselectAll(c) { for (var i = 1; i <= c.numLayers; i++) { try { c.layer(i).selected = false; } catch (e) {} } }
    function topOf(list) { var t = list[0]; for (var i = 1; i < list.length; i++) if (list[i].index < t.index) t = list[i]; return t; }

    /** runs fn(comp) as one undo step; fn returns the result string */
    function undoable(name, fn) {
        var c = activeComp();
        if (!c) return R(false, "Open a composition first.");
        app.beginUndoGroup("Dala Suite: " + name);
        var out;
        try { out = fn(c); } catch (e) { app.endUndoGroup(); return R(false, name + " failed: " + (e.message || e)); }
        app.endUndoGroup();
        return out;
    }

    // ------------------------------------------------------------------ new layers

    function create(json) {
        var a = parse(json), type = String(a.type || "");
        var title = { text: "New text", adjustment: "New adjustment layer", solid: "New solid", "null": "New null" }[type];
        if (!title) return R(false, "Unknown layer type " + type + ".");
        return undoable(title, function (c) {
            var sel = c.selectedLayers;
            if (type !== "text" && sel.length > 1) return perLayer(c, a, type, sel);
            var ref = sel.length ? sel[0] : null, w = c.width, h = c.height, d = c.duration, L, i;
            var name = a.name ? String(a.name) : "";
            if (type === "text") {
                L = c.layers.addText("Your text");
                var st = L.property("ADBE Text Properties").property("ADBE Text Document"), td = st.value;
                td.fontSize = Math.round(h / 9);
                try { td.applyFill = true; } catch (eF) {}
                td.fillColor = [1, 1, 1];
                td.justification = ParagraphJustification.CENTER_JUSTIFY;
                st.setValue(td);
                var r = L.sourceRectAtTime(c.time, false);
                tg(L).property("ADBE Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
                tg(L).property("ADBE Position").setValue([w / 2, h / 2]);
            } else L = newLayer(c, type, a, null, ref);
            if (name && type !== "null") { try { L.name = name; } catch (eN) {} }
            var note = "";
            if (ref) {
                L.moveBefore(topOf(sel));
                if (a.match) { L.inPoint = Math.max(0, ref.inPoint); L.outPoint = ref.outPoint; }
                if (type === "null") note = adopt(L, sel);
            }
            deselectAll(c);
            L.selected = true;
            return R(true, quote(L.name) + " added" + note, { name: L.name, count: 1 });
        });
    }

    /** a new adjustment layer / solid / null; `proto` (an earlier one) is duplicated so they share one solid item */
    function newLayer(c, type, a, proto, ref) {
        var L, w = c.width, h = c.height, d = c.duration, name = a.name ? String(a.name) : "";
        if (proto) {
            L = proto.duplicate();
            try { if (L.parent) L.setParentWithJump(null); } catch (eP) {}
        } else if (type === "adjustment") {
            L = c.layers.addSolid([1, 1, 1], name || "Adjustment Layer", w, h, c.pixelAspect, d);
            L.adjustmentLayer = true;
            L.label = 5;
        } else if (type === "solid") {
            var col = (a.color && a.color.length === 3) ? a.color : [0.04, 0.04, 0.04];
            L = c.layers.addSolid(col, name || "Solid", w, h, c.pixelAspect, d);
        } else {
            L = c.layers.addNull(d);
        }
        if (type === "null") {
            L.name = name || (ref ? ref.name + " \u00B7 control" : "Control");
            // on the layer it controls (where that layer's position is, in the same parent space), else the comp centre
            var where = [w / 2, h / 2], three = false;
            if (ref && !isCamLight(ref)) {
                try {
                    var pv = tg(ref).property("ADBE Position").valueAtTime(c.time, false);
                    where = [pv[0], pv[1]];
                    if (ref.threeDLayer && pv.length > 2) { three = true; where.push(pv[2]); }
                } catch (eV) {}
            } else if (ref) {
                try { var cp = tg(ref).property("ADBE Position").valueAtTime(c.time, false); where = [cp[0], cp[1], cp[2]]; three = true; } catch (eC) {}
            }
            try { L.threeDLayer = three; } catch (e3) {}
            if (ref && ref.parent) { try { L.setParentWithJump(ref.parent); } catch (eJ) {} }
            tg(L).property("ADBE Position").setValue(three ? where : [where[0], where[1]]);
        } else if (ref) {
            try { L.name = name || ref.name + " \u00B7 " + (type === "adjustment" ? "adjust" : "solid"); } catch (eN) {}
        }
        return L;
    }

    /** one new layer per selected layer, right above it, with its in / out points; nulls take their layer as child */
    function perLayer(c, a, type, sel) {
        var list = [], made = [], proto = null, notParented = 0, i;
        for (i = 0; i < sel.length; i++) list.push(sel[i]);
        list.sort(function (x, y) { return x.index - y.index; });
        for (i = 0; i < list.length; i++) {
            var ref = list[i], N = newLayer(c, type, a, proto, ref);
            if (!proto) proto = N;
            N.moveBefore(ref);
            if (a.match !== false) {
                N.startTime = ref.inPoint;
                N.inPoint = ref.inPoint;
                N.outPoint = ref.outPoint;
            }
            if (type === "null") {
                if (ref.locked) notParented++;
                else { try { ref.parent = N; } catch (eR) { notParented++; } }    // parent= keeps the layer where it is
            }
            made.push(N);
        }
        deselectAll(c);
        for (i = 0; i < made.length; i++) { try { made[i].selected = true; } catch (eS) {} }
        var what = { adjustment: "adjustment layer", solid: "solid", "null": "null" }[type];
        return R(true, plural(made.length, what) + " added, one above each selected layer with its timing" +
            (type === "null" ? (notParented < made.length ? "; each layer is parented to its own null without moving" : "") +
            (notParented ? " (" + plural(notParented, "locked layer") + " not parented)" : "") : ""), { count: made.length });
    }

    /** The selected layers follow the new null without moving on screen. Only the top of each chain is
     *  re-parented (a selected child of a selected parent keeps its parent); the null takes the parent they shared. */
    function adopt(N, sel) {
        var inSel = {}, roots = [], i, locked = 0;
        for (i = 0; i < sel.length; i++) inSel[sel[i].index] = true;
        for (i = 0; i < sel.length; i++) if (!(sel[i].parent && inSel[sel[i].parent.index])) roots.push(sel[i]);
        var shared = roots[0].parent;
        for (i = 1; i < roots.length; i++) if (roots[i].parent !== shared) shared = null;
        if (shared) { try { N.parent = shared; } catch (eS) {} }
        for (i = 0; i < roots.length; i++) {
            if (roots[i].locked) { locked++; continue; }
            try { roots[i].parent = N; } catch (eR) { locked++; }
        }
        return locked ? " (" + plural(locked, "locked layer") + " not parented)" : "";
    }

    // ------------------------------------------------------------------ precompose

    /** first visible frame and the frame after the last of a layer: it shows at frame f when inPoint <= f * fd < outPoint */
    function frameSpan(L, fd) { return [Math.ceil(L.inPoint / fd - 1e-6), Math.ceil(L.outPoint / fd - 1e-6)]; }

    /** one precomp from these layers, trimmed to them if asked; returns the new precomp layer. Frame-exact: the precomp
     *  starts on the frame where the first layer shows, it is a whole number of frames long, the layers inside move by
     *  a whole number of frames and keep exactly the frames they showed (in / out points set on frames), and the
     *  precomp layer plays them at the same frames - so no first / last frame is cut and no black frame appears at a
     *  cut, whatever the footage's frame rate or the clips' in / out points */
    function precompOne(c, layers, nm, trim) {
        var idx = [], fd = c.frameDuration, loF = 1e9, hiF = -1e9, spans = {}, i;
        for (i = 0; i < layers.length; i++) {
            idx.push(layers[i].index);
            var sp = frameSpan(layers[i], fd);
            loF = Math.min(loF, sp[0]);
            hiF = Math.max(hiF, sp[1]);
        }
        idx.sort(function (x, y) { return x - y; });
        var nc = c.layers.precompose(idx, nm, true), pl = null;
        // a scripted precompose takes the FOOTAGE's frame rate (25 fps clips in a 30 fps comp -> a 25 fps precomp): its
        // length then rounds to its own frames, shorter than the clip on the timeline - the clip's last frame is cut and
        // a black frame shows before the next clip. The precomp gets the comp's frame rate, as Pre-compose in the menu
        try { if (Math.abs(nc.frameRate - c.frameRate) > 1e-6) nc.frameRate = c.frameRate; } catch (eR) {}
        for (i = 1; i <= c.numLayers; i++) { var s = c.layer(i).source; if (s && s.id === nc.id) { pl = c.layer(i); break; } }
        if (trim && pl && hiF > loF) {
            var lo = loF * fd;
            for (i = 1; i <= nc.numLayers; i++) {
                var L = nc.layer(i), lk = L.locked, sp2 = frameSpan(L, fd);
                L.locked = false;
                L.startTime -= lo;
                if (sp2[1] > sp2[0]) { L.inPoint = (sp2[0] - loF) * fd; L.outPoint = (sp2[1] - loF) * fd; }
                L.locked = lk;
            }
            setFrames(nc, hiF - loF);
            pl.startTime = lo;
            pl.inPoint = lo;
            pl.outPoint = hiF * fd;
        }
        // the composition label colour (Sandstone by default), so the precomp stands out from what it holds
        if (pl) { pl.label = nc.label > 0 ? nc.label : 15; pl.name = nm; }
        return pl;
    }

    /** comp duration = exactly n frames */
    function setFrames(comp, n) {
        comp.duration = n * comp.frameDuration;
    }

    function precompose(json) {
        var a = parse(json);
        return undoable("Precompose", function (c) {
            var sel = c.selectedLayers, list = [], i;
            if (!sel.length) return R(false, "Select the layers to precompose.");
            for (i = 0; i < sel.length; i++) list.push(sel[i]);
            if (a.each && list.length > 1) {
                var made = [];
                for (i = 0; i < list.length; i++) { var p1 = precompOne(c, [list[i]], list[i].name, a.trim !== false); if (p1) made.push(p1); }
                deselectAll(c);
                for (i = 0; i < made.length; i++) made[i].selected = true;
                return R(true, plural(made.length, "precomp") + " created, one per layer", { count: made.length });
            }
            var top = topOf(list);
            var nm = list.length === 1 ? list[0].name : top.name + " +" + (list.length - 1);
            var pl = precompOne(c, list, nm, a.trim !== false);
            return R(true, "Precomposed as " + quote(nm), { count: 1, name: nm, duration: pl ? pl.source.duration : 0 });
        });
    }

    // ------------------------------------------------------------------ duplicate precomp (independent)

    function copyName(n) {
        var base = String(n).replace(/ copy( \d+)?$/, ""), taken = {}, i, k = 2, name = base + " copy";
        for (i = 1; i <= app.project.numItems; i++) taken[app.project.item(i).name] = true;
        while (taken[name]) { name = base + " copy " + k; k++; }
        return name;
    }

    function dupComp(cmp, deep, memo) {
        if (memo.map[cmp.id]) return memo.map[cmp.id];
        var d = cmp.duplicate();
        d.name = copyName(cmp.name);
        memo.map[cmp.id] = d;
        memo.count++;
        if (deep) {
            for (var i = 1; i <= d.numLayers; i++) {
                var L = d.layer(i);
                if (!isPrecomp(L)) continue;
                try { var lk = L.locked; L.locked = false; L.replaceSource(dupComp(L.source, deep, memo), false); L.locked = lk; } catch (e) {}
            }
        }
        return d;
    }

    function duplicate(json) {
        var a = parse(json), unique = a.mode === "unique", deep = a.deep !== false;
        return undoable("Duplicate precomp", function (c) {
            var sel = c.selectedLayers, list = [], i;
            for (i = 0; i < sel.length; i++) if (isPrecomp(sel[i])) list.push(sel[i]);
            if (!list.length) return R(false, sel.length ? "Select a precomp layer: Duplicate makes an independent copy of a precomp." : "Select the precomp layer to duplicate.");
            var memo = { map: {}, count: 0 }, names = [], made = [];
            for (i = 0; i < list.length; i++) {
                var L = list[i], copy = dupComp(L.source, deep, memo), target = unique ? L : L.duplicate();
                var lk = target.locked;
                target.locked = false;
                target.replaceSource(copy, false);
                if (!unique) target.name = copy.name;
                target.locked = lk;
                names.push(copy.name);
                made.push(target);
            }
            deselectAll(c);
            for (i = 0; i < made.length; i++) { try { made[i].selected = true; } catch (eS) {} }
            var nested = memo.count - list.length;
            return R(true, (list.length === 1 ? quote(names[0]) + " created" : plural(list.length, "precomp") + " duplicated") +
                ", independent from the original" + (nested > 0 ? " (+" + nested + " nested)" : ""), { count: list.length, names: names });
        });
    }

    // ------------------------------------------------------------------ copy fx / paste fx

    function readKeys(p) {
        var ks = [], spatial = false, k, d;
        try { spatial = p.isSpatial; } catch (e0) {}
        for (k = 1; k <= p.numKeys; k++) {
            var e = { t: p.keyTime(k), v: p.keyValue(k) };
            try { e.ii = p.keyInInterpolationType(k); e.oi = p.keyOutInterpolationType(k); } catch (e1) {}
            try {
                var ie = p.keyInTemporalEase(k), oe = p.keyOutTemporalEase(k);
                e.ie = []; e.oe = [];
                for (d = 0; d < ie.length; d++) { e.ie.push([ie[d].speed, ie[d].influence]); e.oe.push([oe[d].speed, oe[d].influence]); }
            } catch (e2) {}
            try { e.tc = p.keyTemporalContinuous(k); e.ab = p.keyTemporalAutoBezier(k); } catch (e3) {}
            if (spatial) { try { e.si = p.keyInSpatialTangent(k); e.so = p.keyOutSpatialTangent(k); e.sc = p.keySpatialContinuous(k); e.sab = p.keySpatialAutoBezier(k); } catch (e4) {} }
            ks.push(e);
        }
        return ks;
    }

    /** map: { a: source in point, b: target in point, k: time scale }; speeds are divided by k so the
     *  speed graph keeps its exact shape when the animation is fitted to another clip length */
    function writeKeys(p, ks, map) {
        var times = [], vals = [], i, d;
        for (i = 0; i < ks.length; i++) { times.push(map.b + (ks[i].t - map.a) * map.k); vals.push(ks[i].v); }
        p.setValuesAtTimes(times, vals);
        for (i = 0; i < ks.length; i++) {
            var e = ks[i], key = p.nearestKeyIndex(times[i]);
            try { if (e.ii !== undefined) p.setInterpolationTypeAtKey(key, e.ii, e.oi); } catch (x1) {}
            try { if (e.tc !== undefined) { p.setTemporalContinuousAtKey(key, e.tc); p.setTemporalAutoBezierAtKey(key, e.ab); } } catch (x2) {}
            if (e.ie && !e.ab) {
                try {
                    var inE = [], outE = [];
                    for (d = 0; d < e.ie.length; d++) { inE.push(new KeyframeEase(e.ie[d][0] / map.k, e.ie[d][1])); outE.push(new KeyframeEase(e.oe[d][0] / map.k, e.oe[d][1])); }
                    p.setTemporalEaseAtKey(key, inE, outE);
                } catch (x3) {}
            }
            if (e.si) { try { p.setSpatialTangentsAtKey(key, e.si, e.so); p.setSpatialContinuousAtKey(key, e.sc); p.setSpatialAutoBezierAtKey(key, e.sab); } catch (x4) {} }
        }
    }

    function readProps(group, withKeys, count) {
        var out = [], i;
        for (i = 1; i <= group.numProperties; i++) {
            var p = group.property(i), e = { i: i };
            if (!p) continue;
            if (p.propertyType === PropertyType.PROPERTY) {
                var vt = p.propertyValueType;
                if (vt === PropertyValueType.NO_VALUE || vt === PropertyValueType.CUSTOM_VALUE || vt === PropertyValueType.LAYER_INDEX || vt === PropertyValueType.MASK_INDEX) continue;
                try { e.v = p.value; } catch (x) { continue; }
                try { if (p.canSetExpression && p.expressionEnabled && p.expression) e.x = p.expression; } catch (xE) {}
                if (withKeys && p.numKeys > 0) { e.k = readKeys(p); count.n += p.numKeys; }
                out.push(e);
            } else {
                e.g = readProps(p, withKeys, count);
                if (e.g.length) out.push(e);
            }
        }
        return out;
    }

    function writeProps(group, list, map) {
        for (var i = 0; i < list.length; i++) {
            var e = list[i], p = null;
            try { p = group.property(e.i); } catch (x) { continue; }
            if (!p) continue;
            if (e.g) { writeProps(p, e.g, map); continue; }
            try {
                while (p.numKeys) p.removeKey(1);
                if (e.k && map) writeKeys(p, e.k, map); else p.setValue(e.v);
                if (e.x) p.expression = e.x;
            } catch (y) {}
        }
    }

    function copyFx() {
        var c = activeComp();
        if (!c) return R(false, "Open a composition first.");
        var L = c.selectedLayers[0];
        if (!L) return R(false, "Select the layer to copy the effects from.");
        var count = { n: 0 }, fxg = L.property("ADBE Effect Parade"), fx = [], names = [], i;
        if (fxg) for (i = 1; i <= fxg.numProperties; i++) {
            var f = fxg.property(i);
            fx.push({ match: f.matchName, name: f.name, props: readProps(f, true, count) });
            names.push(f.name);
        }
        var T = tg(L), s = { layer: L.name, inPoint: L.inPoint, duration: L.outPoint - L.inPoint, keys: count.n, effects: fx, threeD: L.threeDLayer };
        try { s.opacity = T.property("ADBE Opacity").value; s.scale = T.property("ADBE Scale").value; s.rotation = T.property("ADBE Rotate Z").value; } catch (eT) {}
        try { s.blend = L.blendingMode; s.motionBlur = L.motionBlur; } catch (eB) {}
        $.global[STYLE_KEY] = s;
        return R(true, "Copied " + (names.length ? plural(names.length, "effect") : "the look") + " of " + quote(L.name) + (count.n ? " \u00B7 " + plural(count.n, "keyframe") : ""),
            { layer: L.name, effects: names, keys: count.n, duration: s.duration });
    }

    function copiedFx() {
        var s = $.global[STYLE_KEY];
        if (!s) return R(true, "Nothing copied yet", { copied: false });
        var names = [];
        for (var i = 0; i < s.effects.length; i++) names.push(s.effects[i].name);
        return R(true, "ok", { copied: true, layer: s.layer, effects: names, keys: s.keys, duration: s.duration });
    }

    function pasteFx(json) {
        var o = parse(json), s = $.global[STYLE_KEY];
        if (!s) return R(false, "Copy fx first: select a layer and press Copy fx.");
        return undoable("Paste fx", function (c) {
            var sel = c.selectedLayers, n = 0, fitted = 0, i, j;
            if (!sel.length) return R(false, "Select the layers to paste the effects on.");
            for (i = 0; i < sel.length; i++) {
                var L = sel[i];
                if (isCamLight(L)) continue;
                var map = null;
                if (o.keys && s.keys) {
                    var d = L.outPoint - L.inPoint, k = (o.timing === "fit" && s.duration > 0 && d > 0) ? d / s.duration : 1;
                    map = { a: s.inPoint, b: L.inPoint, k: k };
                    if (Math.abs(k - 1) > 1e-6) fitted++;
                }
                if (o.effects !== false) {
                    var fxg = L.property("ADBE Effect Parade");
                    if (fxg) {
                        if (o.replace) for (j = fxg.numProperties; j >= 1; j--) fxg.property(j).remove();
                        for (j = 0; j < s.effects.length; j++) {
                            if (!fxg.canAddProperty(s.effects[j].match)) continue;
                            var fx = fxg.addProperty(s.effects[j].match);
                            try { fx.name = s.effects[j].name; } catch (eN) {}
                            writeProps(fx, s.effects[j].props, map);
                        }
                    }
                }
                if (o.transform && s.scale) {
                    var sc = s.scale;
                    if (L.threeDLayer && sc.length < 3) sc = [sc[0], sc[1], 100];
                    else if (!L.threeDLayer && sc.length > 2) sc = [sc[0], sc[1]];
                    try { tg(L).property("ADBE Scale").setValue(sc); tg(L).property("ADBE Rotate Z").setValue(s.rotation); } catch (eT) {}
                }
                if (o.blend !== false) {
                    try { L.blendingMode = s.blend; } catch (eB1) {}
                    try { tg(L).property("ADBE Opacity").setValue(s.opacity); } catch (eB2) {}
                    try { L.motionBlur = s.motionBlur; } catch (eB3) {}
                }
                n++;
            }
            if (!n) return R(false, "Cameras and lights have no effects: select other layers.");
            return R(true, "Pasted on " + plural(n, "layer") + (fitted ? " \u00B7 animation fitted to " + plural(fitted, "clip") : ""), { count: n, fitted: fitted });
        });
    }

    // ------------------------------------------------------------------ curves (temporal ease)

    function easeable(p) {
        if (!p || p.propertyType !== PropertyType.PROPERTY || p.numKeys < 2) return false;
        var vt = p.propertyValueType;
        return vt !== PropertyValueType.NO_VALUE && vt !== PropertyValueType.CUSTOM_VALUE && vt !== PropertyValueType.SHAPE &&
            vt !== PropertyValueType.TEXT_DOCUMENT && vt !== PropertyValueType.MARKER;
    }

    /** length of the motion path between key k and k+1: AE measures the speed of a spatial property along its
     *  curved path, so the ease has to use that length to come out exactly like AE's own graph */
    function pathLength(p, k, v1, v2) {
        var o = null, n = null, i, dims = v1.length;
        try { o = p.keyOutSpatialTangent(k); n = p.keyInSpatialTangent(k + 1); } catch (e) { o = null; n = null; }
        var c1 = [], c2 = [];
        for (i = 0; i < dims; i++) { c1.push(v1[i] + (o ? (o[i] || 0) : 0)); c2.push(v2[i] + (n ? (n[i] || 0) : 0)); }
        var len = 0, prev = v1.slice(0), steps = 200;
        for (var j = 1; j <= steps; j++) {
            var t = j / steps, u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t, sq = 0, pt = [];
            for (i = 0; i < dims; i++) { pt.push(b0 * v1[i] + b1 * c1[i] + b2 * c2[i] + b3 * v2[i]); sq += (pt[i] - prev[i]) * (pt[i] - prev[i]); }
            len += Math.sqrt(sq);
            prev = pt;
        }
        return len;
    }

    /** the average speed between key k and k+1, per dimension (one value for a spatial property) */
    function avgSpeeds(p, k) {
        var v1 = p.keyValue(k), v2 = p.keyValue(k + 1), dt = p.keyTime(k + 1) - p.keyTime(k), out = [], j;
        if (dt <= 0) dt = 1e-6;
        if (!(v1 instanceof Array)) return [Math.abs(v2 - v1) / dt];
        if (p.isSpatial) return [pathLength(p, k, v1, v2) / dt];
        for (j = 0; j < v1.length; j++) out.push(Math.abs(v2[j] - v1[j]) / dt);
        return out;
    }

    function selectedPairs(c) {
        var props = c.selectedProperties, pairs = [], i, k;
        for (i = 0; i < props.length; i++) {
            var p = props[i];
            if (!easeable(p)) continue;
            var keys = p.selectedKeys;
            if (!keys || !keys.length) continue;
            if (keys.length === 1) { if (keys[0] < p.numKeys) pairs.push([p, keys[0]]); continue; }
            for (k = 0; k < keys.length - 1; k++) pairs.push([p, keys[k]]);
        }
        if (!pairs.length) {   // no keyframes selected: the Time Remap keys of the selected layers
            var ls = c.selectedLayers;
            for (i = 0; i < ls.length; i++) {
                try {
                    if (!ls[i].timeRemapEnabled) continue;
                    var tr = ls[i].property("ADBE Time Remapping");
                    if (!easeable(tr)) continue;
                    for (k = 1; k < tr.numKeys; k++) pairs.push([tr, k]);
                } catch (eT) {}
            }
        }
        return pairs;
    }

    function fmtVal(v) {
        function one(x) { return String(Math.round(x * 10) / 10); }
        if (v instanceof Array) { var o = []; for (var i = 0; i < v.length; i++) o.push(one(v[i])); return o.join(", "); }
        return typeof v === "number" ? one(v) : "";
    }

    function pairInfo(p, k, fps) {
        var avg = avgSpeeds(p, k)[0] || 1e-6;
        var o = p.keyOutTemporalEase(k)[0], n = p.keyInTemporalEase(k + 1)[0];
        var t1 = p.keyTime(k), t2 = p.keyTime(k + 1), layer = "", linear = false, hold = false;
        try { layer = p.propertyGroup(p.propertyDepth).name; } catch (e) {}
        try { linear = p.keyOutInterpolationType(k) === KeyframeInterpolationType.LINEAR && p.keyInInterpolationType(k + 1) === KeyframeInterpolationType.LINEAR; } catch (e2) {}
        try { hold = p.keyOutInterpolationType(k) === KeyframeInterpolationType.HOLD; } catch (e3) {}
        function r1(x) { return Math.round(x * 10) / 10; }
        return {
            prop: p.name, layer: layer, k1: k, k2: k + 1, t1: t1, t2: t2, frames: Math.round((t2 - t1) * fps),
            v1: fmtVal(p.keyValue(k)), v2: fmtVal(p.keyValue(k + 1)),
            outInf: r1(o.influence), inInf: r1(n.influence), outSpeed: r1(Math.abs(o.speed)), inSpeed: r1(Math.abs(n.speed)), avg: r1(avg),
            linear: linear, hold: hold,
            curve: { outInf: o.influence, inInf: n.influence, outRatio: Math.abs(o.speed) / avg, inRatio: Math.abs(n.speed) / avg }
        };
    }

    function curveRead() {
        var c = activeComp();
        if (!c) return R(false, "Open a composition first.");
        var pairs = selectedPairs(c);
        if (!pairs.length) return R(false, "Select two or more keyframes of a property (or a layer with Time Remap keys).");
        var out = [], fps = c.frameRate || 30;
        for (var i = 0; i < pairs.length && out.length < 60; i++) { try { out.push(pairInfo(pairs[i][0], pairs[i][1], fps)); } catch (e) {} }
        if (!out.length) return R(false, "Those keyframes have no ease to read.");
        return R(true, "ok", { pairs: out, total: pairs.length });
    }

    function curveApply(json) {
        var cv = parse(json);
        var outInf = Math.max(0.1, Math.min(100, Number(cv.outInf) || 0.1)), inInf = Math.max(0.1, Math.min(100, Number(cv.inInf) || 0.1));
        var outRatio = Number(cv.outRatio) || 0, inRatio = Number(cv.inRatio) || 0;
        return undoable("Apply curve", function (c) {
            var pairs = selectedPairs(c), done = 0, flat = false, i, d;
            if (!pairs.length) return R(false, "Select two or more keyframes of a property (or a layer with Time Remap keys).");
            for (i = 0; i < pairs.length; i++) {
                var p = pairs[i][0], k = pairs[i][1], avg = avgSpeeds(p, k), dims = p.keyOutTemporalEase(k).length;
                if (!p.isSpatial) {   // a value that goes down needs a negative speed
                    var w1 = p.keyValue(k), w2 = p.keyValue(k + 1);
                    if (!(w1 instanceof Array)) { w1 = [w1]; w2 = [w2]; }
                    for (d = 0; d < avg.length && d < w1.length; d++) if (w2[d] < w1[d]) avg[d] = -avg[d];
                }
                var outE = [], inE = [];
                for (d = 0; d < dims; d++) {
                    var av = avg[Math.min(d, avg.length - 1)], so = outRatio * av, si = inRatio * av;
                    // a spatial speed cannot be negative (overshoot): AE keeps it at 0
                    if (p.isSpatial && (so < 0 || si < 0)) { so = Math.max(0, so); si = Math.max(0, si); flat = true; }
                    outE.push(new KeyframeEase(so, outInf));
                    inE.push(new KeyframeEase(si, inInf));
                }
                try {
                    p.setTemporalAutoBezierAtKey(k, false); p.setTemporalAutoBezierAtKey(k + 1, false);
                    p.setTemporalContinuousAtKey(k, false); p.setTemporalContinuousAtKey(k + 1, false);
                } catch (eC) {}
                p.setInterpolationTypeAtKey(k, p.keyInInterpolationType(k), KeyframeInterpolationType.BEZIER);
                p.setInterpolationTypeAtKey(k + 1, KeyframeInterpolationType.BEZIER, p.keyOutInterpolationType(k + 1));
                p.setTemporalEaseAtKey(k, p.keyInTemporalEase(k), outE);
                p.setTemporalEaseAtKey(k + 1, inE, p.keyOutTemporalEase(k + 1));
                done++;
            }
            return R(true, "Curve applied to " + plural(done, "keyframe pair"), { count: done, flat: flat });
        });
    }

    // ------------------------------------------------------------------ import a downloaded file

    function importMedia(json) {
        var a = parse(json), f = new File(a.path);
        if (!f.exists) return R(false, "The downloaded file is missing: " + a.path);
        var item;
        // imported outside the undo group (AE mis-counts undo steps for imports inside one)
        try { item = app.project.importFile(new ImportOptions(f)); } catch (eI) { return R(false, "After Effects could not import " + f.displayName + ": " + (eI.message || eI)); }
        app.beginUndoGroup("Dala Suite: Import from a link");
        try {
            var folder = null, i;
            for (i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === "Dala downloads") { folder = it; break; } }
            if (!folder) folder = app.project.items.addFolder("Dala downloads");
            try { item.parentFolder = folder; } catch (eF) {}
            var comp = activeComp(), made = false, visual = false;
            try { visual = item.hasVideo && item.width > 0; } catch (eV) {}
            if (!comp) {
                if (!visual) { app.endUndoGroup(); return R(true, quote(item.name) + " imported in the project", { name: item.name, newComp: false }); }
                var still = false;
                try { still = item.mainSource && item.mainSource.isStill; } catch (eS) {}
                comp = app.project.items.addComp(item.name.replace(/\.[^.]+$/, ""), item.width, item.height, item.pixelAspect || 1,
                    still ? 5 : Math.max(item.duration, 1), item.frameRate > 0 ? item.frameRate : 30);
                try { comp.parentFolder = folder; } catch (eC) {}
                made = true;
            }
            var sel = comp.selectedLayers, ref = sel.length ? topOf(sel) : null, L = comp.layers.add(item), sc = 100;
            if (!made) {
                if (ref) { try { L.moveBefore(ref); } catch (eM) {} }
                try { L.startTime = comp.time; } catch (eT) {}
                if (visual) {
                    var iw = item.width * (item.pixelAspect || 1) / (comp.pixelAspect || 1);
                    sc = Math.min(comp.width / iw, comp.height / item.height, 1) * 100;
                    if (sc < 100) tg(L).property("ADBE Scale").setValue([sc, sc]);
                    tg(L).property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
                }
            }
            deselectAll(comp);
            L.selected = true;
            if (made) comp.openInViewer();
            app.endUndoGroup();
            return R(true, (made ? "Imported in a new comp" : "Imported in the comp") + (sc < 100 ? " (scaled to " + Math.round(sc) + "%)" : ""),
                { name: item.name, w: item.width || 0, h: item.height || 0, newComp: made });
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Importing failed: " + (e.message || e));
        }
    }

    return {
        create: create, precompose: precompose, duplicate: duplicate,
        copyFx: copyFx, copiedFx: copiedFx, pasteFx: pasteFx,
        curveRead: curveRead, curveApply: curveApply, importMedia: importMedia
    };
})();
