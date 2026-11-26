/**
 * Dala Suite - Decomp (GENERAL > Edit), ExtendScript ECMAScript 3. $._dalaSuite.unprecompose.run(json)
 *
 * json { removeItem }: puts the layers of each selected precomp layer back into the comp it sits in:
 *   - the precomp's layers are copied into the parent comp at the precomp layer's place in the stack, in the
 *     same order, with their effects, masks, keyframes, expressions and switches (Layer.copyToComp)
 *   - timing: shifted by the precomp layer's start time and trimmed to the part of the precomp that was
 *     visible (its in / out points); layers that were never visible are left out
 *   - parenting inside the precomp is restored without moving anything (setParentWithJump)
 *   - the precomp layer's own transform (anchor point, position, scale, rotation, keyframes included) is
 *     carried by a parent null, so everything stays exactly where it was on screen; no null is made when the
 *     precomp layer is untouched (centred, 100 %, no rotation, no keyframes, same size as the comp)
 *   - the precomp layer is removed; what cannot be carried onto separate layers (its opacity, effects, masks,
 *     blending mode, track matte, time remapping or time stretch) is named in the result as "not kept"
 *   - removeItem: the precomp is also deleted from the Project panel once nothing uses it any more
 * Nested precomps inside are kept as precomps (run Unprecompose again on them).
 */

$._dalaSuite.unprecompose = (function () {
    function R(ok, msg, data) { return $._dalaSuite.formatResult(ok, msg, data); }

    function isDefaultTransform(L, inner, comp) {
        var tg = L.property("ADBE Transform Group");
        var mns = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y"];
        for (var i = 0; i < mns.length; i++) {
            var p = tg.property(mns[i]);
            if (p && (p.numKeys > 0 || (p.canSetExpression && p.expression && p.expressionEnabled))) return false;
        }
        try { if (tg.property("ADBE Position").dimensionsSeparated) return false; } catch (eS) {}
        var a = tg.property("ADBE Anchor Point").value, pos = tg.property("ADBE Position").value, sc = tg.property("ADBE Scale").value;
        if (Math.abs(a[0] - inner.width / 2) > 0.01 || Math.abs(a[1] - inner.height / 2) > 0.01) return false;
        if (Math.abs(pos[0] - comp.width / 2) > 0.01 || Math.abs(pos[1] - comp.height / 2) > 0.01) return false;
        if (Math.abs(sc[0] - 100) > 0.001 || Math.abs(sc[1] - 100) > 0.001) return false;
        if (Math.abs(tg.property("ADBE Rotate Z").value) > 0.0001) return false;
        if (L.threeDLayer) return false;
        if (Math.abs(inner.pixelAspect - comp.pixelAspect) > 0.0001) return false;
        return true;
    }

    /** Copies one transform property's value / keyframes / expression from the precomp layer to the null. */
    function copyProp(src, dst) {
        if (!src || !dst) return;
        try {
            if (src.dimensionsSeparated && !dst.dimensionsSeparated) dst.dimensionsSeparated = true;
        } catch (eS) {}
        try {
            if (src.numKeys > 0) {
                for (var k = 1; k <= src.numKeys; k++) {
                    var t = src.keyTime(k);
                    dst.setValueAtTime(t, src.keyValue(k));
                    var idx = dst.nearestKeyIndex(t);
                    try { dst.setInterpolationTypeAtKey(idx, src.keyInInterpolationType(k), src.keyOutInterpolationType(k)); } catch (e1) {}
                    try { dst.setTemporalEaseAtKey(idx, src.keyInTemporalEase(k), src.keyOutTemporalEase(k)); } catch (e2) {}
                    try { if (src.isSpatial) dst.setSpatialTangentsAtKey(idx, src.keyInSpatialTangent(k), src.keyOutSpatialTangent(k)); } catch (e3) {}
                }
            } else if (!src.dimensionsSeparated) {
                dst.setValue(src.value);
            }
        } catch (eV) {}
        try { if (src.canSetExpression && src.expression) { dst.expression = src.expression; dst.expressionEnabled = src.expressionEnabled; } } catch (eX) {}
    }

    /** What the precomp layer does that separate layers cannot inherit. */
    function leftovers(L) {
        var out = [], tg = L.property("ADBE Transform Group"), op = tg.property("ADBE Opacity");
        if (op.numKeys > 0 || op.value < 100 || (op.expression && op.expressionEnabled)) out.push("opacity");
        try { if (L.property("ADBE Effect Parade").numProperties > 0) out.push("effects"); } catch (e1) {}
        try { if (L.property("ADBE Mask Parade").numProperties > 0) out.push("masks"); } catch (e2) {}
        try { if (L.blendingMode !== BlendingMode.NORMAL) out.push("blending mode"); } catch (e3) {}
        try { if (L.trackMatteType !== TrackMatteType.NO_TRACK_MATTE || L.isTrackMatte) out.push("track matte"); } catch (e4) {}
        try { if (L.timeRemapEnabled) out.push("time remapping"); } catch (e5) {}
        try { if (Math.abs(L.stretch - 100) > 0.001) out.push("time stretch"); } catch (e6) {}
        return out;
    }

    // After Effects refuses to copy a layer that has a parent or an expression linked to another layer while
    // an undo group is open. Inside the precomp, parents and expressions are lifted for the copy (without
    // moving anything) and put back afterwards - on the originals and on the copies.
    function exprList(g, path, out) {
        for (var i = 1; i <= g.numProperties; i++) {
            var p = g.property(i);
            if (!p) continue;
            if (p.propertyType === PropertyType.PROPERTY) {
                try { if (p.canSetExpression && p.expression) out.push({ path: path.concat([i]), e: p.expression, on: p.expressionEnabled }); } catch (e) {}
            } else exprList(p, path.concat([i]), out);
        }
        return out;
    }
    function propAt(L, path) { var p = L; for (var i = 0; i < path.length; i++) p = p.property(path[i]); return p; }
    function setExprs(L, list) {
        for (var i = 0; i < list.length; i++) {
            try { var p = propAt(L, list[i].path); p.expression = list[i].e; p.expressionEnabled = list[i].on; } catch (e) {}
        }
    }
    function clearExprs(L, list) {
        for (var i = 0; i < list.length; i++) { try { propAt(L, list[i].path).expression = ""; } catch (e) {} }
    }

    function one(comp, L, removeItem) {
        var inner = L.source, n = inner.numLayers, i;
        if (!n) return { ok: false, msg: "\"" + L.name + "\" is an empty precomp." };
        var left = leftovers(L);
        var needNull = !isDefaultTransform(L, inner, comp) || inner.width !== comp.width || inner.height !== comp.height;
        // copies land directly above the selected layer: select only the precomp layer and copy top to bottom
        var sel = comp.selectedLayers;
        for (i = 0; i < sel.length; i++) { try { sel[i].selected = false; } catch (eS) {} }
        L.selected = true;
        var parentIdx = [], exprs = [], made = 0;
        for (i = 1; i <= n; i++) {
            var src0 = inner.layer(i);
            parentIdx.push(src0.parent ? src0.parent.index : 0);
            exprs.push(exprList(src0, [], []));
        }
        function restoreInner() {
            for (var r = 1; r <= n; r++) {
                var o = inner.layer(r);
                try { if (parentIdx[r - 1]) o.setParentWithJump(inner.layer(parentIdx[r - 1])); } catch (eR1) {}
                setExprs(o, exprs[r - 1]);
            }
        }
        try {
            for (i = 1; i <= n; i++) {
                var src = inner.layer(i);
                clearExprs(src, exprs[i - 1]);
                try { if (src.parent) src.setParentWithJump(null); } catch (eUp) {}
            }
            for (i = 1; i <= n; i++) {
                inner.layer(i).copyToComp(comp);
                made++;
                // the copy sits right above the precomp layer; keep only the precomp layer selected for the next one
                try { comp.layer(L.index - 1).selected = false; } catch (eD) {}
                try { L.selected = true; } catch (eD2) {}
            }
        } catch (eCopy) {
            for (i = 0; i < made; i++) { try { comp.layer(L.index - 1).remove(); } catch (eCl) {} }
            restoreInner();
            throw eCopy;
        }
        restoreInner();
        var startIdx = L.index - n, copies = [];
        for (i = 0; i < n; i++) copies.push(comp.layer(startIdx + i));
        var offset = L.startTime, vin = L.inPoint, vout = L.outPoint, removed = 0;
        for (i = 0; i < n; i++) {
            var c = copies[i];
            try { c.selected = false; } catch (eS2) {}
            try { c.startTime = c.startTime + offset; } catch (eT) {}
        }
        for (i = 0; i < n; i++) setExprs(copies[i], exprs[i]);
        // parents inside the precomp, without moving anything
        for (i = 0; i < n; i++) {
            if (parentIdx[i] && copies[parentIdx[i] - 1]) {
                try { copies[i].setParentWithJump(copies[parentIdx[i] - 1]); } catch (eP) { try { copies[i].parent = copies[parentIdx[i] - 1]; } catch (eP2) {} }
            }
        }
        var nul = null;
        if (needNull) {
            nul = comp.layers.addNull(Math.max(comp.frameDuration, vout - vin));
            nul.name = L.name + " (transform)";
            nul.moveBefore(copies[0]);
            nul.startTime = 0;
            nul.inPoint = vin; nul.outPoint = vout;
            try { nul.threeDLayer = L.threeDLayer; } catch (e3d) {}
            var ntg = nul.property("ADBE Transform Group"), ltg = L.property("ADBE Transform Group");
            // an identity parent first, so parenting changes nothing; then the precomp layer's transform
            try { ntg.property("ADBE Anchor Point").setValue(L.threeDLayer ? [0, 0, 0] : [0, 0]); ntg.property("ADBE Position").setValue(L.threeDLayer ? [0, 0, 0] : [0, 0]); } catch (eId) {}
            for (i = 0; i < n; i++) {
                if (!parentIdx[i]) { try { copies[i].setParentWithJump(nul); } catch (eJ) { try { copies[i].parent = nul; } catch (eJ2) {} } }
            }
            var mns = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"];
            for (var m = 0; m < mns.length; m++) copyProp(ltg.property(mns[m]), ntg.property(mns[m]));
            try {
                if (ltg.property("ADBE Position").dimensionsSeparated) {
                    copyProp(ltg.property("ADBE Position_0"), ntg.property("ADBE Position_0"));
                    copyProp(ltg.property("ADBE Position_1"), ntg.property("ADBE Position_1"));
                    if (L.threeDLayer) copyProp(ltg.property("ADBE Position_2"), ntg.property("ADBE Position_2"));
                }
            } catch (eSep) {}
            try { if (L.parent) nul.setParentWithJump(L.parent); } catch (eLP) {}
        }
        // keep only what was visible through the precomp layer
        for (i = n - 1; i >= 0; i--) {
            var cc = copies[i];
            var a = Math.max(cc.inPoint, vin), b = Math.min(cc.outPoint, vout);
            if (b - a < comp.frameDuration * 0.5) { try { cc.remove(); removed++; } catch (eR) {} continue; }
            try { cc.inPoint = a; cc.outPoint = b; } catch (eIO) {}
        }
        var name = L.name, deleted = false;
        L.remove();
        if (removeItem) { try { if (inner.usedIn.length === 0) { inner.remove(); deleted = true; } } catch (eDel) {} }
        return { ok: true, layers: n - removed, nul: !!nul, lost: left, name: name, deleted: deleted };
    }

    function run(json) {
        var o = (typeof json === "string") ? JSON.parse(json) : (json || {});
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return R(false, "Open the composition that holds the precomp layer, then select it.");
        var sel = comp.selectedLayers, targets = [], i, j;
        for (i = 0; i < sel.length; i++) if (sel[i].source && sel[i].source instanceof CompItem) targets.push(sel[i]);
        if (!targets.length) return R(false, sel.length ? "Select a precomp layer: Decomp brings its layers back into this comp." : "Select the precomp layer to decompose.");
        app.beginUndoGroup("Dala Suite: Decompose");
        var done = 0, notes = [], total = 0, lost = [], deleted = 0;
        try {
            // bottom to top, so the layer indexes of the ones still to do stay valid
            targets.sort(function (a, b) { return b.index - a.index; });
            for (i = 0; i < targets.length; i++) {
                var r = one(comp, targets[i], !!o.removeItem);
                if (!r.ok) { notes.push(r.msg); continue; }
                done++;
                total += r.layers;
                if (r.deleted) deleted++;
                for (j = 0; j < r.lost.length; j++) { var seen = false; for (var k = 0; k < lost.length; k++) if (lost[k] === r.lost[j]) seen = true; if (!seen) lost.push(r.lost[j]); }
            }
        } catch (e) {
            app.endUndoGroup();
            return R(false, "Decomp stopped: " + e.toString() + " (Ctrl+Z restores everything).");
        }
        app.endUndoGroup();
        if (!done) return R(false, notes.join(" "));
        var msg = total + " layer" + (total === 1 ? "" : "s") + " back in the comp" + (done > 1 ? " from " + done + " precomps" : "");
        if (lost.length) msg += " \u00B7 not kept: " + lost.join(", ");
        if (deleted) msg += " \u00B7 precomp" + (deleted === 1 ? "" : "s") + " deleted from the project";
        if (notes.length) msg += " (" + notes.join(" ") + ")";
        return R(true, msg, { precomps: done, layers: total, lost: lost, notes: notes, deleted: deleted });
    }

    return { run: run };
})();
