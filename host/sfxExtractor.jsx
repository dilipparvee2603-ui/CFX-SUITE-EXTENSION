/**
 * Dala Suite - SFX Extractor, host side (ExtendScript, ECMAScript 3). FFmpeg does the extraction (client/js/audio/sfxUI.js).
 *   source(json)        the selected movie / clip layer: its file (the panel reads the file's channel layout) and the
 *                       stretch of the file the layer plays - the whole layer as it sits in the comp (range "layer")
 *                       or only its part inside the work area ("work") - as file times (offset, length). Stretched
 *                       and time-remapped layers are followed; a reversed layer takes the whole file.
 *   importCentre(json)  the extracted Centre channel (mono WAV starting at file time `offset`) as a new audio layer
 *                       right above the original, timed exactly like it: same start, stretch and time remapping
 *                       (keys copied, values shifted by the offset), in and out points equal to the span. The
 *                       original layer is not changed. A centre layer Dala made for the same layer before is replaced.
 */

$._dalaSuite.sfx = (function () {
    var TAG = "Dala SFX Extractor: ";
    function R(ok, msg, data) { return $._dalaSuite.formatResult(ok, msg, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : (json || {}); }
    function comp() { var c = app.project.activeItem; return (c && c instanceof CompItem) ? c : null; }
    function hasAudio(L) { try { return L.hasAudio && L.audioActive !== undefined; } catch (e) { return false; } }
    function comment(L) { try { return String(L.comment); } catch (e) { return ""; } }
    function layerId(L) { try { return L.id; } catch (e) { return null; } }        // Layer.id: After Effects 22+

    function findComp(id) {
        var c = comp();
        if (c && (!id || c.id === id)) return c;
        for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.id === id) return it; }
        return null;
    }
    function findLayer(a) {
        var c = findComp(a.compId), i;
        if (!c) return null;
        if (a.layerId !== null && a.layerId !== undefined) {
            for (i = 1; i <= c.numLayers; i++) if (layerId(c.layer(i)) === a.layerId) return { comp: c, layer: c.layer(i) };
        }
        var L = null;
        try { L = c.layer(a.index); } catch (e) { L = null; }
        if (!L || (a.name && L.name !== a.name)) {
            L = null;
            for (i = 1; i <= c.numLayers; i++) if (c.layer(i).name === a.name) { L = c.layer(i); break; }
        }
        return L ? { comp: c, layer: L } : null;
    }
    function folder(name) {
        for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === name) return it; }
        return app.project.items.addFolder(name);
    }

    /** file time the layer plays at comp time t */
    function fileTime(L, t) {
        if (L.timeRemapEnabled) return L.timeRemap.valueAtTime(t, false);
        return (t - L.startTime) * 100 / L.stretch;
    }

    function source(json) {
        var a = parse(json), c = comp(), i;
        if (!c) return R(false, "Open the composition with the movie clip, then select the clip.");
        // any layer playing a media file counts, also when After Effects hears no sound in it: it cannot decode some
        // 5.1 tracks (Dolby Digital in MKV, for one) that FFmpeg reads fine - the file's own layout decides, in the panel
        var sel = c.selectedLayers, picks = [], others = [];
        for (i = 0; i < sel.length; i++) {
            if (comment(sel[i]).indexOf(TAG) === 0) continue;
            var so = null;
            try { so = sel[i].source; } catch (eS) { so = null; }
            if (so instanceof FootageItem && so.mainSource instanceof FileSource && so.mainSource.file && !so.mainSource.isStill) picks.push(sel[i]);
            else others.push(sel[i]);
        }
        if (!picks.length) {
            for (i = 0; i < sel.length; i++) if (comment(sel[i]).indexOf(TAG) === 0) return R(false, "That is a Centre layer Dala Suite made. Select the original movie clip instead.");
            if (others.length) {
                var o0 = others[0];
                return R(false, (o0.source instanceof CompItem) ? "\"" + o0.name + "\" is a precomp: inside After Effects its sound is already mixed down, so the 5.1 channels are gone. Select the movie clip itself (open the precomp and select it there)."
                    : "\"" + o0.name + "\" is not a video or audio file. Select the movie clip (a file with 5.1 sound).");
            }
            return R(false, "Select the movie clip first (a video or audio file with 5.1 sound).");
        }
        if (picks.length > 1) return R(false, "Select just one movie clip.");
        var L = picks[0], src = L.source;
        var f = src.mainSource.file;
        if (!f.exists) return R(false, "The file of \"" + L.name + "\" is missing (" + f.fsName + "). Relink it in After Effects first.");
        var lo = Math.max(L.inPoint, 0), hi = Math.min(L.outPoint, c.duration);
        if (a.range === "work") { lo = Math.max(lo, c.workAreaStart); hi = Math.min(hi, c.workAreaStart + c.workAreaDuration); }
        if (hi - lo < c.frameDuration) {
            return R(false, a.range === "work" ? "\"" + L.name + "\" is not inside the work area. Move the work area over the clip (or choose Whole layer)."
                : "\"" + L.name + "\" is not inside the composition.");
        }
        var dur = src.duration, s0, s1, whole = false;
        if (!L.timeRemapEnabled && L.stretch < 0) {
            whole = true;                                     // a reversed layer: the whole file, timed like the layer
        } else if (L.timeRemapEnabled) {
            // the file times the remapped layer reaches between lo and hi (every frame, plus both ends)
            s0 = Infinity; s1 = -Infinity;
            var n = Math.ceil((hi - lo) / c.frameDuration);
            for (i = 0; i <= n; i++) {
                var v = fileTime(L, Math.min(hi, lo + i * c.frameDuration));
                if (v < s0) s0 = v;
                if (v > s1) s1 = v;
            }
            s1 += c.frameDuration * 2;                        // a little past the last frame reached
        } else {
            s0 = fileTime(L, lo); s1 = fileTime(L, hi);
        }
        if (whole) { s0 = 0; s1 = dur; }
        s0 = Math.max(0, s0);
        s1 = Math.min(dur, s1);
        if (s1 - s0 < 0.02) return R(false, "\"" + L.name + "\" plays less than a frame of its file here.");
        return R(true, "ok", { compId: c.id, compName: c.name, layerId: layerId(L), index: L.index, name: L.name, sourceName: src.name,
            file: f.fsName, fileDuration: dur, offset: s0, length: s1 - s0, spanStart: lo, spanEnd: hi, whole: whole,
            stretch: L.stretch, remapped: L.timeRemapEnabled, fps: c.frameRate, aeAudio: hasAudio(L) });
    }

    /** copies the original's Time Remap keys (values shifted by -offset) onto N */
    function copyRemap(L, N, offset) {
        var P = L.timeRemap, Q, k, j, times = [];
        N.timeRemapEnabled = true;
        Q = N.timeRemap;
        // the new keys go in first and only then are After Effects' default keys removed: with no keys left the
        // property is hidden and refuses new ones ("the property or a parent property is hidden")
        if (P.numKeys === 0) { Q.setValueAtTime(L.inPoint, P.value - offset); times.push(L.inPoint); }
        for (k = 1; k <= P.numKeys; k++) { Q.setValueAtTime(P.keyTime(k), P.keyValue(k) - offset); times.push(P.keyTime(k)); }
        for (k = Q.numKeys; k >= 1; k--) {
            var keep = false, tk = Q.keyTime(k);
            for (j = 0; j < times.length; j++) if (Math.abs(times[j] - tk) < 1e-6) keep = true;
            if (!keep) Q.removeKey(k);
        }
        for (k = 1; k <= P.numKeys; k++) {
            try { Q.setInterpolationTypeAtKey(k, P.keyInInterpolationType(k), P.keyOutInterpolationType(k)); } catch (e1) {}
            try { Q.setTemporalEaseAtKey(k, P.keyInTemporalEase(k), P.keyOutTemporalEase(k)); } catch (e2) {}
            try { Q.setTemporalContinuousAtKey(k, P.keyTemporalContinuous(k)); } catch (e3) {}
            try { Q.setTemporalAutoBezierAtKey(k, P.keyTemporalAutoBezier(k)); } catch (e4) {}
        }
        try {
            if (P.expressionEnabled && P.expression) Q.expression = "(function(){ return (" + P.expression + "\n); })() - " + offset;
        } catch (e5) {}
    }

    /** a: { compId, layerId, index, name, sourceName, file, offset, spanStart, spanEnd, layout, whole } */
    function importCentre(json) {
        var a = parse(json), f = findLayer(a), i;
        if (!f) return R(false, "The movie clip layer is gone (deleted or renamed?). Select it again and extract again.");
        var c = f.comp, L = f.layer;
        var wav = new File(a.file);
        if (!wav.exists) return R(false, "The extracted Centre file is missing: " + a.file);
        var keepSel = c.selectedLayers, tag = TAG + "Centre of \"" + L.name + "\"", removed = 0, N = null;
        app.beginUndoGroup("Dala Suite: SFX Extractor");
        try {
            var oldItems = [];
            for (i = c.numLayers; i >= 1; i--) {
                var Lo = c.layer(i);
                if (Lo !== L && comment(Lo) === tag) { if (Lo.source) oldItems.push(Lo.source); Lo.remove(); removed++; }
            }
            var item = app.project.importFile(new ImportOptions(wav));
            item.parentFolder = folder("Dala SFX");
            N = c.layers.add(item);
            N.moveBefore(L);
            var off = Number(a.offset) || 0;
            if (L.timeRemapEnabled) {
                N.startTime = L.startTime;
                N.stretch = L.stretch;
                copyRemap(L, N, off);
            } else {
                N.stretch = L.stretch;
                N.startTime = L.startTime + off * L.stretch / 100;
            }
            N.inPoint = Number(a.spanStart);
            N.outPoint = Number(a.spanEnd);
            N.name = String(L.name).replace(/\.[^.]+$/, "") + " [Centre]";
            N.comment = tag;
            try { N.label = 14; } catch (eL) {}                // cyan
            try { N.audioEnabled = true; } catch (eA) {}
            N.selected = false;
            for (i = 0; i < oldItems.length; i++) { try { if (oldItems[i].usedIn.length === 0) oldItems[i].remove(); } catch (eR) {} }
            for (i = 0; i < keepSel.length; i++) { try { keepSel[i].selected = true; } catch (eS) {} }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Adding the Centre layer failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(true, "Added \"" + N.name + "\" above \"" + L.name + "\": the movie's Centre channel only (" + (a.layout || "5.1") + "), lined up with the clip" +
            (removed ? ", replacing the one from before" : "") + ". The original clip is unchanged" + (a.aeAudio === false ? "." : " - switch its audio off to hear the Centre alone."),
            { layer: N.name, inPoint: N.inPoint, outPoint: N.outPoint, startTime: N.startTime, removed: removed });
    }

    return { source: source, importCentre: importCentre };
})();
