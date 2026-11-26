/**
 * Dala Suite - Auto Tracker (ExtendScript host side, ECMAScript 3)
 *
 * Workflow (driven by client/js/tracker/autoTrackerUI.js):
 *   prepare()       validate the selected layers and map every comp frame of each layer to
 *                   the source time it shows (stretch, time remap and reversed layers included)
 *   renderFrames()  render analysis frames with After Effects itself (CompItem.saveFrameToPng on a
 *                   temporary comp holding the layer's source) - no Node.js / ffmpeg needed
 *   apply()         split at shot cuts (optional) and keyframe Position so the tracked face / point
 *                   stays centred; auto zoom + Motion Tile mirror edges hide exposed borders
 *   remove()        undo the tracking on selected layers (restores the original transform)
 *   cleanup()       delete temporary comps and frames (also used when the user cancels)
 */

$._dalaSuite.autoTracker = (function () {
    var TAG = "Dala Auto Tracker|";
    var TILE_NAME = "Dala Auto Tracker \u00B7 Motion Tile";
    var PRECOMP_TAG = "Dala Auto Tracker \u00B7 Cut to F";
    var TEMP_FOLDER_NAME = "Dala Auto Tracker (temp)";
    var session = null;

    function R(success, message, data) { return $._dalaSuite.formatResult(success, message, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : json; }

    function findItemById(id) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            try { if (it.id === id) return it; } catch (e) {}
        }
        return null;
    }

    /** Finds a prepared layer again: by index first (verified by name, source and in-point),
     *  then anywhere in the comp in case layers were reordered while the user was picking. */
    function resolveLayer(comp, info) {
        function same(L) {
            try {
                return L.name === info.name && L.source && L.source.id === info.sourceId &&
                    Math.abs(Math.min(L.inPoint, L.outPoint) - info.inP) < 1e-4;
            } catch (e) { return false; }
        }
        if (info.index >= 1 && info.index <= comp.numLayers && same(comp.layer(info.index))) return comp.layer(info.index);
        for (var i = 1; i <= comp.numLayers; i++) if (same(comp.layer(i))) return comp.layer(i);
        return null;
    }

    function sessionComp() {
        if (!session) throw new Error("No tracking session. Click Start tracking again.");
        var comp = findItemById(session.compId);
        if (!comp || !(comp instanceof CompItem)) throw new Error("The composition used for tracking is gone.");
        return comp;
    }

    function sourceTimeAt(layer, ct) {
        if (layer.timeRemapEnabled) {
            return layer.property("ADBE Time Remapping").valueAtTime(ct, false);
        }
        var st = (typeof layer.stretch === "number" && layer.stretch !== 0) ? layer.stretch / 100 : 1;
        return (ct - layer.startTime) / st;
    }

    function canSaveFrames() {
        var ok = false;
        app.beginUndoGroup("Dala Auto Tracker: check");
        try {
            var probe = app.project.items.addComp("dala probe", 4, 4, 1, 1, 24);
            ok = (typeof probe.saveFrameToPng === "function");
            probe.remove();
        } catch (e) { ok = false; }
        app.endUndoGroup();
        return ok;
    }

    function fileWritesAllowed() {
        try {
            return app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1;
        } catch (e) { return true; }   // older versions: no such pref, writes allowed
    }

    function removeTempItems() {
        if (!session) return;
        var ids = session.tempIds || [];
        for (var i = 0; i < ids.length; i++) {
            try { var it = findItemById(ids[i]); if (it) it.remove(); } catch (e) {}
        }
        try {
            var f = session.tempFolderId ? findItemById(session.tempFolderId) : null;
            if (f && f.numItems === 0) f.remove();
        } catch (e2) {}
        session.tempIds = [];
        session.tempComps = {};
    }

    function deleteFramesFolder() {
        if (!session || !session.framesPath) return;
        // let renders that are still in flight finish first (deleting under them makes AE complain)
        var inFlight = [];
        for (var p in session.requested) if (session.requested.hasOwnProperty(p)) inFlight.push(p);
        if (inFlight.length) waitForFiles(inFlight, 2000);
        try {
            var dir = new Folder(session.framesPath);
            if (dir.exists) {
                var files = dir.getFiles();
                for (var i = 0; i < files.length; i++) { try { files[i].remove(); } catch (e) {} }
                dir.remove();
            }
        } catch (e2) {}
    }

    // ------------------------------------------------------------------ prepare

    function prepare(optsJson) {
        $._dalaSuite.debug.clear();
        try {
            var opts = parse(optsJson || "{}");
            if (session) { try { cleanup(); } catch (eC) {} }
            var comp = app.project ? app.project.activeItem : null;
            if (!comp || !(comp instanceof CompItem)) {
                return R(false, "No active composition. Click the composition's timeline (keep your layers selected), then press Start tracking.");
            }
            var sel = comp.selectedLayers;
            if (!sel || sel.length === 0) return R(false, "Select one or more footage layers, then start tracking.");
            if (!fileWritesAllowed()) {
                return R(false, "Enable Edit > Preferences > Scripting & Expressions > \"Allow Scripts to Write Files and Access Network\" so After Effects can render the analysis frames.");
            }
            if (!canSaveFrames()) return R(false, "This version of After Effects cannot render analysis frames for scripts (CompItem.saveFrameToPng is missing).");

            var list = [];
            for (var s = 0; s < sel.length; s++) list.push(sel[s]);
            list.sort(function (a, b) { var d = a.inPoint - b.inPoint; return (d > 1e-6 || d < -1e-6) ? d : a.index - b.index; });

            var maxSide = opts.analysisSize || 640;
            var token = "t" + (new Date().getTime());
            var framesDir = new Folder(Folder.temp.fsName + "/DalaAutoTracker/" + token);
            if (!framesDir.exists && !framesDir.create()) return R(false, "Could not create the temporary folder " + framesDir.fsName);

            var fps = comp.frameRate, layers = [], skipped = [];
            for (var i = 0; i < list.length; i++) {
                var L = list[i], why = "";
                if (!(L instanceof AVLayer) || !L.source) why = "not a footage or comp layer";
                else if (L.source instanceof FootageItem && L.source.mainSource instanceof SolidSource) why = "solid";
                else if (L.source instanceof FootageItem && L.source.mainSource && L.source.mainSource.isStill) why = "still image";
                else if (!L.source.hasVideo) why = "no video";
                else if (L.parent) why = "parented (unparent it first)";
                if (why) { skipped.push({ name: L.name, why: why }); continue; }

                var src = L.source, par = src.pixelAspect || 1, compPar = comp.pixelAspect || 1;
                var srcW = src.width, srcH = src.height;
                var dispW = srcW * par, k = Math.min(1, maxSide / Math.max(dispW, srcH));
                var aw = Math.max(16, Math.round(dispW * k)), ah = Math.max(16, Math.round(srcH * k));

                var inP = Math.min(L.inPoint, L.outPoint), outP = Math.max(L.inPoint, L.outPoint);
                var f0 = Math.ceil(inP * fps - 1e-6), f1 = Math.ceil(outP * fps - 1e-6);   // frames [f0, f1)
                if (f0 < 0) f0 = 0;
                var fEnd = Math.ceil(comp.duration * fps - 1e-6);
                if (f1 > fEnd) f1 = fEnd;
                if (f1 - f0 < 2) { skipped.push({ name: L.name, why: "shorter than 2 frames in the comp" }); continue; }

                var srcDur = src.duration || 0, times = [];
                for (var f = f0; f < f1; f++) {
                    var t = sourceTimeAt(L, f / fps);
                    if (srcDur > 0) { if (t < 0) t = 0; if (t > srcDur) t = srcDur; }
                    times.push(Math.round(t * 1e6) / 1e6);
                }
                var origComment = String(L.comment);
                if (origComment.indexOf("dala-at:") === 0) origComment = "";   // stale tag of a 2.0.2 pre-release
                layers.push({
                    key: layers.length, origComment: origComment, name: L.name, index: L.index, inP: inP,
                    f0: f0, f1: f1, times: times, srcW: srcW, srcH: srcH, par: par, compPar: compPar,
                    srcFps: (src.frameRate || fps), analysisW: aw, analysisH: ah,
                    kx: aw / srcW, ky: ah / srcH, sourceId: src.id,
                    retrack: String(origComment).indexOf(TAG) === 0
                });
            }

            if (layers.length === 0) {
                try { framesDir.remove(); } catch (eR) {}
                var msg = "No trackable layers selected.";
                if (skipped.length) msg += " Skipped: " + skipped[0].name + " (" + skipped[0].why + ")" + (skipped.length > 1 ? " and " + (skipped.length - 1) + " more." : ".");
                return R(false, msg, { skipped: skipped });
            }

            session = {
                token: token, compId: comp.id, framesPath: framesDir.fsName, layers: layers,
                tempComps: {}, tempIds: [], tempFolderId: 0, requested: {}
            };
            var out = [];
            for (var j = 0; j < layers.length; j++) {
                var Ly = layers[j];
                out.push({ key: Ly.key, name: Ly.name, f0: Ly.f0, f1: Ly.f1, times: Ly.times, srcW: Ly.srcW, srcH: Ly.srcH,
                           analysisW: Ly.analysisW, analysisH: Ly.analysisH, kx: Ly.kx, ky: Ly.ky, retrack: Ly.retrack });
            }
            return R(true, "Ready.", {
                token: token, framesPath: framesDir.fsName, compName: comp.name, compW: comp.width, compH: comp.height,
                fps: fps, layers: out, skipped: skipped, aeVersion: app.version
            });
        } catch (err) {
            return R(false, "Auto Tracker could not start: " + err.toString() + (err.line ? " (line " + err.line + ")" : ""));
        }
    }

    // ------------------------------------------------------------------ analysis frames

    function tempCompFor(layerInfo) {
        if (session.tempComps[layerInfo.key]) {
            var existing = findItemById(session.tempComps[layerInfo.key]);
            if (existing) return existing;
        }
        var src = findItemById(layerInfo.sourceId);
        if (!src) throw new Error("The source of layer \"" + layerInfo.name + "\" is no longer in the project.");
        var folder = session.tempFolderId ? findItemById(session.tempFolderId) : null;
        if (!folder) {
            folder = app.project.items.addFolder(TEMP_FOLDER_NAME);
            session.tempFolderId = folder.id;
        }
        var dur = Math.max(src.duration || 0, 1 / layerInfo.srcFps) + 1;
        var tc = app.project.items.addComp("Dala AT analysis " + layerInfo.key, layerInfo.analysisW, layerInfo.analysisH, 1, dur, layerInfo.srcFps);
        tc.parentFolder = folder;
        tc.motionBlur = false; tc.frameBlending = false;
        var ly = tc.layers.add(src);
        ly.startTime = 0;
        try { ly.inPoint = 0; ly.outPoint = dur; } catch (e0) {}
        var tg = ly.property("ADBE Transform Group");
        tg.property("ADBE Anchor Point").setValue([layerInfo.srcW / 2, layerInfo.srcH / 2]);
        tg.property("ADBE Position").setValue([layerInfo.analysisW / 2, layerInfo.analysisH / 2]);
        tg.property("ADBE Scale").setValue([layerInfo.ky * 100, layerInfo.ky * 100]);
        session.tempComps[layerInfo.key] = tc.id;
        session.tempIds.push(tc.id);
        return tc;
    }

    /**
     * saveFrameToPng is asynchronous in recent After Effects (26.0: the call returns at once and
     * the PNG is written progressively 0.1-1.5 s later). Wait until every file exists and its
     * size has stopped changing, so the panel never reads (or locks) a file AE is still writing.
     * Rendering continues while the script sleeps. Synchronous versions return immediately here.
     */
    function waitForFiles(paths, timeoutMs) {
        var last = {}, stable = {}, start = new Date().getTime(), i;
        while (new Date().getTime() - start < timeoutMs) {
            var all = true;
            for (i = 0; i < paths.length; i++) {
                var g = new File(paths[i]), len = g.exists ? g.length : -1;
                if (len > 0 && last[paths[i]] === len) stable[paths[i]] = (stable[paths[i]] || 0) + 1;
                else stable[paths[i]] = 0;
                last[paths[i]] = len;
                if (stable[paths[i]] < 2) all = false;
            }
            if (all) return true;
            $.sleep(30);
        }
        return false;
    }

    /**
     * args: { key, frames: [frameIndexWithinLayer...] } - renders those frames to
     * <framesPath>/L<key>_<index>.png and returns their paths.
     */
    function renderFrames(argsJson) {
        try {
            var a = parse(argsJson);
            if (!session) return R(false, "No tracking session.");
            var info = session.layers[a.key];
            if (!info) return R(false, "Unknown layer " + a.key);
            var tc;
            app.beginUndoGroup("Dala Auto Tracker: analysis frames");
            try { tc = tempCompFor(info); } finally { app.endUndoGroup(); }
            var paths = [], t0 = new Date().getTime();
            for (var i = 0; i < a.frames.length; i++) {
                var idx = a.frames[i];
                var f = new File(session.framesPath + "/L" + a.key + "_" + idx + ".png");
                // never ask for the same file twice: a second request can collide with the first write
                if (!session.requested[f.fsName] && !f.exists) {
                    session.requested[f.fsName] = true;
                    tc.saveFrameToPng(info.times[idx], f);
                }
                paths.push(f.fsName);
            }
            // saveFrameToPng writes in the background; the panel polls frameSizes() (or stats the
            // files itself) until they are complete, so After Effects is never blocked here.
            return R(true, "ok", { paths: paths, ms: new Date().getTime() - t0 });
        } catch (err) {
            return R(false, "Rendering analysis frames failed: " + err.toString());
        }
    }

    /** Current byte sizes of the given files (-1 = not there yet). One quick pass, no waiting. */
    function frameSizes(argsJson) {
        try {
            var a = parse(argsJson), out = [];
            for (var i = 0; i < a.paths.length; i++) {
                var f = new File(a.paths[i]);
                out.push(f.exists ? f.length : -1);
            }
            return R(true, "ok", { sizes: out });
        } catch (err) { return R(false, err.toString()); }
    }

    /** Removes the analysis comps and frames. Called before apply() so that apply is the
     *  last undoable step and a single Ctrl+Z reverts the tracking. */
    function releaseAnalysis() {
        try {
            if (!session) return R(true, "Nothing to release.");
            app.beginUndoGroup("Dala Auto Tracker: remove analysis comps");
            try { removeTempItems(); } finally { app.endUndoGroup(); }
            deleteFramesFolder();
            return R(true, "ok");
        } catch (err) { return R(false, err.toString()); }
    }

    function deleteFrames(argsJson) {
        try {
            var a = parse(argsJson);
            for (var i = 0; i < a.frames.length; i++) {
                var f = new File(session.framesPath + "/L" + a.key + "_" + a.frames[i] + ".png");
                if (f.exists) f.remove();
            }
            return R(true, "ok");
        } catch (err) { return R(false, err.toString()); }
    }

    // ------------------------------------------------------------------ apply

    function getTransform(layer) {
        var tg = layer.property("ADBE Transform Group");
        var pos = tg.property("ADBE Position");
        if (pos.dimensionsSeparated) { pos.dimensionsSeparated = false; pos = tg.property("ADBE Position"); }
        var scale = tg.property("ADBE Scale");
        if (scale.dimensionsSeparated) { scale.dimensionsSeparated = false; scale = tg.property("ADBE Scale"); }
        var rot = null;
        try { rot = tg.property("ADBE Rotate Z"); } catch (e) {}
        return { tg: tg, pos: pos, scale: scale, anchor: tg.property("ADBE Anchor Point"), rot: rot };
    }

    function clearKeys(prop) {
        var n = 0;
        try { while (prop.numKeys > 0) { prop.removeKey(prop.numKeys); n++; } } catch (e) {}
        return n;
    }

    function ensureMirrorTile(layer, srcW, srcH) {
        var fx = layer.property("ADBE Effect Parade"), tile = null, i;
        for (i = 1; i <= fx.numProperties; i++) {
            var p = fx.property(i);
            if (p.matchName === "ADBE Tile" && p.name === TILE_NAME) { tile = p; break; }
        }
        if (!tile) { tile = fx.addProperty("ADBE Tile"); try { tile.name = TILE_NAME; } catch (eN) {} }
        try { tile.property("ADBE Tile-0001").setValue([srcW / 2, srcH / 2]); } catch (e1) {}   // Tile Center
        try { tile.property("ADBE Tile-0002").setValue(100); } catch (e2) {}                    // Tile Width
        try { tile.property("ADBE Tile-0003").setValue(100); } catch (e3) {}                    // Tile Height
        try { tile.property("ADBE Tile-0004").setValue(300); } catch (e4) {}                    // Output Width
        try { tile.property("ADBE Tile-0005").setValue(300); } catch (e5) {}                    // Output Height
        try { tile.property("ADBE Tile-0006").setValue(1); } catch (e6) {}                      // Mirror Edges
        return tile;
    }

    function removeMirrorTile(layer) {
        var fx = layer.property("ADBE Effect Parade"), n = 0;
        for (var i = fx.numProperties; i >= 1; i--) {
            var p = fx.property(i);
            if (p.matchName === "ADBE Tile" && p.name === TILE_NAME) { p.remove(); n++; }
        }
        return n;
    }

    /**
     * Keys one shot the way the manual head track does: the Anchor Point follows the track point
     * on every frame (what Tracker > Stabilize > Apply X and Y writes) and Position holds the spot
     * $._dalaSuite.framing.solve() puts it on (the comp centre; it only moves where the framing has
     * to keep bars / empty comp areas out). Scale is one value per shot (or keys when the framing
     * zooms with the subject). trk = [[frameIndex, x, y], ...] in source pixels, one entry per frame.
     */
    function keyShot(layer, info, comp, trk, opts, hold, act) {
        var T = getTransform(layer), fps = comp.frameRate, i;
        var baseScale = Math.abs(T.scale.valueAtTime(layer.inPoint, false)[0]) / 100;
        var rotDeg = T.rot ? T.rot.valueAtTime((info.f0 + trk[0][0]) / fps, false) : 0;
        var fxp = info.par / info.compPar;
        var F = $._dalaSuite.framing.solve(trk, {
            compW: comp.width, compH: comp.height, srcW: info.srcW, srcH: info.srcH, fxp: fxp, act: act,
            baseScale: opts.keepScale === false ? 0 : baseScale, rotDeg: rotDeg
        }, {
            axis: opts.axis, centerY: opts.centerY !== false, zoom: opts.zoom, maxZoom: opts.maxZoom,
            mirror: opts.mirror !== false, vTarget: opts.vTarget, fps: fps
        });
        var mX = F.subject.mx, mY = F.subject.my;

        var a0 = T.anchor.valueAtTime(layer.inPoint, false);
        var pos0 = T.pos.valueAtTime((info.f0 + trk[0][0]) / fps, false);
        var is3D = pos0.length > 2;

        var times = [], aVals = [], vals = [], fixed = true;
        for (i = 0; i < trk.length; i++) {
            var t = (info.f0 + trk[i][0]) / fps;
            var px = (opts.axis === "y") ? mX : trk[i][1];
            var py = (opts.axis === "x") ? mY : trk[i][2];
            var tx = F.target[i][0], ty = F.target[i][1];
            times.push(t);
            aVals.push(a0.length > 2 ? [px, py, a0[2]] : [px, py]);
            vals.push(is3D ? [tx, ty, pos0[2]] : [tx, ty]);
            if (Math.abs(tx - F.target[0][0]) > 0.01 || Math.abs(ty - F.target[0][1]) > 0.01) fixed = false;
        }
        function linearKeys(prop, ts, vs, spatial) {
            if (typeof prop.setValuesAtTimes === "function") prop.setValuesAtTimes(ts, vs);
            else for (var k = 0; k < ts.length; k++) prop.setValueAtTime(ts[k], vs[k]);
            for (var j = 0; j < ts.length; j++) {
                var ki = prop.nearestKeyIndex(ts[j]);
                try { prop.setInterpolationTypeAtKey(ki, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e1) {}
                if (!spatial) continue;
                try { prop.setSpatialAutoBezierAtKey(ki, false); prop.setSpatialContinuousAtKey(ki, false); } catch (e2) {}
                var z = vs[0].length > 2 ? [0, 0, 0] : [0, 0];
                try { prop.setSpatialTangentsAtKey(ki, z, z); } catch (e3) {}
            }
        }
        linearKeys(T.anchor, times, aVals, true);
        // a manual track leaves Position as one value; it is keyed only when the framing moves it
        // (or when several shots share one layer)
        if (fixed && !hold) T.pos.setValue(vals[0]);
        else linearKeys(T.pos, times, vals, true);

        if (hold) {
            try { T.pos.setInterpolationTypeAtKey(T.pos.nearestKeyIndex(times[times.length - 1]), KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.HOLD); } catch (e4) {}
            try { T.anchor.setInterpolationTypeAtKey(T.anchor.nearestKeyIndex(times[times.length - 1]), KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.HOLD); } catch (e5) {}
        }
        // zoom that follows the subject: one Scale key per frame (signs / z of the layer kept)
        if (F.dynamic) {
            var s0 = T.scale.valueAtTime(times[0], false), sv = [];
            for (i = 0; i < times.length; i++) {
                var sx = (s0[0] < 0 ? -1 : 1) * F.scales[i] * 100, sy = (s0[1] < 0 ? -1 : 1) * F.scales[i] * 100;
                sv.push(s0.length > 2 ? [sx, sy, s0[2]] : [sx, sy]);
            }
            if (typeof T.scale.setValuesAtTimes === "function") T.scale.setValuesAtTimes(times, sv);
            else for (i = 0; i < times.length; i++) T.scale.setValueAtTime(times[i], sv[i]);
            for (i = 0; i < times.length; i++) {
                try { T.scale.setInterpolationTypeAtKey(T.scale.nearestKeyIndex(times[i]), KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e5) {}
            }
            if (hold) {
                try { T.scale.setInterpolationTypeAtKey(T.scale.nearestKeyIndex(times[times.length - 1]), KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.HOLD); } catch (e6) {}
            }
        }
        return { scale: F.scale, dynamic: F.dynamic, keys: times.length, startTime: times[0], clamped: F.clampedFrames };
    }

    // ------------------------------------------------------------------ After Effects trackers

    function findTracker(layer, name) {
        var trk = layer.property("ADBE MTrackers");
        for (var i = 1; i <= trk.numProperties; i++) if (trk.property(i).name === name) return trk.property(i);
        return null;
    }

    function removeTrackers(layer, names) {
        var n = 0;
        for (var i = 0; names && i < names.length; i++) {
            var t = findTracker(layer, names[i]);
            if (t) { try { t.remove(); n++; } catch (e) {} }
        }
        return n;
    }

    /**
     * A new track point starts with no position (reading it fails until all of its positions are
     * written), so every spatial value is set before anything else.
     */
    function initTrackPoint(pt, c, f, s) {
        pt.property("ADBE MTracker Pt Feature Center").setValue(c);
        pt.property("ADBE MTracker Pt Feature Size").setValue(f);
        pt.property("ADBE MTracker Pt Search Ofst").setValue([0, 0]);
        pt.property("ADBE MTracker Pt Search Size").setValue(s);
        pt.property("ADBE MTracker Pt Attach Pt").setValue(c);
        pt.property("ADBE MTracker Pt Attach Pt Ofst").setValue([0, 0]);
    }

    /**
     * The shot's track as a real After Effects tracker on the layer (Motion
     * Trackers > Tracker N > Track Point 1: Feature Center / Confidence / Attach Point keyed on every
     * frame, the feature and search regions sized as tracked) - what a manual track leaves behind.
     */
    function writeTracker(layer, info, comp, shot) {
        var fps = comp.frameRate, trk = shot.track, i;
        var t = layer.property("ADBE MTrackers").addProperty("ADBE MTracker"), pt = t.addProperty("ADBE MTracker Pt");
        var f = shot.feature ? [shot.feature.w, shot.feature.h] : [60, 69], s = shot.search ? [shot.search.w, shot.search.h] : [f[0] * 1.7, f[1] * 1.7];
        initTrackPoint(pt, [trk[0][1], trk[0][2]], f, s);
        var times = [], pts = [], conf = [];
        for (i = 0; i < trk.length; i++) {
            times.push((info.f0 + trk[i][0]) / fps);
            pts.push([trk[i][1], trk[i][2]]);
            conf.push(shot.conf && shot.conf[i] != null ? shot.conf[i] : 100);
        }
        pt.property("ADBE MTracker Pt Feature Center").setValuesAtTimes(times, pts);
        pt.property("ADBE MTracker Pt Attach Pt").setValuesAtTimes(times, pts);
        pt.property("ADBE MTracker Pt Confidence").setValuesAtTimes(times, conf);
        return t.name;
    }

    function setScaleAt(layer, t, sc, keyed) {
        var T = getTransform(layer), v = T.scale.valueAtTime(t, false);
        var sx = (v[0] < 0 ? -1 : 1) * sc * 100, sy = (v[1] < 0 ? -1 : 1) * sc * 100;
        var nv = v.length > 2 ? [sx, sy, v[2]] : [sx, sy];
        if (keyed) {
            T.scale.setValueAtTime(t, nv);
            var ki = T.scale.nearestKeyIndex(t);
            try { T.scale.setInterpolationTypeAtKey(ki, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); } catch (e) {}
        } else {
            T.scale.setValue(nv);
        }
    }

    function captureOriginal(layer, info) {
        var T = getTransform(layer), prev = null;
        if (String(info.origComment).indexOf(TAG) === 0) {
            try { prev = JSON.parse(String(info.origComment).substring(TAG.length)); } catch (e) { prev = null; }
        }
        if (prev) return prev;   // re-tracking: keep the very first original
        return {
            pos: T.pos.valueAtTime(layer.inPoint, false),
            scale: T.scale.valueAtTime(layer.inPoint, false),
            anchor: T.anchor.valueAtTime(layer.inPoint, false),
            posKeys: T.pos.numKeys, scaleKeys: T.scale.numKeys,
            mb: layer.motionBlur,
            comment: String(info.origComment)
        };
    }

    /**
     * payload: { axis:'xy'|'x'|'y', split, mirror, motionBlur, zoom:'auto'|'off', centerY, maxZoom,
     *            layers: [{ key, shots: [{ start, end, track: [[i,x,y],...] | null, conf: [0..100], feature {w,h},
     *                        search {w,h} (source px) }] }] }
     */
    function apply(payloadJson) {
        var P;
        $._dalaSuite.debug.clear();   // results carry only this run's log, like the other Dala tools
        try { P = parse(payloadJson); } catch (eP) { return R(false, "Bad tracking data: " + eP.toString()); }
        var comp;
        try { comp = sessionComp(); } catch (eS) { return R(false, eS.message); }
        var summary = { layers: 0, shots: 0, keys: 0, skippedShots: 0, warnings: [] };
        var resolved = [], rj, cutTargets = [];
        for (rj = 0; rj < P.layers.length; rj++) resolved.push(resolveLayer(comp, session.layers[P.layers[rj].key]));
        app.beginUndoGroup("Dala Auto Tracker");
        try {
            for (var li = 0; li < P.layers.length; li++) {
                var Lp = P.layers[li], info = session.layers[Lp.key];
                var layer = resolved[li];
                if (!layer) { summary.warnings.push("Layer \"" + info.name + "\" was not found (was it deleted, renamed or trimmed?)."); continue; }
                var tracked = 0, si;
                for (si = 0; si < Lp.shots.length; si++) if (Lp.shots[si].track && Lp.shots[si].track.length) tracked++;
                if (!tracked) { summary.skippedShots += Lp.shots.length; continue; }

                var orig = captureOriginal(layer, info);
                var act = (Lp.active && Lp.active.x1 > Lp.active.x0 && Lp.active.y1 > Lp.active.y0)
                    ? Lp.active : { x0: 0, y0: 0, x1: info.srcW, y1: info.srcH };
                var fps = comp.frameRate;
                var T0 = getTransform(layer);
                if (T0.pos.expressionEnabled) { T0.pos.expressionEnabled = false; summary.warnings.push("Disabled the Position expression on \"" + info.name + "\"."); }
                if (T0.pos.numKeys > 0 && !info.retrack) summary.warnings.push("Replaced existing Position keyframes on \"" + info.name + "\".");
                if (T0.anchor.expressionEnabled) { T0.anchor.expressionEnabled = false; summary.warnings.push("Disabled the Anchor Point expression on \"" + info.name + "\"."); }
                if (T0.anchor.numKeys > 0 && !info.retrack) summary.warnings.push("Replaced existing Anchor Point keyframes on \"" + info.name + "\".");
                clearKeys(T0.pos);
                clearKeys(T0.scale);
                clearKeys(T0.anchor);
                // reset to the original static transform before re-keying; drop the trackers a previous run added
                try { T0.pos.setValue(orig.pos); } catch (eO) {}
                try { T0.scale.setValue(orig.scale); } catch (eO2) {}
                if (orig.anchor) { try { T0.anchor.setValue(orig.anchor); } catch (eO3) {} }
                if (orig.trackers) removeTrackers(layer, orig.trackers);

                // segments: split layers at shot boundaries (optional)
                var segs = [];
                if (P.split && Lp.shots.length > 1) {
                    var cur = layer;
                    for (si = 0; si < Lp.shots.length; si++) {
                        var sh = Lp.shots[si];
                        if (si > 0) {
                            var cutT = (info.f0 + sh.start) / fps, curOut = cur.outPoint;
                            var dup = cur.duplicate();
                            dup.inPoint = cutT; dup.outPoint = curOut;
                            cur.outPoint = cutT;
                            cur = dup;
                        }
                        segs.push(cur);
                    }
                } else {
                    for (si = 0; si < Lp.shots.length; si++) segs.push(layer);
                }

                var meta = { pos: orig.pos, scale: orig.scale, anchor: orig.anchor, mb: orig.mb, comment: orig.comment, trackers: [], v: 2 };
                var touched = [];
                for (si = 0; si < Lp.shots.length; si++) {
                    var shot = Lp.shots[si], target = segs[si];
                    var keyedScale = !P.split && Lp.shots.length > 1;
                    var shotStart = (info.f0 + shot.start) / fps;
                    if (!shot.track || !shot.track.length) {
                        summary.skippedShots++;
                        if (keyedScale) {
                            // untracked shot inside a tracked layer: hold the original framing
                            var Tg = getTransform(target);
                            Tg.pos.setValueAtTime(shotStart, orig.pos);
                            try { Tg.pos.setInterpolationTypeAtKey(Tg.pos.nearestKeyIndex(shotStart), KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); } catch (eH) {}
                            if (orig.anchor) {
                                Tg.anchor.setValueAtTime(shotStart, orig.anchor);
                                try { Tg.anchor.setInterpolationTypeAtKey(Tg.anchor.nearestKeyIndex(shotStart), KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); } catch (eHa) {}
                            }
                            setScaleAt(target, shotStart, Math.abs(orig.scale[0]) / 100, true);
                        }
                        continue;
                    }
                    // the track as an After Effects tracker on the layer, like a manual track leaves behind
                    var tname = null;
                    try { tname = writeTracker(target, info, comp, shot); } catch (eT) { summary.warnings.push("Could not add the tracker to \"" + info.name + "\": " + eT.toString()); }
                    if (tname) {
                        var known = false;
                        for (var mt = 0; mt < meta.trackers.length; mt++) if (meta.trackers[mt] === tname) known = true;
                        if (!known) meta.trackers.push(tname);
                    }
                    var res = keyShot(target, info, comp, shot.track, P, keyedScale, act);
                    if (!res.dynamic) setScaleAt(target, keyedScale ? res.startTime : target.inPoint, res.scale, keyedScale);
                    if (P.mirror !== false) ensureMirrorTile(target, info.srcW, info.srcH);
                    if (P.motionBlur) { try { target.motionBlur = true; comp.motionBlur = true; } catch (eM) {} }
                    summary.shots++; summary.keys += res.keys;
                    var seen = false;
                    for (var q = 0; q < touched.length; q++) if (touched[q] === target) seen = true;
                    if (!seen) touched.push(target);
                }
                for (var tq = 0; tq < touched.length; tq++) touched[tq].comment = TAG + JSON.stringify(meta);
                summary.layers++;
                for (var tc = 0; tc < touched.length; tc++) cutTargets.push(touched[tc]);
            }

            // CUT 2 F on every tracked clip: frame blending + motion blur on, split First 2F / Mid /
            // Last 2F, frame blending off on the 2-frame ends, pre-compose (same as the CUT TO F tool)
            summary.precomps = 0; summary.cutSkipped = [];
            if (P.cut2f) {
                // bottom-most first so pre-composing never shifts the layers still to do
                cutTargets.sort(function (a, b) { return b.index - a.index; });
                var made = [];
                for (var ct = 0; ct < cutTargets.length; ct++) {
                    var cr = $._dalaSuite.cutToFLayer(comp, cutTargets[ct], { enableBlending: true, motionBlur: true });
                    if (cr.skipped) {
                        // too short for 2F + Mid + 2F: still give it frame blending + motion blur
                        try { cutTargets[ct].frameBlendingType = FrameBlendingType.PIXEL_MOTION; } catch (eFb) {}
                        try { cutTargets[ct].motionBlur = true; comp.motionBlur = true; comp.frameBlending = true; } catch (eMb) {}
                        summary.cutSkipped.push(cr.skipped.layerName);
                    } else if (cr.precompLayer) {
                        cr.precompLayer.comment = PRECOMP_TAG;
                        made.push(cr.precompLayer);
                        summary.precomps++;
                    }
                }
                if (made.length) {
                    for (var d = 1; d <= comp.numLayers; d++) { try { comp.layer(d).selected = false; } catch (eSel) {} }
                    for (var mk = 0; mk < made.length; mk++) { try { made[mk].selected = true; } catch (eSel2) {} }
                }
            }
        } catch (err) {
            app.endUndoGroup();
            return R(false, "Applying the track failed: " + err.toString() + (err.line ? " (line " + err.line + ")" : ""), summary);
        }
        app.endUndoGroup();
        var msg = "Centred " + summary.shots + " shot" + (summary.shots === 1 ? "" : "s") + " on " + summary.layers + " layer" + (summary.layers === 1 ? "" : "s");
        if (P.cut2f) msg += summary.precomps ? ", Cut to F: " + summary.precomps + " pre-comp" + (summary.precomps === 1 ? "" : "s") : "";
        if (summary.cutSkipped && summary.cutSkipped.length) msg += " (" + summary.cutSkipped.length + " too short for Cut to F)";
        return R(true, msg + ".", summary);
    }

    // ------------------------------------------------------------------ remove / cleanup

    function remove() {
        $._dalaSuite.debug.clear();
        try {
            var comp = $._dalaSuite.getActiveComp();
            var sel = comp.selectedLayers, n = 0;
            if (!sel || !sel.length) return R(false, "Select the tracked layers first.");
            // tracked layers may sit inside the Cut-to-F pre-comps made after tracking
            var targets = [], i, j;
            for (i = 0; i < sel.length; i++) {
                if (String(sel[i].comment).indexOf(TAG) === 0) targets.push(sel[i]);
                else if (sel[i].source instanceof CompItem) {
                    for (j = 1; j <= sel[i].source.numLayers; j++) {
                        if (String(sel[i].source.layer(j).comment).indexOf(TAG) === 0) targets.push(sel[i].source.layer(j));
                    }
                }
            }
            app.beginUndoGroup("Dala Auto Tracker: remove tracking");
            try {
                for (i = 0; i < targets.length; i++) {
                    var L = targets[i], c = String(L.comment);
                    var meta = null;
                    try { meta = JSON.parse(c.substring(TAG.length)); } catch (e) {}
                    var T = getTransform(L);
                    clearKeys(T.pos); clearKeys(T.scale);
                    if (meta && meta.pos) T.pos.setValue(meta.pos);
                    if (meta && meta.scale) T.scale.setValue(meta.scale);
                    if (meta && meta.anchor) { clearKeys(T.anchor); T.anchor.setValue(meta.anchor); }
                    if (meta && meta.trackers) removeTrackers(L, meta.trackers);
                    removeMirrorTile(L);
                    if (meta && meta.mb === false) L.motionBlur = false;
                    L.comment = meta && meta.comment != null ? meta.comment : "";
                    n++;
                }
            } finally { app.endUndoGroup(); }
            if (!n) return R(false, "None of the selected layers were tracked by Dala Auto Tracker.");
            return R(true, "Removed tracking from " + n + " layer" + (n === 1 ? "" : "s") + ".", { count: n });
        } catch (err) { return R(false, err.toString()); }
    }

    function cleanup() {
        try {
            if (!session) return R(true, "Nothing to clean.");
            if (session.tempIds.length) {
                app.beginUndoGroup("Dala Auto Tracker: cleanup");
                try { removeTempItems(); } finally { app.endUndoGroup(); }
            }
            deleteFramesFolder();
            session = null;
            return R(true, "Cleaned up.");
        } catch (err) { session = null; return R(false, err.toString()); }
    }

    function selectionInfo() {
        try {
            var comp = app.project.activeItem;
            if (!comp || !(comp instanceof CompItem)) return R(true, "", { tracked: 0, selected: 0 });
            var sel = comp.selectedLayers, tracked = 0;
            for (var i = 0; i < sel.length; i++) if (String(sel[i].comment).indexOf(TAG) === 0) tracked++;
            return R(true, "", { tracked: tracked, selected: sel.length });
        } catch (err) { return R(false, err.toString()); }
    }

    return {
        prepare: prepare, renderFrames: renderFrames, frameSizes: frameSizes, deleteFrames: deleteFrames, apply: apply,
        remove: remove, cleanup: cleanup, releaseAnalysis: releaseAnalysis, selectionInfo: selectionInfo,
        _session: function () { return session; }
    };
})();
