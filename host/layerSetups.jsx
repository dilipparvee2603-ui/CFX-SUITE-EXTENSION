/**
 * Dala Suite - Layer Setups (ExtendScript, ECMAScript 3)
 *
 * Saves the selected layers (any mix of text, shape, solid, adjustment, null, camera, light, footage and
 * precomp layers - precomps with everything inside them) as a named setup, and builds it again in any comp
 * of any project, later or after restarting After Effects. Setups are layer recipes (host/layerRecipe.jsx)
 * stored as JSON files in %APPDATA%\DalaSuite\LayerSetups, one file per setup.
 *   list()                      saved setups, newest first
 *   save({name})                the active comp's selected layers -> a new setup
 *   apply({id, at:'cti'|'original'})   builds the setup in the active comp (a new comp when none is open)
 *   rename({id, name}) / remove({id})
 * Applying reports what could not be rebuilt: footage whose file is gone (a placeholder solid stands in),
 * effects / plug-ins that are not installed, settings newer than this After Effects.
 */

$._dalaSuite.setups = (function () {
    function R(ok, msg, data) { return $._dalaSuite.formatResult(ok, msg, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : (json || {}); }

    function dir() {
        var f = new Folder(Folder.userData.fsName + "/DalaSuite/LayerSetups");
        if (!f.exists) { new Folder(Folder.userData.fsName + "/DalaSuite").create(); f.create(); }
        return f;
    }
    function safeId(id) { return String(id).replace(/[^A-Za-z0-9_\-]/g, ""); }
    function fileFor(id) { return new File(dir().fsName + "/" + safeId(id) + ".json"); }
    // a small sidecar with the name and summary: listing never parses the (large) setups themselves -
    // ExtendScript has no native JSON, and parsing a few hundred KB takes seconds
    function metaFor(id) { return new File(dir().fsName + "/" + safeId(id) + ".meta.json"); }
    function metaOf(set) {
        return { id: set.meta.id, name: set.meta.name, created: set.meta.created, comp: set.meta.comp, project: set.meta.project,
            size: set.compSize, fps: set.fps, count: set.meta.count, kinds: set.meta.kinds, ae: set.ae };
    }
    function readJson(f) {
        f.encoding = "UTF-8";
        if (!f.open("r")) return null;
        var s = f.read(); f.close();
        try { return $._dalaSuite.parseOwnJson(s); } catch (e) { return null; }
    }
    function writeJson(f, obj) {
        var tmp = new File(f.fsName + ".part");
        tmp.encoding = "UTF-8";
        if (!tmp.open("w")) throw new Error("Cannot write " + tmp.fsName + " (is the folder read-only?)");
        tmp.write(JSON.stringify(obj));
        tmp.close();
        if (f.exists) f.remove();
        if (!tmp.rename(f.name)) throw new Error("Cannot save " + f.fsName);
    }

    function summary(set) {
        var kinds = {}, n = 0, i;
        for (i = 0; i < set.layers.length; i++) { kinds[set.layers[i].kind] = (kinds[set.layers[i].kind] || 0) + 1; n++; }
        var parts = [];
        for (var k in kinds) if (kinds.hasOwnProperty(k)) parts.push(kinds[k] + " " + k);
        return { count: n, kinds: parts.join(", ") };
    }

    function list() {
        try {
            var files = dir().getFiles("*.json"), out = [], i;
            for (i = 0; i < files.length; i++) {
                var nm = files[i].name;
                if (/\.meta\.json$/i.test(nm) || /\.part$/i.test(nm)) continue;
                var id = nm.replace(/\.json$/i, ""), mf = metaFor(id), m = mf.exists ? readJson(mf) : null;
                if (!m) {                                    // older setup: make its sidecar once
                    var o = readJson(files[i]);
                    if (!o || !o.meta) continue;
                    m = metaOf(o);
                    try { writeJson(mf, m); } catch (eW) {}
                }
                out.push(m);
            }
            out.sort(function (a, b) { return a.created < b.created ? 1 : -1; });
            return R(true, out.length + " saved setup" + (out.length === 1 ? "" : "s"), { setups: out, folder: dir().fsName });
        } catch (e) { return R(false, "Could not read the saved setups: " + e.toString()); }
    }

    function save(json) {
        var a = parse(json);
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return R(false, "Open a composition and select the layers to save.");
        var sel = comp.selectedLayers;
        if (!sel.length) return R(false, "Select the layers (or precomps) to save as a setup first.");
        var name = String(a.name || "").replace(/^\s+|\s+$/g, "");
        if (!name) name = sel.length === 1 ? sel[0].name : comp.name + " (" + sel.length + " layers)";
        try {
            var set = $._dalaSuite.recipe.serializeLayers(comp, sel);
            var id = "s" + new Date().getTime() + Math.floor(Math.random() * 1000);
            var sm = summary(set);
            set.meta = { id: id, name: name, created: new Date().toUTCString(), createdMs: new Date().getTime(), comp: comp.name,
                project: app.project.file ? app.project.file.name : "Untitled", count: sm.count, kinds: sm.kinds };
            writeJson(fileFor(id), set);
            writeJson(metaFor(id), metaOf(set));
            return R(true, "Saved \"" + name + "\" (" + sm.count + " layer" + (sm.count === 1 ? "" : "s") + ").", { id: id });
        } catch (e) { return R(false, "Saving the setup failed: " + e.toString() + (e.line ? " (line " + e.line + ")" : "")); }
    }

    function apply(json) {
        var a = parse(json);
        var f = fileFor(a.id);
        if (!f.exists) return R(false, "That setup no longer exists (deleted from " + dir().fsName + ").");
        var set = readJson(f);
        if (!set || !set.layers) return R(false, "The setup file is damaged and cannot be read: " + f.fsName);
        var comp = app.project.activeItem, made = false;
        app.beginUndoGroup("Dala Suite: Apply setup");
        try {
            if (!comp || !(comp instanceof CompItem)) {
                var sz = set.compSize || [1920, 1080];
                comp = app.project.items.addComp(set.meta.name, sz[0], sz[1], 1, 30, set.fps || 30);
                comp.openInViewer();
                made = true;
            }
            var sel = comp.selectedLayers;
            for (var s = 0; s < sel.length; s++) { try { sel[s].selected = false; } catch (eS) {} }
            var folder = null;
            var hasComps = false;
            for (var k in set.comps) if (set.comps.hasOwnProperty(k)) hasComps = true;
            if (hasComps) folder = app.project.items.addFolder(set.meta.name + " (Dala setup)");
            var at = a.at === "original" ? null : comp.time;
            var res = $._dalaSuite.recipe.buildLayers(comp, set, { at: at, folder: folder });
            for (var i = 0; i < res.layers.length; i++) { try { res.layers[i].selected = true; } catch (eSel) {} }
            app.endUndoGroup();
            var w = res.warnings || [];
            var fit = (set.compSize && (set.compSize[0] !== comp.width || set.compSize[1] !== comp.height)) ?
                " It was saved in a " + set.compSize[0] + "x" + set.compSize[1] + " comp; positions are kept as saved." : "";
            return R(true, "Applied \"" + set.meta.name + "\": " + res.layers.length + " layer" + (res.layers.length === 1 ? "" : "s") +
                (made ? " in a new comp" : "") + "." + fit + (w.length ? " " + w.join(" ") : ""), { made: res.layers.length, warnings: w });
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Applying the setup failed: " + e.toString() + (e.line ? " (line " + e.line + ")" : "") + " - Edit > Undo removes what was added.");
        }
    }

    function rename(json) {
        var a = parse(json), f = fileFor(a.id), name = String(a.name || "").replace(/^\s+|\s+$/g, "");
        if (!name) return R(false, "Type a name first.");
        var set = f.exists ? readJson(f) : null;
        if (!set) return R(false, "That setup no longer exists.");
        try { set.meta.name = name; writeJson(f, set); writeJson(metaFor(a.id), metaOf(set)); return R(true, "Renamed to \"" + name + "\"."); }
        catch (e) { return R(false, "Renaming failed: " + e.toString()); }
    }

    function remove(json) {
        var a = parse(json), f = fileFor(a.id);
        var mf = metaFor(a.id);
        if (mf.exists) mf.remove();
        if (!f.exists) return R(true, "Already deleted.");
        return f.remove() ? R(true, "Deleted.") : R(false, "Could not delete " + f.fsName + " (in use or read-only).");
    }

    return { list: list, save: save, apply: apply, rename: rename, remove: remove };
})();
