/**
 * Dala Suite - GENERAL tools, host side (ExtendScript, ECMAScript 3). The Edit tools are host/editTools.jsx.
 *   beatCheck()          coloured solids from each beat marker to the next
 *   arrangeClips()       BEAT CLIPS ARRANGER: footage / precomp clips laid one per beat interval, in their current order
 *   sequence()           SEQUENCE LAYERS: the selected clips one after another in their layer order (top first), the
 *                        first at its own start, each keeping its length; frame-exact, nothing else moves
 *   layerTypes()         CHECK COMPOSITION: how many layers of each type the active comp has
 *   selectType(json)     { type } selects every layer of that type in the active comp (type "all": every layer)
 *   organise(json)       ORGANISE PROJECT: items into Compositions (Precomps), Footage (Video / Audio / Images), Solids
 *                        folders; only parentFolder changes, so footage links, comps and expressions are untouched
 *   gaps(json)           GAP FINDER: { close: none | all | [indexes] } the empty stretches between the clips (selected
 *                        clips, else every clip); close moves the later clips back by each gap (ripple)
 *   blackScan(json)      BLACK FRAMES (timeline part): frames no clip covers - also inside precomps - and the footage
 *                        spans to check for black pictures (the panel runs FFmpeg on them); blackMarkers(json) marks them
 */

$._dalaSuite.general = (function () {
    var CHECK_TAG = "Dala Beat Check";

    function R(ok, msg, data) { return $._dalaSuite.formatResult(ok, msg, data); }
    function activeComp() { var c = app.project.activeItem; return (c && c instanceof CompItem) ? c : null; }
    function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

    // ------------------------------------------------------------------ beat markers

    function keyTimes(mk) { var t = []; for (var k = 1; k <= mk.numKeys; k++) t.push(mk.keyTime(k)); return t; }
    function isDalaBeat(mk) {
        for (var k = 1; k <= mk.numKeys; k++) { try { if (mk.keyValue(k).getParameters().dala === "dala-beat") return true; } catch (e) {} }
        return false;
    }
    function audioOnly(L) { try { return L.hasAudio && !L.hasVideo; } catch (e) { return false; } }

    /** The beat markers to use: a selected layer's markers, else the comp's own markers, else the layer with
     *  Dala's beat markers, else the (audio) layer with the most markers. skip: layers whose markers do not count. */
    function beatTimes(c, skip) {
        var pick = null, i, L, mk;
        function cand(times, where) { if (times.length >= 2 && (!pick || times.length > pick.times.length)) pick = { times: times, where: where }; }
        var sel = c.selectedLayers;
        for (i = 0; i < sel.length; i++) if (!skip(sel[i])) cand(keyTimes(sel[i].property("ADBE Marker")), "the markers of \"" + sel[i].name + "\"");
        if (!pick) { try { cand(keyTimes(c.markerProperty), "the composition markers"); } catch (e) {} }
        if (!pick) for (i = 1; i <= c.numLayers; i++) { L = c.layer(i); mk = L.property("ADBE Marker"); if (!skip(L) && mk && mk.numKeys >= 2 && isDalaBeat(mk)) cand(keyTimes(mk), "the beat markers on \"" + L.name + "\""); }
        if (!pick) for (i = 1; i <= c.numLayers; i++) { L = c.layer(i); mk = L.property("ADBE Marker"); if (!skip(L) && mk && audioOnly(L)) cand(keyTimes(mk), "the markers on \"" + L.name + "\""); }
        if (!pick) for (i = 1; i <= c.numLayers; i++) { L = c.layer(i); mk = L.property("ADBE Marker"); if (!skip(L) && mk) cand(keyTimes(mk), "the markers on \"" + L.name + "\""); }
        if (!pick) return null;
        var t = pick.times.sort(function (x, y) { return x - y; }), out = [];
        for (i = 0; i < t.length; i++) {
            if (t[i] < -1e-6 || t[i] > c.duration + 1e-6) continue;
            if (out.length && t[i] - out[out.length - 1] < c.frameDuration * 0.5) continue;
            out.push(t[i]);
        }
        pick.times = out;
        return out.length >= 2 ? pick : null;
    }

    function isCheck(L) { try { return String(L.comment).indexOf(CHECK_TAG) === 0; } catch (e) { return false; } }

    var COLORS = [[0.93, 0.27, 0.27], [0.98, 0.80, 0.16], [0.18, 0.74, 0.96], [0.66, 0.40, 0.98], [0.27, 0.85, 0.46], [0.98, 0.52, 0.16]];

    function beatCheck() {
        var c = activeComp();
        if (!c) return R(false, "Open the composition with the beat markers first.");
        var src = beatTimes(c, isCheck);
        if (!src) return R(false, "No beat markers: add at least 2 to the comp or a layer (Audio > Beat Marker).");
        var t = src.times, i, removed = 0, keep = [], sel = c.selectedLayers;
        for (i = 0; i < sel.length; i++) if (!isCheck(sel[i])) keep.push(sel[i]);   // adding layers selects them: restored below
        app.beginUndoGroup("Dala Suite: Beat Checker");
        try {
            for (i = c.numLayers; i >= 1; i--) if (isCheck(c.layer(i))) { c.layer(i).remove(); removed++; }
            // one solid per colour, reused by every interval of that colour
            var folder = null, items = [];
            for (i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === CHECK_TAG) folder = it; }
            if (folder) for (i = 1; i <= folder.numItems; i++) { var s = folder.item(i); if (s instanceof FootageItem && /^Beat Check \d$/.test(s.name) && s.width === c.width && s.height === c.height) items[Number(s.name.slice(-1)) - 1] = s; }
            if (!folder) folder = app.project.items.addFolder(CHECK_TAG);
            var made = 0;
            for (i = t.length - 2; i >= 0; i--) {
                var ci = i % COLORS.length, L;
                if (items[ci] && items[ci].duration >= c.duration) L = c.layers.add(items[ci]);
                else {
                    L = c.layers.addSolid(COLORS[ci], "Beat Check " + (ci + 1), c.width, c.height, c.pixelAspect, c.duration);
                    items[ci] = L.source;
                    items[ci].parentFolder = folder;
                }
                L.moveToBeginning();
                L.startTime = t[i];
                L.inPoint = t[i];
                L.outPoint = t[i + 1];
                L.name = "Beat " + (i + 1) + "-" + (i + 2);
                L.comment = CHECK_TAG;
                L.label = [1, 2, 14, 10, 9, 11][ci];
                made++;
            }
            for (i = 1; i <= c.numLayers; i++) c.layer(i).selected = false;
            for (i = 0; i < keep.length; i++) { try { keep[i].selected = true; } catch (eS) {} }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Beat Checker failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(true, plural(made, "beat solid") + " added, from " + src.where + (removed ? " (refreshed)" : ""), { made: made });
    }

    // ------------------------------------------------------------------ arrange clips

    function isClip(L) {
        if (!(L instanceof AVLayer) || (L instanceof TextLayer) || (L instanceof ShapeLayer)) return false;
        if (L.nullLayer || L.adjustmentLayer || isCheck(L)) return false;
        try { if (!L.hasVideo) return false; } catch (e) { return false; }
        var s = L.source;
        if (s instanceof CompItem) return true;
        return (s instanceof FootageItem) && !(s.mainSource instanceof SolidSource);
    }

    function arrangeClips() {
        var c = activeComp();
        if (!c) return R(false, "Open the composition with the clips and the beat markers first.");
        var clips = [], sel = c.selectedLayers, i;
        for (i = 0; i < sel.length; i++) if (isClip(sel[i])) clips.push(sel[i]);
        var fromSel = clips.length > 0;
        if (!fromSel) for (i = 1; i <= c.numLayers; i++) if (isClip(c.layer(i))) clips.push(c.layer(i));
        if (!clips.length) return R(false, "No footage or precomp clips to arrange (audio, text, solids and nulls are left alone).");
        var inClips = {};
        for (i = 0; i < clips.length; i++) inClips[clips[i].index] = true;
        var src = beatTimes(c, function (L) { return inClips[L.index] || isCheck(L); });
        if (!src) return R(false, "No beat markers: add at least 2 to the comp or another layer (Audio > Beat Marker).");
        // the clips' current order: start time, then stacking order (top first)
        clips.sort(function (x, y) { return (Math.abs(x.inPoint - y.inPoint) > 1e-6) ? x.inPoint - y.inPoint : x.index - y.index; });
        var t = src.times, n = Math.min(clips.length, t.length - 1), shortOnes = [], locked = [], placed = 0;
        app.beginUndoGroup("Dala Suite: Beat Clips Arranger");
        try {
            for (i = 0; i < clips.length && placed < n; i++) {
                var L = clips[i];
                if (L.locked) { locked.push(L.name); continue; }
                var a = t[placed], b = t[placed + 1];
                L.startTime = L.startTime + (a - L.inPoint);        // the clip's own trim is kept, it just moves
                var maxOut = 1e9, s = L.source;
                var still = (s instanceof FootageItem) && s.mainSource && s.mainSource.isStill;
                if (!still && !L.timeRemapEnabled && s.duration > 0) maxOut = L.startTime + s.duration * Math.abs(L.stretch) / 100;
                var out = Math.min(b, maxOut);
                if (out < b - c.frameDuration * 0.5) shortOnes.push(L.name);
                L.outPoint = out;
                placed++;
            }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Arranging the clips failed: " + e.toString());
        }
        app.endUndoGroup();
        var msg = "Placed " + plural(placed, "clip") + " on the beats";
        var left = clips.length - placed - locked.length;
        if (left > 0) msg += " \u00B7 " + plural(left, "clip") + " without a beat";
        if (t.length - 1 > placed) msg += " \u00B7 " + plural(t.length - 1 - placed, "beat") + " left empty";
        if (shortOnes.length) msg += " \u00B7 too short: " + shortOnes.join(", ");
        if (locked.length) msg += " \u00B7 locked: " + locked.join(", ");
        return R(placed > 0, msg, { placed: placed });
    }

    // ------------------------------------------------------------------ shared helpers for the clip tools

    function fd(c) { return c.frameDuration; }
    function fr(t, c) { return Math.round(t / c.frameDuration); }
    function isVideoClip(L) {
        if (!(L instanceof AVLayer) || (L instanceof TextLayer) || (L instanceof ShapeLayer)) return false;
        if (L.nullLayer || L.adjustmentLayer || isCheck(L)) return false;
        try { if (!L.hasVideo) return false; } catch (e) { return false; }
        var s = L.source;
        if (s instanceof CompItem) return true;
        return (s instanceof FootageItem) && !(s.mainSource instanceof SolidSource);
    }
    function tc(t, c) {
        var f = fr(t, c), neg = f < 0, fps = Math.round(1 / c.frameDuration);
        if (neg) f = -f;
        var ff = f % fps, s = Math.floor(f / fps), p = function (n) { return (n < 10 ? "0" : "") + n; };
        return (neg ? "-" : "") + Math.floor(s / 3600) + ":" + p(Math.floor(s / 60) % 60) + ":" + p(s % 60) + ":" + p(ff);
    }
    /** the frames a layer shows: [first, after last] - it shows at frame f when inPoint <= f * frameDuration < outPoint */
    function vis(L, c) { return [Math.ceil(L.inPoint / c.frameDuration - 1e-6), Math.ceil(L.outPoint / c.frameDuration - 1e-6)]; }
    /** moves a layer by a whole number of frames: it shows the very same pictures, just earlier or later (in / out
     *  points move with it, so a clip that ends between frames is never stretched past its footage) */
    function shiftFrames(L, df, c) { if (df) L.startTime = L.startTime + df * c.frameDuration; }

    // ------------------------------------------------------------------ sequence layers

    function sequence() {
        var c = activeComp();
        if (!c) return R(false, "Open the composition with the clips first.");
        var sel = c.selectedLayers, clips = [], other = 0, locked = [], i;
        for (i = 0; i < sel.length; i++) {
            if (!isVideoClip(sel[i])) { other++; continue; }
            if (sel[i].locked) { locked.push(sel[i].name); continue; }
            clips.push(sel[i]);
        }
        if (clips.length < 2) return R(false, clips.length ? "Select at least two video clips to sequence." : "Select the video clips to sequence (footage or precomps; audio, text, solids and nulls are left alone).");
        clips.sort(function (x, y) { return x.index - y.index; });       // their layer order in the timeline, top first
        app.beginUndoGroup("Dala Suite: Sequence layers");
        try {
            var at = vis(clips[0], c)[0];
            for (i = 0; i < clips.length; i++) {
                var L = clips[i], v = vis(L, c);
                shiftFrames(L, at - v[0], c);
                at += Math.max(0, v[1] - v[0]);
            }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Sequencing failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(true, plural(clips.length, "clip") + " in sequence from " + tc(clips[0].inPoint, c) + " to " + tc(clips[clips.length - 1].outPoint, c) + ", no gaps or overlaps" +
            (other ? " \u00B7 " + plural(other, "other layer") + " left alone" : "") + (locked.length ? " \u00B7 locked: " + locked.join(", ") : ""), { count: clips.length });
    }

    // ------------------------------------------------------------------ select layers by type

    var TYPES = [["video", "Video layers"], ["audio", "Audio layers"], ["text", "Text layers"], ["shape", "Shape layers"], ["adjustment", "Adjustment layers"],
        ["solid", "Solid layers"], ["null", "Null objects"], ["camera", "Camera layers"], ["light", "Light layers"], ["precomp", "Precompositions"]];
    function typeOf(L) {
        if (L instanceof CameraLayer) return "camera";
        if (L instanceof LightLayer) return "light";
        if (L instanceof TextLayer) return "text";
        if (L instanceof ShapeLayer) return "shape";
        if (!(L instanceof AVLayer)) return "other";
        if (L.adjustmentLayer) return "adjustment";
        if (L.nullLayer) return "null";
        var s = L.source;
        if (s instanceof CompItem) return "precomp";
        if (s instanceof FootageItem) {
            if (s.mainSource instanceof SolidSource) return "solid";
            var v = false, a = false;
            try { v = L.hasVideo; a = L.hasAudio; } catch (e) {}
            if (v) return "video";
            if (a) return "audio";
        }
        return "other";
    }
    function layerTypes() {
        var c = activeComp();
        if (!c) return R(false, "Open a composition first.", { hasComp: false });
        var counts = { all: c.numLayers }, i;
        for (i = 0; i < TYPES.length; i++) counts[TYPES[i][0]] = 0;
        for (i = 1; i <= c.numLayers; i++) { var t = typeOf(c.layer(i)); if (counts.hasOwnProperty(t)) counts[t]++; }
        return R(true, "\"" + c.name + "\": " + plural(c.numLayers, "layer"), { hasComp: true, comp: c.name, compId: c.id, counts: counts, types: TYPES });
    }
    function selectType(json) {
        var a = (typeof json === "string") ? JSON.parse(json) : (json || {}), type = String(a.type || "");
        var c = activeComp();
        if (!c) return R(false, "Open a composition first.");
        if (a.compId && c.id !== a.compId) return R(false, "Another composition is active now: press CHECK COMPOSITION again.");
        var name = type === "all" ? "layers" : null, n = 0, lockedN = 0, i;
        for (i = 0; i < TYPES.length; i++) if (TYPES[i][0] === type) name = TYPES[i][1].toLowerCase();
        if (!name) return R(false, "Unknown layer type " + type + ".");
        // like a selection made by hand, this is not an undo step
        for (i = 1; i <= c.numLayers; i++) { try { c.layer(i).selected = false; } catch (e0) {} }
        for (i = 1; i <= c.numLayers; i++) {
            var L = c.layer(i);
            if (type !== "all" && typeOf(L) !== type) continue;
            try { L.selected = true; n++; } catch (e1) { lockedN++; }
        }
        if (!n) return R(false, lockedN ? "The " + name + " are locked: unlock them to select them." : "No " + name + " in \"" + c.name + "\".", { count: 0 });
        return R(true, "Selected " + plural(n, "layer") + " (" + name + ") in \"" + c.name + "\"" + (lockedN ? " \u00B7 " + lockedN + " locked, not selected" : ""), { count: n });
    }

    // ------------------------------------------------------------------ organise project

    var DALA_FOLDER = /^(Dala |Dala Beat Check)/;
    function organise() {
        if (!app.project || app.project.numItems === 0) return R(false, "The project is empty.");
        var moved = 0, made = 0, removed = 0;
        app.beginUndoGroup("Dala Suite: Organise project");
        try {
            var P = app.project, i, j, root = P.rootFolder, items = [];
            function folderIn(parent, name) {
                for (var k = 1; k <= parent.numItems; k++) { var it = parent.item(k); if (it instanceof FolderItem && it.name === name) return it; }
                var f = P.items.addFolder(name);
                f.parentFolder = parent;
                made++;
                return f;
            }
            function inDalaFolder(it) {
                var f = it.parentFolder;
                while (f && f !== root) { if (DALA_FOLDER.test(f.name) || f.name === "Dala Suite") return true; f = f.parentFolder; }
                return false;
            }
            for (i = 1; i <= P.numItems; i++) items.push(P.item(i));
            var plan = [];
            for (i = 0; i < items.length; i++) {
                var it = items[i], where = null;
                if (it instanceof FolderItem || inDalaFolder(it)) continue;
                if (it instanceof CompItem) { var used = false; try { used = it.usedIn.length > 0; } catch (eU) {} where = used ? ["Compositions", "Precomps"] : ["Compositions"]; }
                else if (it instanceof FootageItem) {
                    var ms = it.mainSource;
                    if (ms instanceof SolidSource) where = ["Solids"];
                    else if ((ms instanceof PlaceholderSource) || it.footageMissing) where = ["Footage", "Missing"];
                    else if (ms.isStill) where = ["Footage", "Images"];
                    else if (it.hasVideo) where = ["Footage", "Video"];
                    else if (it.hasAudio) where = ["Footage", "Audio"];
                    else where = ["Footage", "Other"];
                }
                if (where) plan.push([it, where]);
            }
            var left = {};
            for (i = 0; i < plan.length; i++) {
                var f = root;
                for (j = 0; j < plan[i][1].length; j++) f = folderIn(f, plan[i][1][j]);
                var old = plan[i][0].parentFolder;
                if (old !== f) { if (old !== root) left[old.id] = old; plan[i][0].parentFolder = f; moved++; }
            }
            // the Dala Suite folders (SFX, downloads, beat checks...) together in one
            var dala = [];
            for (i = 1; i <= root.numItems; i++) { var d0 = root.item(i); if (d0 instanceof FolderItem && DALA_FOLDER.test(d0.name) && d0.name !== "Dala Suite") dala.push(d0); }
            if (dala.length) { var ds = folderIn(root, "Dala Suite"); for (i = 0; i < dala.length; i++) { dala[i].parentFolder = ds; moved++; } }
            // only the folders this emptied are removed (an empty folder the user made stays)
            var again = true;
            while (again) {
                again = false;
                for (var id in left) {
                    if (!left.hasOwnProperty(id)) continue;
                    var bf = left[id];
                    delete left[id];
                    try {
                        if (bf.numItems === 0) { var up = bf.parentFolder; bf.remove(); removed++; if (up && up !== root) left[up.id] = up; again = true; }
                    } catch (eR) {}
                }
            }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Organising failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(true, moved ? "Project organised: " + plural(moved, "item") + " moved into Compositions / Footage / Solids" + (made ? " (" + plural(made, "new folder") + ")" : "") +
            (removed ? " \u00B7 " + plural(removed, "emptied folder") + " removed" : "") + ". Footage links, comps and expressions are unchanged." : "The project is already organised.", { moved: moved, folders: made, removed: removed });
    }

    // ------------------------------------------------------------------ gap finder

    function gapClips(c) {
        var sel = c.selectedLayers, list = [], i;
        for (i = 0; i < sel.length; i++) if (isVideoClip(sel[i])) list.push(sel[i]);
        var fromSel = list.length > 0;
        if (!fromSel) for (i = 1; i <= c.numLayers; i++) if (isVideoClip(c.layer(i)) && c.layer(i).enabled) list.push(c.layer(i));
        return { clips: list, fromSel: fromSel };
    }
    function findGaps(c, clips) {
        var spans = [], i, out = [];
        for (i = 0; i < clips.length; i++) spans.push(vis(clips[i], c));
        spans.sort(function (x, y) { return x[0] - y[0]; });
        var end = spans.length ? spans[0][1] : 0;
        for (i = 1; i < spans.length; i++) {
            if (spans[i][0] > end) out.push({ from: end, to: spans[i][0] });
            end = Math.max(end, spans[i][1]);
        }
        return out;
    }
    function gaps(json) {
        var a = (typeof json === "string") ? JSON.parse(json) : (json || {});
        var c = activeComp();
        if (!c) return R(false, "Open the composition with the clips first.");
        var g = gapClips(c), clips = g.clips, list = findGaps(c, clips), i, j;
        function out(lst) {
            var o = [];
            for (var k = 0; k < lst.length; k++) o.push({ i: k, from: lst[k].from * fd(c), to: lst[k].to * fd(c), frames: lst[k].to - lst[k].from, tc: tc(lst[k].from * fd(c), c) });
            return o;
        }
        if (clips.length < 2) return R(false, g.fromSel ? "Select at least two video clips (or none, to check every clip)." : "This comp has fewer than two video clips.");
        var close = a.close;
        if (!close || close === "none") {
            return R(true, list.length ? plural(list.length, "gap") + " between " + (g.fromSel ? "the selected clips" : "the clips") : "No gaps between " + (g.fromSel ? "the selected clips" : "the clips"),
                { gaps: out(list), clips: clips.length, fromSel: g.fromSel, compId: c.id });
        }
        if (a.compId && c.id !== a.compId) return R(false, "Another composition is active now: press FIND GAPS again.");
        var pick = {};
        if (close === "all") for (i = 0; i < list.length; i++) pick[i] = true;
        else for (i = 0; i < close.length; i++) pick[Number(close[i])] = true;
        var lockedN = 0, closed = 0, frames = 0;
        app.beginUndoGroup("Dala Suite: Close gaps");
        try {
            // from the last gap back, so the earlier gaps keep their place: every clip that starts at or after a chosen
            // gap's end moves back by that gap's length
            for (i = list.length - 1; i >= 0; i--) {
                if (!pick[i]) continue;
                var len = list[i].to - list[i].from;
                closed++; frames += len;
                for (j = 0; j < clips.length; j++) {
                    var L = clips[j];
                    if (vis(L, c)[0] < list[i].to) continue;
                    if (L.locked) { lockedN++; continue; }
                    shiftFrames(L, -len, c);
                }
            }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Closing the gaps failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(closed > 0, closed ? "Closed " + plural(closed, "gap") + " (" + plural(frames, "frame") + "): the later clips moved back" + (lockedN ? " \u00B7 " + plural(lockedN, "locked clip") + " not moved - unlock them and close again" : "") : "No gap chosen.",
            { closed: closed, frames: frames, gaps: out(findGaps(c, clips)), compId: c.id });
    }

    // ------------------------------------------------------------------ black frames (timeline part)

    function covers(L) {
        if (!(L instanceof AVLayer) || !L.enabled || L.adjustmentLayer || L.nullLayer || L.guideLayer) return false;
        if ((L instanceof TextLayer) || (L instanceof ShapeLayer)) return false;
        try { if (!L.hasVideo) return false; } catch (e) { return false; }
        try { var o = L.property("ADBE Transform Group").property("ADBE Opacity"); if (o.numKeys === 0 && !o.expressionEnabled && o.value <= 0) return false; } catch (eO) {}
        var s = L.source;
        if (s instanceof CompItem) return true;
        if (!(s instanceof FootageItem)) return false;
        if (s.mainSource instanceof SolidSource) { var col = s.mainSource.color; return (col[0] + col[1] + col[2]) > 0.06; }     // a black solid is black
        return true;
    }
    function childTime(L, t) {
        if (L.timeRemapEnabled) { try { return L.timeRemap.valueAtTime(t, false); } catch (e) { return t - L.startTime; } }
        return (t - L.startTime) * 100 / L.stretch;
    }
    /** does a picture cover comp c at time t (a precomp: its own content at the time it plays) */
    function coveredAt(c, t, depth) {
        for (var i = 1; i <= c.numLayers; i++) {
            var L = c.layer(i);
            if (t < L.inPoint - c.frameDuration || t > L.outPoint + c.frameDuration) continue;
            if (!covers(L)) continue;
            var on = false;
            try { on = L.activeAtTime(t); } catch (e) { on = t >= L.inPoint && t < L.outPoint; }
            if (!on) continue;
            if (L.source instanceof CompItem) { if (depth < 6 && coveredAt(L.source, childTime(L, t), depth + 1)) return true; continue; }
            return true;
        }
        return false;
    }
    /** the footage pictures the comp plays, as file spans with comp time = a + b * file time (time-remapped: skipped) */
    function footageSpans(c, a, b, lo, hi, depth, out, skipped) {
        for (var i = 1; i <= c.numLayers; i++) {
            var L = c.layer(i);
            if (!covers(L)) continue;
            var l0 = Math.max(lo, a + b * L.inPoint), l1 = Math.min(hi, a + b * L.outPoint);
            if (l1 <= l0) continue;
            if (L.timeRemapEnabled || L.stretch <= 0) { skipped.n++; continue; }
            var A = a + b * L.startTime, B = b * L.stretch / 100;
            if (L.source instanceof CompItem) { if (depth < 6) footageSpans(L.source, A, B, l0, l1, depth + 1, out, skipped); continue; }
            var s = L.source;
            if (!(s.mainSource instanceof FileSource) || s.mainSource.isStill || !s.mainSource.file) continue;
            out.push({ file: s.mainSource.file.fsName, name: L.name, a: A, b: B, from: (l0 - A) / B, to: (l1 - A) / B, compFrom: l0, compTo: l1 });
        }
    }
    function blackScan(json) {
        var o = (typeof json === "string") ? JSON.parse(json) : (json || {});
        var c = activeComp();
        if (!c) return R(false, "Open the composition to scan first.");
        var lo = o.range === "work" ? c.workAreaStart : 0, hi = o.range === "work" ? c.workAreaStart + c.workAreaDuration : c.duration, i;
        // only from the first clip to the last: before the edit starts or after it ends is not "between clips"
        var first = 1e9, last = -1e9;
        for (i = 1; i <= c.numLayers; i++) { var L = c.layer(i); if (covers(L)) { first = Math.min(first, L.inPoint); last = Math.max(last, L.outPoint); } }
        if (first >= last) return R(false, "No clips in \"" + c.name + "\" to scan.");
        lo = Math.max(lo, first); hi = Math.min(hi, last);
        var f0 = Math.ceil(lo / c.frameDuration - 1e-6), f1 = Math.ceil(hi / c.frameDuration - 1e-6) - 1, empty = [], run = null;
        if (f1 - f0 > 200000) return R(false, "This span is too long to scan at once: set the work area over a part of it.");
        for (var f = f0; f <= f1; f++) {
            if (coveredAt(c, f * c.frameDuration, 0)) continue;
            if (run && run.to === f) run.to = f + 1; else { run = { from: f, to: f + 1 }; empty.push(run); }
        }
        var spans = [], skipped = { n: 0 };
        if (o.footage !== false) footageSpans(c, 0, 1, lo, hi, 0, spans, skipped);
        var e2 = [];
        for (i = 0; i < empty.length; i++) e2.push({ from: empty[i].from * c.frameDuration, to: empty[i].to * c.frameDuration, frames: empty[i].to - empty[i].from, tc: tc(empty[i].from * c.frameDuration, c) });
        return R(true, "ok", { empty: e2, spans: spans, remapped: skipped.n, fps: c.frameRate, frameDuration: c.frameDuration, compId: c.id, comp: c.name, from: lo, to: hi });
    }
    var BLACK_TAG = "dala-black";
    /** { compId, ranges: [{ from, to, frames, why }] } red comp markers on the black stretches (earlier ones replaced) */
    function blackMarkers(json) {
        var o = (typeof json === "string") ? JSON.parse(json) : (json || {});
        var c = activeComp();
        if (!c || (o.compId && c.id !== o.compId)) return R(false, "The scanned composition is not active any more.");
        var r = o.ranges || [], removed = 0, k;
        app.beginUndoGroup("Dala Suite: Black frame markers");
        try {
            var mk = c.markerProperty;
            for (k = mk.numKeys; k >= 1; k--) { try { if (mk.keyValue(k).getParameters().dala === BLACK_TAG) { mk.removeKey(k); removed++; } } catch (e0) {} }
            for (k = 0; k < r.length; k++) {
                var m = new MarkerValue("Black frame" + (r[k].frames > 1 ? "s (" + r[k].frames + ")" : "") + (r[k].why ? ": " + r[k].why : ""));
                m.duration = Math.max(0, r[k].to - r[k].from - c.frameDuration);
                try { m.label = 1; } catch (eL) {}
                m.setParameters({ dala: BLACK_TAG });
                mk.setValueAtTime(r[k].from, m);
            }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Adding the markers failed: " + e.toString());
        }
        app.endUndoGroup();
        return R(true, r.length ? "Marked " + plural(r.length, "black stretch") + " on the comp's timeline (red markers)" : (removed ? "Old black-frame markers removed" : "No black frames"), { count: r.length });
    }
    function goTo(json) {
        var o = (typeof json === "string") ? JSON.parse(json) : (json || {});
        var c = activeComp();
        if (!c) return R(false, "Open the composition first.");
        c.time = Number(o.time) || 0;
        return R(true, "At " + tc(c.time, c));
    }

    // ------------------------------------------------------------------ clean up (the panel does the files: js/general/cleanup.js)

    /** the open project and every file it uses (those are never cleaned up) */
    function cleanupInfo() {
        var files = [], i;
        if (app.project) for (i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            try { if (it instanceof FootageItem && it.mainSource instanceof FileSource && it.mainSource.file) files.push(it.mainSource.file.fsName); } catch (e) {}
            try { if (it.useProxy !== undefined && it.proxySource && it.proxySource.file) files.push(it.proxySource.file.fsName); } catch (eP) {}
        }
        return R(true, "ok", { project: (app.project && app.project.file) ? app.project.file.fsName : "", files: files, ae: app.version, userData: Folder.userData.fsName });
    }
    /** After Effects empties its memory and disk caches itself */
    function purgeCaches() {
        try { app.purge(PurgeTarget.ALL_CACHES); } catch (e) { return R(false, "Purge failed: " + e.toString()); }
        return R(true, "Caches purged");
    }

    return { beatCheck: beatCheck, arrangeClips: arrangeClips, sequence: sequence, layerTypes: layerTypes, selectType: selectType, organise: organise,
        gaps: gaps, blackScan: blackScan, blackMarkers: blackMarkers, goTo: goTo, cleanupInfo: cleanupInfo, purgeCaches: purgeCaches };
})();

