/**
 * Dala Suite - Music Stems, host side (ExtendScript, ECMAScript 3). The separation runs in whisper/dala_stems.py.
 *   source(json)       the selected layer with audio and the span to split: the whole layer as it sits in the comp
 *                      (range "layer") or only its part inside the work area ("work"); the layer's own file when it
 *                      plays one file straight (fileStart / fileEnd in file time), otherwise the panel renders it
 *   importStems(json)  the five stems (Drums, Bass, Guitar, Piano, Other) as audio layers right above the original,
 *                      each starting where the split span starts, in and out points equal to that span; stems Dala
 *                      added for the same layer earlier are replaced; the original is muted only when asked
 *   pickModel()        a file dialog for a copy of the 6-stem model already on this PC
 */

$._dalaSuite.stems = (function () {
    var TAG = "Dala Music Stems: ";
    var LABELS = { drums: 1, bass: 8, guitar: 11, piano: 10, other: 9 };     // red, blue, orange, purple, green
    function R(ok, msg, data) { return $._dalaSuite.formatResult(ok, msg, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : (json || {}); }
    function comp() { var c = app.project.activeItem; return (c && c instanceof CompItem) ? c : null; }
    function hasAudio(L) { try { return L.hasAudio && L.audioActive !== undefined; } catch (e) { return false; } }
    function isOurs(L) {
        try { var c = String(L.comment); return c.indexOf(TAG) === 0 || c.indexOf("Dala SFX Extractor: ") === 0 || c.indexOf("Dala Beat Marker drums: ") === 0; } catch (e) { return false; }
    }
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

    /** the one selected layer with audio (Dala's own stems / centre / drums layers are skipped) */
    function picked(c) {
        var sel = c.selectedLayers, picks = [], ours = false, i;
        for (i = 0; i < sel.length; i++) {
            if (!hasAudio(sel[i])) continue;
            if (isOurs(sel[i])) { ours = true; continue; }
            picks.push(sel[i]);
        }
        if (!picks.length && ours) return { error: "That layer was made by Dala Suite. Select the original song (or the clip / precomp with the music) instead." };
        if (!picks.length) return { error: sel.length ? "The selected layer has no audio. Select a song, a clip with sound or a precomp with audio." : "Select the song layer first (an audio file, a clip with sound or a precomp)." };
        if (picks.length > 1) return { error: "Select just one audio layer." };
        return { layer: picks[0] };
    }

    function source(json) {
        var a = parse(json), c = comp();
        if (!c) return R(false, "Open the composition with the song, then select the song layer.");
        var p = picked(c);
        if (p.error) return R(false, p.error);
        var L = p.layer;
        // the part of the layer that can be heard: inside the comp (and inside the work area for range "work")
        var lo = Math.max(L.inPoint, 0), hi = Math.min(L.outPoint, c.duration);
        if (a.range === "work") { lo = Math.max(lo, c.workAreaStart); hi = Math.min(hi, c.workAreaStart + c.workAreaDuration); }
        if (hi - lo < 0.5) {
            return R(false, a.range === "work" ? "Less than half a second of \"" + L.name + "\" is inside the work area. Move the work area over the song (or choose Whole layer)."
                : "Less than half a second of \"" + L.name + "\" is inside the composition.");
        }
        var file = null;
        try {
            if (L.source && L.source instanceof FootageItem && L.source.mainSource instanceof FileSource && L.source.mainSource.file &&
                !L.timeRemapEnabled && Math.abs(L.stretch - 100) < 0.001 && L.source.mainSource.file.exists) file = L.source.mainSource.file.fsName;
        } catch (e) { file = null; }
        var o = { compId: c.id, compName: c.name, layerId: layerId(L), index: L.index, name: L.name, sourceName: L.source ? L.source.name : L.name,
            file: file, startTime: L.startTime, inPoint: L.inPoint, outPoint: L.outPoint, spanStart: lo, spanEnd: hi, fps: c.frameRate,
            sourceDuration: L.source ? L.source.duration : 0 };
        if (file) { o.fileStart = lo - L.startTime; o.fileEnd = hi - L.startTime; }
        return R(true, "ok", o);
    }

    /** a: { compId, layerId, index, name, sourceName, files: [{ key, title, path }], at, spanStart, spanEnd, mute } */
    function importStems(json) {
        var a = parse(json), f = findLayer(a), i;
        if (!f) return R(false, "The song layer is gone (deleted or renamed?). Select it again and extract the stems again.");
        var c = f.comp, L = f.layer, files = a.files || [], made = [], removed = 0;
        for (i = 0; i < files.length; i++) if (!new File(files[i].path).exists) return R(false, "The stem file is missing: " + files[i].path);
        var keepSel = c.selectedLayers;
        var tagBase = TAG + "%s of \"" + L.name + "\"";
        app.beginUndoGroup("Dala Suite: Music stems");
        try {
            // stems Dala added for this layer before are replaced (their project items too, when nothing else uses them)
            var oldItems = [];
            for (i = c.numLayers; i >= 1; i--) {
                var Lo = c.layer(i), cm = "";
                try { cm = String(Lo.comment); } catch (eC) { cm = ""; }
                if (cm.indexOf(TAG) === 0 && cm.indexOf(" of \"" + L.name + "\"") > 0 && Lo !== L) {
                    if (Lo.source) oldItems.push(Lo.source);
                    Lo.remove();
                    removed++;
                }
            }
            var fold = folder("Dala Music Stems");
            for (i = 0; i < files.length; i++) {
                var item = app.project.importFile(new ImportOptions(new File(files[i].path)));
                item.parentFolder = fold;
                var S = c.layers.add(item);
                S.moveBefore(L);                                  // Drums lands right above the song, then Bass below it...
                S.startTime = Number(a.at);
                S.inPoint = Math.max(Number(a.spanStart), S.inPoint);
                S.outPoint = Math.min(Number(a.spanEnd), S.outPoint);
                S.name = String(a.sourceName || L.name).replace(/\.[^.]+$/, "") + " [" + files[i].title + "]";
                S.comment = tagBase.replace("%s", files[i].title);
                try { S.label = LABELS[files[i].key] || 9; } catch (eL) {}
                try { S.audioEnabled = true; } catch (eA) {}
                S.selected = false;
                made.push(files[i].title);
            }
            for (i = 0; i < oldItems.length; i++) { try { if (oldItems[i].usedIn.length === 0) oldItems[i].remove(); } catch (eR) {} }
            if (a.mute) { try { L.audioEnabled = false; } catch (eM) {} }
            for (i = 0; i < keepSel.length; i++) { try { keepSel[i].selected = true; } catch (eS) {} }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Adding the stems failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(true, "Added " + made.length + " stem layers above \"" + L.name + "\" (" + made.join(", ") + ")" + (removed ? ", replacing the " + removed + " from before" : "") + ".",
            { layers: made, removed: removed });
    }

    function pickModel() {
        var f = File.openDialog("Choose htdemucs_6s_fp16weights.onnx (the 6-stem model)", "ONNX model:*.onnx", false);
        if (!f) return R(false, "cancelled");
        return R(true, "ok", { path: f.fsName });
    }

    return { source: source, importStems: importStems, pickModel: pickModel };
})();
