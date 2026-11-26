/**
 * Dala Suite - GENERAL > Anchor Point, Align and Gradient Lock, host side (ExtendScript, ECMAScript 3). $._dalaSuite.layout
 *   anchor(json)     { x: 0 | 0.5 | 1, y: 0 | 0.5 | 1, lock } the anchor point of every selected layer moves to that
 *                    point of the layer's own bounds (sourceRectAtTime: text and shapes follow their content) and the
 *                    position is moved with it, so nothing moves on screen. lock: an expression keeps the anchor on
 *                    that point of the bounds at every frame - text edits, new shapes, keyframes on other properties
 *   align(json)      { h: left | center | right, v: top | middle | bottom, to: comp | selection | auto, lock } moves the
 *                    selected layers so their bounds line up with the comp (or with the selection's bounds); one
 *                    axis or both. lock (comp, 2D layers without a parent): an expression on the position keeps the
 *                    layer aligned at every frame - text edits, scale and rotation changes
 *   gradient(json)   { lock } Gradient Ramp / 4-Color Gradient points and shape gradient fill / stroke start and end
 *                    points keep their place inside the layer's bounds at every frame (lock), or are released
 *   unlock(json)     { what: anchor | align | gradient } removes Dala's locks from the selected layers; they stay
 *                    exactly where they are
 * Geometry is computed (world = parent chain of P + Orientation * Rx * Ry * Rz * Scale * (p - Anchor)), not read back
 * from expressions: reading expression results from a script is unreliable in After Effects 2025. Every action is
 * one undo step.
 */

$._dalaSuite.layout = (function () {
    var LOCK_ANCHOR = "// Dala Suite: anchor lock", LOCK_ALIGN = "// Dala Suite: align lock", LOCK_GRAD = "// Dala Suite: gradient lock";

    function R(ok, msg, data) { return $._dalaSuite.formatResult(ok, msg, data); }
    function parse(json) { return (typeof json === "string") ? JSON.parse(json) : (json || {}); }
    function activeComp() { var c = app.project.activeItem; return (c && c instanceof CompItem) ? c : null; }
    function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
    function tg(L) { return L.property("ADBE Transform Group"); }
    function isCamLight(L) { return (L instanceof CameraLayer) || (L instanceof LightLayer); }
    function num(x) { return Math.round(x * 1e6) / 1e6; }

    function undoable(name, fn) {
        var c = activeComp();
        if (!c) return R(false, "Open a composition first.");
        app.beginUndoGroup("Dala Suite: " + name);
        var out;
        try { out = fn(c); } catch (e) { app.endUndoGroup(); return R(false, name + " failed: " + (e.message || e) + (e.line ? " (line " + e.line + ")" : "")); }
        app.endUndoGroup();
        return out;
    }

    // ------------------------------------------------------------------ 3 x 3 matrices

    function mul(A, B) {
        var C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], i, j, k;
        for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) for (k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j];
        return C;
    }
    function apply(M, v) { return [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]]; }
    function inv(M) {
        var a = M[0][0], b = M[0][1], c = M[0][2], d = M[1][0], e = M[1][1], f = M[1][2], g = M[2][0], h = M[2][1], k = M[2][2];
        var A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
        if (Math.abs(det) < 1e-12) return null;
        return [[A / det, -(b * k - c * h) / det, (b * f - c * e) / det],
                [B / det, (a * k - c * g) / det, -(a * f - c * d) / det],
                [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
    }
    function rx(deg) { var t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
    function ry(deg) { var t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
    function rz(deg) { var t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }
    function v3(v) { return [v[0], v[1], v.length > 2 ? v[2] : 0]; }
    function val(p, t) { try { return p.valueAtTime(t, false); } catch (e) { return p.value; } }

    /** the layer's own linear transform (rotation x scale) at time t */
    function linear(L, t) {
        var T = tg(L), s = v3(val(T.property("ADBE Scale"), t)), S = [[s[0] / 100, 0, 0], [0, s[1] / 100, 0], [0, 0, (L.threeDLayer ? s[2] : 100) / 100]];
        var Rm = rz(val(T.property("ADBE Rotate Z"), t));
        if (L.threeDLayer) {
            var o = val(T.property("ADBE Orientation"), t);
            Rm = mul(mul(mul(rx(o[0]), ry(o[1])), rz(o[2])), mul(mul(rx(val(T.property("ADBE Rotate X"), t)), ry(val(T.property("ADBE Rotate Y"), t))), Rm));
        }
        return mul(Rm, S);
    }
    function position(L, t) {
        var T = tg(L), p = T.property("ADBE Position");
        if (p.dimensionsSeparated) return [val(T.property("ADBE Position_0"), t), val(T.property("ADBE Position_1"), t), L.threeDLayer ? val(T.property("ADBE Position_2"), t) : 0];
        return v3(val(p, t));
    }
    /** a point of the layer's own space -> comp space */
    function toWorld(L, pt, t) {
        var q = pt, P = L;
        while (P) {
            var A = v3(val(tg(P).property("ADBE Anchor Point"), t)), M = linear(P, t), pos = position(P, t);
            var r = apply(M, [q[0] - A[0], q[1] - A[1], q[2] - A[2]]);
            q = [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]];
            P = P.parent;
        }
        return q;
    }
    /** linear map from the layer's PARENT space to comp space (identity without a parent) */
    function parentLinear(L, t) {
        var M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], P = L.parent, chain = [];
        while (P) { chain.push(P); P = P.parent; }
        for (var i = chain.length - 1; i >= 0; i--) M = mul(M, linear(chain[i], t));
        return M;
    }

    function rectOf(L, t) {
        var r = null;
        try { r = L.sourceRectAtTime(t, false); } catch (e) { r = null; }
        if ((!r || (r.width === 0 && r.height === 0)) && L.source && L.source.width) r = { left: 0, top: 0, width: L.source.width, height: L.source.height };
        return r;
    }
    function bounds(L, t) {
        var r = rectOf(L, t);
        if (!r) return null;
        var pts = [[r.left, r.top, 0], [r.left + r.width, r.top, 0], [r.left, r.top + r.height, 0], [r.left + r.width, r.top + r.height, 0]];
        var b = { l: 1e12, t: 1e12, r: -1e12, b: -1e12 };
        for (var i = 0; i < 4; i++) {
            var w = toWorld(L, pts[i], t);
            b.l = Math.min(b.l, w[0]); b.r = Math.max(b.r, w[0]); b.t = Math.min(b.t, w[1]); b.b = Math.max(b.b, w[1]);
        }
        return b;
    }

    /** adds d (parent space) to the position: every keyframe, or the value; per-key deltas when dAt(t) is given */
    function shiftPosition(L, d, dAt) {
        var T = tg(L), p = T.property("ADBE Position"), k;
        function one(prop, i) {
            if (prop.numKeys === 0) {
                var v = prop.valueAtTime(L.containingComp.time, true);
                prop.setValue(typeof v === "number" ? v + d[i] : addv(v, d));
                return;
            }
            for (k = 1; k <= prop.numKeys; k++) {
                var dk = dAt ? dAt(prop.keyTime(k)) : d, kv = prop.keyValue(k);
                prop.setValueAtKey(k, typeof kv === "number" ? kv + dk[i] : addv(kv, dk));
            }
        }
        if (p.dimensionsSeparated) {
            one(T.property("ADBE Position_0"), 0);
            one(T.property("ADBE Position_1"), 1);
            if (L.threeDLayer) one(T.property("ADBE Position_2"), 2);
        } else one(p, -1);
    }
    function addv(v, d) { var o = []; for (var i = 0; i < v.length; i++) o.push(v[i] + (d[i] || 0)); return o; }
    function hasLock(p, tag) { try { return p.expression.indexOf(tag) === 0; } catch (e) { return false; } }
    function clearExpr(p) { try { p.expression = ""; } catch (e) {} }
    // (in ExtendScript a text or shape layer is not "instanceof AVLayer")
    function isAV(L) { return (L instanceof AVLayer) || (L instanceof TextLayer) || (L instanceof ShapeLayer); }
    function usable(L) { return isAV(L) && !isCamLight(L); }

    // ------------------------------------------------------------------ anchor point

    function anchorExpr(x, y) {
        return LOCK_ANCHOR + " " + x + " " + y + "\nvar r = sourceRectAtTime(time, false);\nvar a = [r.left + r.width * " + x + ", r.top + r.height * " + y + "];\n" +
            "value.length > 2 ? [a[0], a[1], value[2]] : a";
    }

    /** moves L's anchor to the (x, y) point of its bounds at time t without moving the layer; returns true if done */
    function moveAnchor(L, x, y, t, lock) {
        var T = tg(L), ap = T.property("ADBE Anchor Point"), r = rectOf(L, t);
        if (!r) return false;
        var cur = v3(ap.valueAtTime(t, false)), want = [r.left + r.width * x, r.top + r.height * y, cur[2]];
        var delta = [want[0] - cur[0], want[1] - cur[1], 0];
        var wasLocked = hasLock(ap, LOCK_ANCHOR);
        clearExpr(ap);
        if (ap.numKeys === 0) ap.setValue(L.threeDLayer ? want : [want[0], want[1]]);
        else for (var k = 1; k <= ap.numKeys; k++) ap.setValueAtKey(k, addv(ap.keyValue(k), delta));
        if (Math.abs(delta[0]) > 1e-9 || Math.abs(delta[1]) > 1e-9)
            shiftPosition(L, apply(linear(L, t), delta), function (tk) { return apply(linear(L, tk), delta); });
        if (lock) ap.expression = anchorExpr(x, y);
        return { moved: true, wasLocked: wasLocked };
    }

    function anchor(json) {
        var a = parse(json), x = Number(a.x), y = Number(a.y), lock = !!a.lock;
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return R(false, "Unknown anchor point.");
        return undoable(lock ? "Anchor point (locked)" : "Anchor point", function (c) {
            var sel = c.selectedLayers, n = 0, skipped = 0, locked = 0, i;
            if (!sel.length) return R(false, "Select the layers to move the anchor point on.");
            for (i = 0; i < sel.length; i++) {
                var L = sel[i];
                if (!usable(L)) { skipped++; continue; }
                if (L.locked) { locked++; continue; }
                if (moveAnchor(L, x, y, c.time, lock)) n++; else skipped++;
            }
            var where = [["top left", "top", "top right"], ["left", "centre", "right"], ["bottom left", "bottom", "bottom right"]][Math.round(y * 2)][Math.round(x * 2)];
            if (!n) return R(false, locked ? "The selected layers are locked." : "Cameras and lights have no anchor to move.");
            return R(true, "Anchor point on the " + where + " of " + plural(n, "layer") + (lock ? " \u00B7 locked: it stays there when the text or shape changes" : "") +
                (locked ? " \u00B7 " + plural(locked, "locked layer") + " left" : "") + (skipped ? " \u00B7 " + plural(skipped, "camera / light") + " skipped" : ""), { count: n });
        });
    }

    // ------------------------------------------------------------------ align

    function alignExpr(h, v, separated) {
        var lines = [LOCK_ALIGN + " h=" + (h || "-") + " v=" + (v || "-"),
            "var r = sourceRectAtTime(time, false), a = anchorPoint, s = scale, t = rotation * Math.PI / 180;",
            "var c = Math.cos(t), n = Math.sin(t), sx = s[0] / 100, sy = s[1] / 100, xs = [], ys = [];",
            "var pts = [[r.left, r.top], [r.left + r.width, r.top], [r.left, r.top + r.height], [r.left + r.width, r.top + r.height]];",
            "for (var i = 0; i < 4; i++) { var dx = (pts[i][0] - a[0]) * sx, dy = (pts[i][1] - a[1]) * sy; xs.push(dx * c - dy * n); ys.push(dx * n + dy * c); }",
            "var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);"];
        // (a lookup, not chained ?: - ExtendScript mis-evaluates unbracketed chained ternaries)
        var HX = { left: "-x0", center: "thisComp.width / 2 - (x0 + x1) / 2", right: "thisComp.width - x1" };
        var VY = { top: "-y0", middle: "thisComp.height / 2 - (y0 + y1) / 2", bottom: "thisComp.height - y1" };
        var hx = (h && HX.hasOwnProperty(h)) ? HX[h] : null, vy = (v && VY.hasOwnProperty(v)) ? VY[v] : null;
        if (separated === 0) lines.push(hx || "value");
        else if (separated === 1) lines.push(vy || "value");
        else lines.push("var p = value, x = " + (hx || "p[0]") + ", y = " + (vy || "p[1]") + ";", "p.length > 2 ? [x, y, p[2]] : [x, y]");
        return lines.join("\n");
    }
    function lockAlign(L, h, v) {
        var T = tg(L), p = T.property("ADBE Position");
        if (p.dimensionsSeparated) {
            if (h) T.property("ADBE Position_0").expression = alignExpr(h, null, 0);
            if (v) T.property("ADBE Position_1").expression = alignExpr(null, v, 1);
        } else p.expression = alignExpr(h, v, -1);
    }
    function alignLockOf(L) {
        var T = tg(L), p = T.property("ADBE Position"), props = p.dimensionsSeparated ? [T.property("ADBE Position_0"), T.property("ADBE Position_1")] : [p], out = null;
        for (var i = 0; i < props.length; i++) {
            if (!hasLock(props[i], LOCK_ALIGN)) continue;
            var m = /h=(\w+|-) v=(\w+|-)/.exec(props[i].expression) || [];
            out = out || { props: [] };
            if (m[1] && m[1] !== "-") out.h = m[1];
            if (m[2] && m[2] !== "-") out.v = m[2];
            out.props.push(props[i]);
        }
        return out;
    }

    /** moves L (in comp space) so its bounds line up with box on h / v; returns true if it moved or was in place */
    function alignOne(L, box, h, v, t) {
        var b = bounds(L, t);
        if (!b) return false;
        var dx = 0, dy = 0;
        if (h === "left") dx = box.l - b.l; else if (h === "center") dx = (box.l + box.r) / 2 - (b.l + b.r) / 2; else if (h === "right") dx = box.r - b.r;
        if (v === "top") dy = box.t - b.t; else if (v === "middle") dy = (box.t + box.b) / 2 - (b.t + b.b) / 2; else if (v === "bottom") dy = box.b - b.b;
        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return true;
        var Mi = inv(parentLinear(L, t));
        if (!Mi) return false;
        shiftPosition(L, apply(Mi, [dx, dy, 0]));
        return true;
    }

    function align(json) {
        var a = parse(json), h = a.h || null, v = a.v || null, lock = !!a.lock;
        if (!h && !v) return R(false, "Choose how to align.");
        return undoable(lock ? "Align (locked)" : "Align", function (c) {
            var sel = c.selectedLayers, list = [], locked = 0, i, t = c.time;
            for (i = 0; i < sel.length; i++) { if (!usable(sel[i])) continue; if (sel[i].locked) { locked++; continue; } list.push(sel[i]); }
            if (!list.length) return R(false, sel.length ? (locked ? "The selected layers are locked." : "Cameras and lights cannot be aligned.") : "Select the layers to align.");
            var to = a.to === "selection" || (a.to !== "comp" && list.length > 1) ? "selection" : "comp";
            var box = { l: 0, t: 0, r: c.width, b: c.height };
            // a lock replaces an earlier one: remove it first so the layers are measured where they really are
            for (i = 0; i < list.length; i++) { var old = alignLockOf(list[i]); if (old) unlockAlignLayer(list[i], old, t); }
            if (to === "selection") {
                box = { l: 1e12, t: 1e12, r: -1e12, b: -1e12 };
                for (i = 0; i < list.length; i++) { var b = bounds(list[i], t); if (!b) continue; box.l = Math.min(box.l, b.l); box.t = Math.min(box.t, b.t); box.r = Math.max(box.r, b.r); box.b = Math.max(box.b, b.b); }
            }
            var n = 0, lockedN = 0, noLock = 0;
            for (i = 0; i < list.length; i++) {
                var L = list[i];
                if (!alignOne(L, box, h, v, t)) continue;
                n++;
                if (lock) {
                    if (to === "comp" && !L.parent && !L.threeDLayer) { lockAlign(L, h, v); lockedN++; }
                    else noLock++;
                }
            }
            var what = (v ? { top: "top", middle: "middle", bottom: "bottom" }[v] : "") + (h && v ? " / " : "") + (h ? { left: "left", center: "centre", right: "right" }[h] : "");
            var msg = plural(n, "layer") + " aligned " + what + " to the " + (to === "comp" ? "composition" : "selection");
            if (lockedN) msg += " \u00B7 locked: they stay aligned when the text, scale or rotation changes";
            if (noLock) msg += " \u00B7 " + plural(noLock, "layer") + " not locked (a lock needs a 2D layer without parent, aligned to the composition)";
            if (locked) msg += " \u00B7 " + plural(locked, "locked layer") + " left";
            return R(n > 0, n ? msg : "Nothing could be aligned.", { count: n, locked: lockedN, to: to });
        });
    }

    // ------------------------------------------------------------------ gradient lock

    function gradientPoints(L) {
        var out = [], i, j;
        function isPoint(p) { try { return p.propertyType === PropertyType.PROPERTY && (p.propertyValueType === PropertyValueType.TwoD_SPATIAL || p.propertyValueType === PropertyValueType.TwoD); } catch (e) { return false; } }
        var fx = L.property("ADBE Effect Parade");
        if (fx) for (i = 1; i <= fx.numProperties; i++) {
            var f = fx.property(i);
            if (!/ramp|gradient/i.test(f.matchName + " " + f.name)) continue;
            for (j = 1; j <= f.numProperties; j++) if (isPoint(f.property(j))) out.push(f.property(j));
        }
        function walk(g) {
            for (var k = 1; k <= g.numProperties; k++) {
                var p = g.property(k);
                if (!p) continue;
                if (p.matchName === "ADBE Vector Graphic - G-Fill" || p.matchName === "ADBE Vector Graphic - G-Stroke") {
                    var s = p.property("ADBE Vector Grad Start Pt"), e = p.property("ADBE Vector Grad End Pt");
                    if (s) out.push(s);
                    if (e) out.push(e);
                } else if (p.propertyType !== PropertyType.PROPERTY) walk(p);
            }
        }
        var root = L.property("ADBE Root Vectors Group");
        if (root) walk(root);
        return out;
    }

    function gradient(json) {
        var a = parse(json), lock = a.lock !== false;
        return undoable(lock ? "Gradient lock" : "Gradient unlock", function (c) {
            var sel = c.selectedLayers, layers = 0, pts = 0, none = 0, t = c.time, i, j;
            if (!sel.length) return R(false, "Select the layers with the gradients.");
            for (i = 0; i < sel.length; i++) {
                var L = sel[i];
                if (!isAV(L) || L.locked) continue;
                var list = gradientPoints(L), r = rectOf(L, t);
                if (!list.length || !r) { none++; continue; }
                layers++;
                for (j = 0; j < list.length; j++) {
                    var p = list[j];
                    if (lock) {
                        var v0 = p.valueAtTime(t, true);
                        if (hasLock(p, LOCK_GRAD)) { clearExpr(p); v0 = p.valueAtTime(t, true); }
                        var u = r.width ? (v0[0] - r.left) / r.width : 0.5, w = r.height ? (v0[1] - r.top) / r.height : 0.5;
                        p.expression = LOCK_GRAD + " " + num(u) + " " + num(w) + "\nvar r = thisLayer.sourceRectAtTime(time, false);\n[r.left + r.width * " + num(u) + ", r.top + r.height * " + num(w) + "]";
                        pts++;
                    } else if (hasLock(p, LOCK_GRAD)) {
                        var m = /lock (-?[\d.e-]+) (-?[\d.e-]+)/.exec(p.expression);
                        clearExpr(p);
                        if (m) { try { p.setValue([r.left + r.width * Number(m[1]), r.top + r.height * Number(m[2])]); } catch (eS) {} }
                        pts++;
                    }
                }
            }
            if (!layers) return R(false, "No gradient found on the selected layers (Gradient Ramp, 4-Color Gradient, or a shape's gradient fill / stroke).");
            return R(true, (lock ? "Gradient locked on " : "Gradient released on ") + plural(layers, "layer") + " (" + plural(pts, "point") + ")" +
                (lock ? ": it keeps its place in the layer when the text or shape changes" : "") + (none ? " \u00B7 " + plural(none, "layer") + " without a gradient" : ""), { layers: layers, points: pts });
        });
    }

    // ------------------------------------------------------------------ unlock

    function unlockAlignLayer(L, info, t) {
        for (var i = 0; i < info.props.length; i++) clearExpr(info.props[i]);
        // the expression held the layer aligned to the comp: put the plain value where the expression had it
        var c = L.containingComp;
        alignOne(L, { l: 0, t: 0, r: c.width, b: c.height }, info.h, info.v, t);
    }

    function unlock(json) {
        var a = parse(json), what = String(a.what || "");
        if (what === "gradient") return gradient({ lock: false });
        return undoable("Unlock " + what, function (c) {
            var sel = c.selectedLayers, n = 0, t = c.time, i;
            for (i = 0; i < sel.length; i++) {
                var L = sel[i];
                if (!usable(L) || L.locked) continue;
                if (what === "anchor") {
                    var ap = tg(L).property("ADBE Anchor Point");
                    if (!hasLock(ap, LOCK_ANCHOR)) continue;
                    var m = /lock ([\d.]+) ([\d.]+)/.exec(ap.expression), r = rectOf(L, t);
                    clearExpr(ap);
                    if (m && r && ap.numKeys === 0) {
                        var cur = v3(ap.valueAtTime(t, true)), want = [r.left + r.width * Number(m[1]), r.top + r.height * Number(m[2]), cur[2]];
                        ap.setValue(L.threeDLayer ? want : [want[0], want[1]]);
                    }
                    n++;
                } else if (what === "align") {
                    var info = alignLockOf(L);
                    if (!info) continue;
                    unlockAlignLayer(L, info, t);
                    n++;
                }
            }
            return R(true, n ? "Unlocked " + plural(n, "layer") + " - they stay where they are" : "No " + what + " lock on the selected layers", { count: n });
        });
    }

    return { anchor: anchor, align: align, gradient: gradient, unlock: unlock, _bounds: bounds, _toWorld: toWorld };
})();
