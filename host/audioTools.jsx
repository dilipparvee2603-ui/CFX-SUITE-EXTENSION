/**
 * Dala Suite - Audio tools, host side (ExtendScript, ECMAScript 3). The analysis runs in whisper/dala_audio.py.
 *   selection()      the selected layer with audio: its source file when it plays one file straight (no time
 *                    remapping / stretch), otherwise the span to render (precomps, remapped clips)
 *   beatSource(json) what Beat Marker analyses: the selected layer, or the whole comp ("comp"), over the work area
 *   addBeats(json)   markers at the beat / drum-hit times (comp seconds) on that layer, or on the composition's
 *                    own timeline (target "comp"); markers Dala added there before are replaced, so running it
 *                    again never doubles them
 *   clearBeats(json) removes only the beat markers Dala added
 *   importDrums(json) the extracted drums as a (muted) layer, lined up with the audio
 *   importStems(json) imports the separated stems into "Dala Audio" and lines them up with the original layer
 */

$._dalaSuite.audio = (function () {
    var TAG = "dala-beat";
    function R(ok, msg, data) { return $._dalaSuite.formatResult(ok, msg, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : (json || {}); }
    function comp() { var c = app.project.activeItem; return (c && c instanceof CompItem) ? c : null; }

    function hasAudio(L) { try { return L.hasAudio && L.audioActive !== undefined; } catch (e) { return false; } }
    var DRUMS_TAG = "Dala Beat Marker drums: ";
    function isDrumsTrack(L) { try { return String(L.comment).indexOf(DRUMS_TAG) === 0; } catch (e) { return false; } }

    function selection() {
        var s = selected();
        return s.error ? R(false, s.error) : R(true, "ok", s);
    }

    /** the one selected layer with audio: an object, or { error } */
    function selected() {
        var c = comp();
        if (!c) return { error: "Open the composition with the audio, then select the audio layer." };
        var sel = c.selectedLayers, picks = [], drumsOnly = false, i;
        for (i = 0; i < sel.length; i++) {
            if (!hasAudio(sel[i])) continue;
            if (isDrumsTrack(sel[i])) { drumsOnly = true; continue; }    // Beat Marker's own drums track
            picks.push(sel[i]);
        }
        if (!picks.length && drumsOnly) return { error: "That is the drums track Beat Marker added. Select the song (or the clip / precomp with the music) instead." };
        if (!picks.length) return { error: sel.length ? "The selected layer has no audio. Select a song, a clip with sound or a precomp with audio." : "Select the audio layer first (a song, a clip with sound or a precomp)." };
        if (picks.length > 1) return { error: "Select just one audio layer." };
        var L = picks[0], file = null, direct = false;
        try {
            if (L.source && L.source instanceof FootageItem && L.source.mainSource.file && !L.timeRemapEnabled && Math.abs(L.stretch - 100) < 0.001) {
                file = L.source.mainSource.file.fsName;
                direct = new File(file).exists;
            }
        } catch (e) {}
        return { compId: c.id, compName: c.name, index: L.index, name: L.name, file: direct ? file : null,
            startTime: L.startTime, inPoint: L.inPoint, outPoint: L.outPoint, fps: c.frameRate, sourceName: L.source ? L.source.name : L.name };
    }

    /** What Beat Marker analyses. target "layer": the selected audio layer, over the part of it inside the work
     *  area; "comp": everything audible in the comp's work area. Times in comp seconds; fileStart / fileEnd are
     *  the same span in the layer's own file when it plays one file straight (no render needed). */
    function beatSource(json) {
        var a = parse(json), c = comp();
        if (!c) return R(false, "Open the composition with the audio first.");
        var ws = c.workAreaStart, we = c.workAreaStart + c.workAreaDuration;
        if (a.target === "comp") {
            var any = false;
            for (var i = 1; i <= c.numLayers; i++) {
                var Lc = c.layer(i);
                if (hasAudio(Lc) && Lc.audioEnabled && Lc.outPoint > ws && Lc.inPoint < we) { any = true; break; }
            }
            if (!any) return R(false, "Nothing in this comp's work area has audio switched on. Add the song (or switch its audio on) and try again.");
            return R(true, "ok", { target: "comp", compId: c.id, compName: c.name, spanStart: ws, spanEnd: we, file: null, fps: c.frameRate });
        }
        var o = selected();
        if (o.error) return R(false, o.error);
        var st = Math.max(o.inPoint, ws), en = Math.min(o.outPoint, we);
        if (en - st < 1) return R(false, "Less than a second of \"" + o.name + "\" is inside the work area. Move the work area over the part to mark (or press N / B to set it).");
        o.target = "layer";
        o.spanStart = st;
        o.spanEnd = en;
        if (o.file) { o.fileStart = st - o.startTime; o.fileEnd = en - o.startTime; }
        return R(true, "ok", o);
    }

    function findLayer(a) {
        var c = comp();
        if (!c || (a.compId && c.id !== a.compId)) {
            for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.id === a.compId) { c = it; break; } }
        }
        if (!c) return null;
        var L = null;
        try { L = c.layer(a.index); } catch (e) { L = null; }
        if (!L || (a.name && L.name !== a.name)) {
            for (var j = 1; j <= c.numLayers; j++) if (c.layer(j).name === a.name) { L = c.layer(j); break; }
        }
        return L ? { comp: c, layer: L } : null;
    }

    function removeOurs(mk) {
        var n = 0;
        for (var k = mk.numKeys; k >= 1; k--) {
            var mv = mk.keyValue(k), p = null;
            try { p = mv.getParameters(); } catch (e) { p = null; }
            if (p && p.dala === TAG) { mk.removeKey(k); n++; }
        }
        return n;
    }

    function findComp(id) {
        var c = comp();
        if (c && (!id || c.id === id)) return c;
        for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.id === id) return it; }
        return null;
    }

    /** where the markers go: { mk, comp, where, lo, hi } or { error }. Composition markers need After Effects 14+
     *  (CompItem.markerProperty) */
    function markerTarget(a) {
        if (a.target === "comp") {
            var c = findComp(a.compId);
            if (!c) return { error: "The composition is gone. Open it and try again." };
            var mk = null;
            try { mk = c.markerProperty; } catch (e) { mk = null; }
            if (!mk) return { error: "This version of After Effects cannot add composition markers from a script. Use Selected Layer instead." };
            return { mk: mk, comp: c, where: "the \"" + c.name + "\" timeline", lo: 0, hi: c.duration };
        }
        var f = findLayer(a);
        if (!f) return { error: "The audio layer is gone (deleted or renamed?). Select it again." };
        return { mk: f.layer.property("ADBE Marker"), comp: f.comp, where: "\"" + f.layer.name + "\"", lo: f.layer.inPoint, hi: f.layer.outPoint };
    }

    function addBeats(json) {
        var a = parse(json), tg = markerTarget(a);
        if (tg.error) return R(false, tg.error);
        var mk = tg.mk, c = tg.comp, kind = a.kind === "hit" ? "hit" : "beat";
        var times = a.times || [], every = Math.max(1, Number(a.every) || 1), phase = Number(a.phase) || 0, made = 0, i;
        var word = kind === "hit" ? "Hit" : (every >= 4 ? "Bar" : "Beat");
        app.beginUndoGroup("Dala Suite: Beat markers");
        try {
            var removed = removeOurs(mk);
            var lastT = -1, fd = c.frameDuration;
            for (i = 0; i < times.length; i++) {
                if (every > 1 && ((i - phase) % every + every) % every !== 0) continue;
                var t = Number(times[i]);
                if (t < tg.lo - 1e-6 || t > tg.hi + 1e-6) continue;
                if (lastT >= 0 && t - lastT < fd * 0.5) continue;           // never two on one frame
                var mv = new MarkerValue(word + " " + (made + 1));
                try { mv.setParameters({ dala: TAG, bpm: String(a.bpm || ""), kind: kind }); } catch (eP) {}
                try { mv.label = word === "Bar" ? 11 : (word === "Hit" ? 2 : 9); } catch (eL) {}
                mk.setValueAtTime(t, mv);
                lastT = t;
                made++;
            }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Adding the markers failed: " + e.toString());
        }
        app.endUndoGroup();
        var what = word.toLowerCase() + " marker" + (made === 1 ? "" : "s");
        return R(true, "Added " + made + " " + what + " on " + tg.where + " (" + (Math.round((a.bpm || 0) * 10) / 10) + " BPM)" +
            (removed ? ", replacing " + removed + " earlier ones." : "."), { made: made, removed: removed });
    }

    function clearBeats(json) {
        var a = parse(json);
        if (a.target !== "comp" && !a.compId) {                 // the panel sends only the target: use the selection
            var s = selected();
            if (s.error) return R(false, s.error);
            a.compId = s.compId; a.index = s.index; a.name = s.name;
        }
        var tg = markerTarget(a);
        if (tg.error) return R(false, tg.error);
        app.beginUndoGroup("Dala Suite: Remove beat markers");
        var n = removeOurs(tg.mk);
        app.endUndoGroup();
        return R(n > 0, n ? "Removed " + n + " beat marker" + (n === 1 ? "" : "s") + " from " + tg.where + "." : "There are no beat markers from Dala on " + tg.where + ".", { removed: n });
    }

    /** the extracted drums as a layer, like the drums track of the manual method: above the analysed layer (or at
     *  the top of the comp), lined up with the audio, its own audio off so the mix does not change. A drums layer
     *  Dala added earlier for the same source is replaced. */
    function importDrums(json) {
        var a = parse(json), c = findComp(a.compId);
        if (!c) return R(false, "The composition is gone.");
        var fl = new File(a.file);
        if (!fl.exists) return R(false, "The drums file is missing: " + a.file);
        var tag = DRUMS_TAG + (a.source || "");
        app.beginUndoGroup("Dala Suite: Drums track");
        try {
            var oldItems = [], i;
            for (i = c.numLayers; i >= 1; i--) {
                var Lo = c.layer(i);
                if (Lo.comment === tag) { if (Lo.source) oldItems.push(Lo.source); Lo.remove(); }
            }
            var folder = null;
            for (i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === "Dala Audio") folder = it; }
            if (!folder) folder = app.project.items.addFolder("Dala Audio");
            var item = app.project.importFile(new ImportOptions(fl));
            item.parentFolder = folder;
            for (i = 0; i < oldItems.length; i++) { try { if (oldItems[i] !== item && oldItems[i].usedIn.length === 0) oldItems[i].remove(); } catch (eR) {} }
            var keepSel = c.selectedLayers;                     // adding a layer selects it: give the selection back
            var D = c.layers.add(item);
            var f = a.target === "comp" ? null : findLayer(a);
            if (f && f.comp === c) D.moveBefore(f.layer); else D.moveToBeginning();
            D.startTime = Number(a.at);
            D.name = (a.source || "audio").replace(/\.[^.]+$/, "") + " [drums]";
            D.comment = tag;
            try { D.audioEnabled = false; } catch (eA) {}
            try { D.label = 2; } catch (eL) {}
            D.selected = false;
            for (i = 0; i < keepSel.length; i++) { try { if (keepSel[i] !== D) keepSel[i].selected = true; } catch (eS) {} }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Adding the drums track failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(true, "Added the drums track \"" + D.name + "\" (its audio is off: switch it on, and the song off, to hear the drums alone).", { layer: D.name });
    }

    function importStems(json) {
        var a = parse(json), f = findLayer(a);
        var files = a.files || [], i, made = [];
        app.beginUndoGroup("Dala Suite: Import stems");
        try {
            var folder = null;
            for (i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === "Dala Audio") folder = it; }
            if (!folder) folder = app.project.items.addFolder("Dala Audio");
            var items = [];
            for (i = 0; i < files.length; i++) {
                var fl = new File(files[i]);
                if (!fl.exists) throw new Error("The stem file is missing: " + files[i]);
                var item = app.project.importFile(new ImportOptions(fl));
                item.parentFolder = folder;
                items.push(item);
            }
            if (a.addToComp && f) {
                var c = f.comp, L = f.layer;
                for (i = items.length - 1; i >= 0; i--) {
                    var S = c.layers.add(items[i]);
                    S.moveBefore(L);
                    S.startTime = Number(a.at);
                    try { S.inPoint = Math.max(S.inPoint, L.inPoint); S.outPoint = Math.min(S.outPoint, L.outPoint); } catch (eIO) {}
                    S.comment = "Dala Vocal Remover (" + (a.model || "") + ")";
                    made.push(S.name);
                }
                if (a.mute) { try { L.audioEnabled = false; } catch (eM) {} }
            }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Importing the stems failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(true, made.length ? "Added " + made.join(" and ") + " to the comp." : "Imported the stems into the Dala Audio folder.", { layers: made });
    }

    return { selection: selection, beatSource: beatSource, addBeats: addBeats, clearBeats: clearBeats, importDrums: importDrums, importStems: importStems };
})();
