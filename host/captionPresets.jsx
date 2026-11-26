/**
 * CFX Suite - custom caption styles (ExtendScript, ECMAScript 3)
 *
 * Auto Captions > CUSTOM: a user's own text animation becomes a caption style. Driven by
 * client/js/captions/customStyles.js:
 *   check()          CHECK SELECTED LAYER: what the selected layers / precomps of the active comp would make.
 *                    Each selected precomp with a text layer inside is one look; the other selected layers
 *                    together (at least one of them text) make one more look. Lists per look its text parts,
 *                    animated properties, effects (third-party ones flagged), fonts and anything that will not
 *                    carry over (Source Text keyframes, expressions reaching outside the look, footage files).
 *   capture({out})   CREATE CAPTION PRESET STYLE: writes every look as a layer recipe (host/layerRecipe.jsx) to the
 *                    file out - the same form as the built-in Text Presets: the look's precomp layer with its comp
 *                    nested inside; loose layers get a comp of their own (the active comp's size). Animation
 *                    Composer expressions are also baked to keyframes, so the style works without the plug-in.
 * Nothing in the project changes.
 */

$._cfxSuite.captionPresets = (function () {
    var BAKE = { bake: /getAnimationComposerPresetValue|ANIMATION COMPOSER/, bakeFx: /^Pseudo\/MHAC/, tag: "ac" };
    var MAX_DEPTH = 5;

    function R(ok, msg, data) { return $._cfxSuite.formatResult(ok, msg, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : (json || {}); }

    function activeComp() {
        var c = app.project ? app.project.activeItem : null;
        if (c && c instanceof CompItem) return c;
        try {
            var v = app.activeViewer;
            if (v && v.type === ViewerType.VIEWER_COMPOSITION) { v.setActive(); c = app.project.activeItem; if (c && c instanceof CompItem) return c; }
        } catch (e) {}
        return null;
    }
    function isComp(L) { try { return L.source instanceof CompItem; } catch (e) { return false; } }
    function kindOf(L) {
        if (L instanceof TextLayer) return "text";
        if (L instanceof ShapeLayer) return "shape";
        if (L instanceof CameraLayer) return "camera";
        if (L instanceof LightLayer) return "light";
        try { if (L.nullLayer) return "null"; } catch (e) {}
        if (isComp(L)) return "precomp";
        try { if (L.adjustmentLayer) return "adjustment"; if (L.source && L.source.mainSource instanceof SolidSource) return "solid"; } catch (e2) {}
        return "footage";
    }

    /** Text layers inside a comp (precomps followed, up to MAX_DEPTH). */
    function textCount(comp, depth) {
        var n = 0, i;
        if (depth > MAX_DEPTH) return 0;
        for (i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (L instanceof TextLayer) n++;
            else if (isComp(L)) n += textCount(L.source, depth + 1);
        }
        return n;
    }

    /** Walks a layer (and what its precomp holds) and adds to info: keyed properties, expressions, effects,
     *  fonts, Source Text keys, footage, comps reached by expressions. */
    function scanLayer(L, info, depth, compsIn) {
        var k = kindOf(L);
        info.layers++;
        if (k === "text") {
            info.texts++;
            try {
                var st = L.property("ADBE Text Properties").property("ADBE Text Document");
                var d = st.value;
                if (d.font && !info.fontSeen[d.font]) { info.fontSeen[d.font] = 1; info.fonts.push(d.font); }
                if (st.numKeys > 1) info.sourceTextKeys++;
                info.samples.push(String(d.text).replace(/[\r\n]+/g, " / "));
            } catch (eT) {}
        }
        if (k === "footage") {
            try { info.footage.push(L.source.name); } catch (eF) {}
        }
        (function walk(g, inFx) {
            for (var i = 1; i <= g.numProperties; i++) {
                var p = g.property(i);
                if (!p) continue;
                if (p.propertyType === PropertyType.PROPERTY) {
                    var n = 0;
                    try { n = (p.matchName !== "ADBE Marker") ? p.numKeys : 0; } catch (eK) {}
                    if (n > 0) info.keyed++;
                    try {
                        if (p.canSetExpression && p.expression && p.expressionEnabled) {
                            info.expressions++;
                            var re = /comp\(\s*"([^"]+)"\s*\)/g, m;
                            while ((m = re.exec(p.expression))) if (!compsIn[m[1]] && !info.extSeen[m[1]]) { info.extSeen[m[1]] = 1; info.external.push(m[1]); }
                        }
                    } catch (eX) {}
                } else {
                    if (g.matchName === "ADBE Effect Parade") {
                        var mn = p.matchName;
                        if (!info.fxSeen[mn]) { info.fxSeen[mn] = 1; info.effects.push({ mn: mn, name: p.name, adobe: /^ADBE /.test(mn) || /^CC /.test(mn) || /^APC /.test(mn) }); }
                    }
                    walk(p, inFx || g.matchName === "ADBE Effect Parade");
                }
            }
        })(L, false);
        if (k === "precomp" && depth < MAX_DEPTH) {
            compsIn[L.source.name] = 1;
            for (var j = 1; j <= L.source.numLayers; j++) scanLayer(L.source.layer(j), info, depth + 1, compsIn);
        }
    }

    /** Text layers directly in a comp (caption words go into those; deeper ones keep their own text). */
    function topText(comp) {
        var n = 0;
        for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i) instanceof TextLayer) n++;
        return n;
    }

    /** The looks the selection makes: [{ kind: "precomp" | "layers", layers: [Layer], name }], ignored: [names],
     *  deep: [names of precomps whose text is only in precomps nested deeper]. */
    function looksOf(sel) {
        var looks = [], loose = [], deep = [], i, anyText = false;
        for (i = 0; i < sel.length; i++) {
            var L = sel[i];
            if (isComp(L) && topText(L.source) > 0) looks.push({ kind: "precomp", layers: [L], name: L.source.name });
            else if (isComp(L) && textCount(L.source, 1) > 0) deep.push(L.source.name);
            else { loose.push(L); if (L instanceof TextLayer) anyText = true; }
        }
        var ignored = [];
        if (loose.length && anyText) {
            var name = null;
            for (i = 0; i < loose.length && !name; i++) if (loose[i] instanceof TextLayer) name = loose[i].name;
            loose.sort(function (a, b) { return a.index - b.index; });
            looks.push({ kind: "layers", layers: loose, name: name || "Look" });
        } else for (i = 0; i < loose.length; i++) ignored.push(loose[i].name);
        return { looks: looks, ignored: ignored, deep: deep };
    }

    function check() {
        try {
            var comp = activeComp();
            if (!comp) return R(false, "Open the comp with your text animation and select its layer(s) or precomp(s).");
            var sel = comp.selectedLayers;
            if (!sel.length) return R(false, "Select the text layer (or the layers / precomps) of your animation in \"" + comp.name + "\" first.");
            var lk = looksOf(sel), out = [], i, j;
            if (!lk.looks.length) return R(false, lk.deep.length ?
                "The text of " + lk.deep.join(", ") + " is inside a precomp nested deeper: caption words go into text layers directly inside the selected precomp. Select that inner precomp instead." :
                "No text layer in the selection: a caption style needs at least one text layer for the caption words (" + lk.ignored.join(", ") + ").", { ignored: lk.ignored, deep: lk.deep });
            for (i = 0; i < lk.looks.length; i++) {
                var look = lk.looks[i];
                var info = { name: look.name, kind: look.kind, layers: 0, texts: 0, keyed: 0, expressions: 0, effects: [], fonts: [], samples: [],
                    sourceTextKeys: 0, footage: [], external: [], fontSeen: {}, fxSeen: {}, extSeen: {}, notes: [] };
                var compsIn = {}, t0 = 1e9, t1 = -1e9;
                for (j = 0; j < look.layers.length; j++) {
                    scanLayer(look.layers[j], info, 1, compsIn);
                    t0 = Math.min(t0, look.layers[j].inPoint); t1 = Math.max(t1, look.layers[j].outPoint);
                }
                info.dur = Math.round((t1 - t0) * 100) / 100;
                if (look.kind === "precomp") info.layers--;          // the precomp layer itself
                if (!info.keyed) info.notes.push("nothing is animated (no keyframes) - the captions will just appear and disappear");
                if (info.sourceTextKeys) info.notes.push("Source Text keyframes are replaced by the caption words");
                if (info.external.length) info.notes.push("expressions read comps outside the look (" + info.external.join(", ") + ") - those parts may not work");
                if (info.footage.length) info.notes.push("footage (" + info.footage.join(", ") + ") is linked by its file: keep the files where they are");
                delete info.fontSeen; delete info.fxSeen; delete info.extSeen;
                out.push(info);
            }
            return R(true, "ok", { comp: comp.name, w: comp.width, h: comp.height, fps: comp.frameRate, looks: out, ignored: lk.ignored, deep: lk.deep });
        } catch (e) { return R(false, "Checking the layers failed: " + e.toString() + (e.line ? " (line " + e.line + ")" : "")); }
    }

    function capture(json) {
        var a = parse(json);
        try {
            var comp = activeComp();
            if (!comp) return R(false, "Open the comp with your text animation first.");
            var sel = comp.selectedLayers;
            if (!sel.length) return R(false, "Select the layer(s) or precomp(s) of your animation first.");
            var lk = looksOf(sel), recs = [], i, j;
            if (!lk.looks.length) return R(false, "No text layer in the selection.");
            var t0 = new Date().getTime();
            for (i = 0; i < lk.looks.length; i++) {
                var look = lk.looks[i];
                var rec = $._cfxSuite.recipe.serializeLayers(comp, look.layers, BAKE);
                // the selected layers are the style even when their eye is off in this comp (layers inside a precomp
                // keep their own switches)
                for (j = 0; j < rec.layers.length; j++) rec.layers[j].enabled = true;
                if (look.kind === "layers") {
                    // loose layers: a comp of their own (this comp's size), its layers from time 0
                    var span = 0, id = "look_" + (i + 1);
                    for (j = 0; j < rec.layers.length; j++) span = Math.max(span, rec.layers[j].outPoint);
                    span = Math.max(comp.frameDuration * 6, span);
                    rec.comps[id] = { name: look.name, w: comp.width, h: comp.height, pa: comp.pixelAspect, fps: comp.frameRate, dur: span,
                        bg: comp.bgColor, ws: 0, wd: span, displayStart: 0, motionBlur: comp.motionBlur, frameBlending: comp.frameBlending,
                        shutterAngle: comp.shutterAngle, shutterPhase: comp.shutterPhase, layers: rec.layers };
                    rec.layers = [{ name: look.name, kind: "precomp", source: { comp: id }, startTime: 0, inPoint: 0, outPoint: span, stretch: 100,
                        enabled: true, label: 0, shy: false, locked: false, collapse: false, motionBlur: false, props: { c: [] } }];
                    rec.span = [0, span];
                } else {
                    rec.span = [look.layers[0].inPoint, look.layers[0].outPoint];
                }
                rec.style = look.name;
                rec.lookKind = look.kind;
                recs.push(rec);
            }
            var f = new File(a.out);
            f.encoding = "UTF-8";
            if (!f.open("w")) return R(false, "Cannot write " + f.fsName);
            f.write(JSON.stringify({ version: 1, ae: app.version, comp: comp.name, project: app.project.file ? app.project.file.name : "Untitled",
                w: comp.width, h: comp.height, fps: comp.frameRate, looks: recs }));
            f.close();
            return R(true, "Captured " + recs.length + " look" + (recs.length === 1 ? "" : "s") + ".", { looks: recs.length, ms: new Date().getTime() - t0, path: f.fsName });
        } catch (e) { return R(false, "Capturing the layers failed: " + e.toString() + (e.line ? " (line " + e.line + ")" : "")); }
    }

    return { check: check, capture: capture };
})();
