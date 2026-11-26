/**
 * Dala Suite - Cut Tools (CUT TO F)
 * Workflow:
 *   1. Splits each selected layer into 3 parts:
 *      - Layer A (Head): First 2 frames (duration = 2 frames)
 *      - Layer B (Mid): Middle portion (starts after first 2 frames, ends before last 2 frames)
 *      - Layer C (Tail): Last 2 frames (duration = 2 frames)
 *   2. Disables Frame Blending on the first 2 frame layer and last 2 frame layer (middle portion unchanged)
 *   3. Pre-composes the 3 resulting layers belonging to each original layer using:
 *      - Move all attributes into the new composition: Selected (true)
 *      - Adjust composition duration to the time span of the selected layers: Checked
 *      - Open New Composition: Unchecked (false)
 *   4. Supports multiple selected layers independently, producing a dedicated pre-comp for each original layer.
 *
 * Non-destructive: Source footage, composition frame rate, and timeline continuity are 100% preserved.
 *
 * The per-layer work lives in $._dalaSuite.cutToFLayer so the Auto Tracker can run the same
 * Cut To F on every tracked shot (with frame blending + motion blur enabled first).
 */

if (typeof $._dalaSuite === "undefined") {
    $._dalaSuite = {};
}

// Unique comp name in the project ("<base>", "<base> 2", ...)
$._dalaSuite.getUniquePrecompName = function (baseName) {
    var existing = {};
    for (var p = 1; p <= app.project.items.length; p++) {
        var it = app.project.items[p];
        if (it instanceof CompItem) {
            existing[it.name] = true;
        }
    }
    var name = baseName;
    var counter = 2;
    while (existing[name]) {
        name = baseName + " " + counter;
        counter++;
    }
    return name;
};

$._dalaSuite.setNoFrameBlend = function (layer) {
    try { layer.frameBlending = false; } catch (e) {}
    try {
        if (typeof FrameBlendingType !== "undefined" && FrameBlendingType.NO_FRAME_BLEND) {
            layer.frameBlendingType = FrameBlendingType.NO_FRAME_BLEND;
        }
    } catch (e) {}
};

/**
 * Cut To F on one layer: First 2F + Mid + Last 2F, edge frame blending off, pre-composed.
 * options (all optional; the CUT TO F button passes none, which keeps its original behaviour):
 *   enableBlending  - turn frame blending on (blendType, default Pixel Motion) before splitting,
 *                     so the middle section keeps it, and enable it on the new pre-comp
 *   motionBlur      - turn motion blur on for the layer and on the new pre-comp
 * Returns { precompLayer, result } or { skipped: { layerName, index, reason } }.
 */
$._dalaSuite.cutToFLayer = function (comp, origLayer, options) {
    options = options || {};
    var frameDuration = comp.frameDuration;
    var origName = origLayer.name;
    // Frame-exact: the layer shows at frame f when inPoint <= f * frameDuration < outPoint. In / out points that sit
    // between frames (footage of another frame rate, a trim made at another rate) used to make the pre-comp a
    // fraction of a frame shorter than the clip - its last frame was cut - and its layers start a fraction of a
    // frame late inside it - a black first frame at the cut. Everything below is whole frames of the comp.
    var inFrame0 = Math.ceil(origLayer.inPoint / frameDuration - 1e-6);
    var outFrame0 = Math.ceil(origLayer.outPoint / frameDuration - 1e-6);
    var origIn = inFrame0 * frameDuration;
    var origOut = outFrame0 * frameDuration;
    var currentDuration = origOut - origIn;
    var totalFrames = outFrame0 - inFrame0;

    // Minimum 5 frames required to split into: 2 frames head + at least 1 frame mid + 2 frames tail
    var minDuration = 5 * frameDuration - (frameDuration * 0.1);

    if (currentDuration < minDuration) {
        var errMsg = "Layer \"" + origName + "\" is too short for Cut to F (Duration: " + totalFrames + "f, minimum 5f required for 2F Head + Mid + 2F Tail).";
        $._dalaSuite.debug.log("Validation notice: " + errMsg);
        return { skipped: { layerName: origName, index: origLayer.index, reason: errMsg } };
    }

    if (options.enableBlending) {
        var blendType = options.blendType;
        try {
            if (blendType === undefined && typeof FrameBlendingType !== "undefined") blendType = FrameBlendingType.PIXEL_MOTION;
            origLayer.frameBlendingType = blendType;
        } catch (eFb) {
            try { origLayer.frameBlendingType = FrameBlendingType.FRAME_MIX; } catch (eFb2) {}
        }
        try { comp.frameBlending = true; } catch (eCfb) {}
    }
    if (options.motionBlur) {
        try { origLayer.motionBlur = true; } catch (eMb) {}
        try { comp.motionBlur = true; } catch (eCmb) {}
    }

    // Timeline split points (2 frames head, mid, 2 frames tail), on the comp's frames
    var inFrame = inFrame0;
    var midStartFrame = inFrame0 + 2;
    var midEndFrame = outFrame0 - 2;
    var outFrame = outFrame0;
    var t0 = inFrame * frameDuration;
    var t1 = midStartFrame * frameDuration;
    var t2 = midEndFrame * frameDuration;
    var t3 = outFrame * frameDuration;

    // Duplicate the original layer twice to create Layer B (Mid) and Layer C (Last 2 frames)
    // Duplicating retains all effects, masks, transform properties, parent links, and blend modes intact.
    var layerMid = origLayer.duplicate();
    var layerLast = origLayer.duplicate();

    // Set Layer A (Head - First 2 frames: exactly 2 frames duration)
    origLayer.inPoint = t0;
    origLayer.outPoint = t1;
    origLayer.name = origName + " [Frames 1-2]";

    // Set Layer B (Mid section: starts after first 2 frames, ends before last 2 frames)
    layerMid.inPoint = t1;
    layerMid.outPoint = t2;
    layerMid.name = origName + " [Mid]";

    // Set Layer C (Tail - Last 2 frames: exactly 2 frames duration)
    layerLast.inPoint = t2;
    layerLast.outPoint = t3;
    layerLast.name = origName + " [Last 2 Frames]";

    // 2. Disable Frame Blending on first 2 frames and last 2 frames (leave middle unchanged)
    $._dalaSuite.setNoFrameBlend(origLayer);
    $._dalaSuite.setNoFrameBlend(layerLast);

    $._dalaSuite.debug.log("Layer [" + origLayer.index + "] \"" + origName + "\" split:");
    $._dalaSuite.debug.log("  - Head (First 2F): " + inFrame + "f -> " + midStartFrame + "f (2 frames) [Frame Blending: OFF]");
    $._dalaSuite.debug.log("  - Mid: " + midStartFrame + "f -> " + midEndFrame + "f (" + (midEndFrame - midStartFrame) + " frames) [Frame Blending: " + (options.enableBlending ? "ON" : "Unchanged") + "]");
    $._dalaSuite.debug.log("  - Tail (Last 2F): " + midEndFrame + "f -> " + outFrame + "f (2 frames) [Frame Blending: OFF]");

    // 3. Automatically Pre-compose the 3 resulting layers for this original layer
    // Settings:
    //   - Move all attributes into the new composition: Selected (moveAllAttributes = true)
    //   - Adjust composition duration to the time span of the selected layers: Checked
    //   - Open New Composition: Unchecked (do not open in viewer)
    var layerIndices = [origLayer.index, layerMid.index, layerLast.index];
    var precompName = $._dalaSuite.getUniquePrecompName(origName + " [Cut to F]");
    var newComp = comp.layers.precompose(layerIndices, precompName, true);

    var spanDuration = t3 - t0;

    // a scripted precompose takes the footage's frame rate, not the comp's: its length would then round to the wrong
    // frames (the clip's last frames cut, a black frame before the next clip) - use the comp's, as Pre-compose does
    try { if (newComp && Math.abs(newComp.frameRate - comp.frameRate) > 1e-6) newComp.frameRate = comp.frameRate; } catch (eFr) {}

    if (newComp) {
        // Adjust composition duration to the exact time span of the layers (whole frames) and shift the layers by a
        // whole number of frames so the span starts at time 0 of the new comp; each part keeps exactly its frames
        for (var m = 1; m <= newComp.numLayers; m++) {
            var subLayer = newComp.layer(m);
            subLayer.startTime = subLayer.startTime - t0;
            var nm = subLayer.name;
            if (nm.indexOf("[Frames 1-2]") !== -1) { subLayer.inPoint = 0; subLayer.outPoint = 2 * frameDuration; }
            else if (nm.indexOf("[Last 2 Frames]") !== -1) { subLayer.inPoint = (totalFrames - 2) * frameDuration; subLayer.outPoint = totalFrames * frameDuration; }
            else if (nm.indexOf("[Mid]") !== -1) { subLayer.inPoint = 2 * frameDuration; subLayer.outPoint = (totalFrames - 2) * frameDuration; }
            // Ensure frame blending states are maintained inside new comp
            if (nm.indexOf("[Frames 1-2]") !== -1 || nm.indexOf("[Last 2 Frames]") !== -1) {
                $._dalaSuite.setNoFrameBlend(subLayer);
            }
        }
        newComp.duration = totalFrames * frameDuration;
        // frame blending / motion blur only render inside a pre-comp when its own switches are on
        if (options.enableBlending) { try { newComp.frameBlending = true; } catch (eNf) {} }
        if (options.motionBlur) { try { newComp.motionBlur = true; } catch (eNm) {} }
        $._dalaSuite.debug.log("  - Pre-composed into \"" + precompName + "\" (Duration: " + spanDuration.toFixed(3) + "s / " + totalFrames + "f, Adjusted span)");
    }

    // Find the resulting precomp layer in the parent composition and configure its timing
    var resultingPrecompLayer = null;
    for (var k = 1; k <= comp.numLayers; k++) {
        var testL = comp.layer(k);
        if (testL && testL.source === newComp) {
            resultingPrecompLayer = testL;
            break;
        }
    }

    if (resultingPrecompLayer) {
        resultingPrecompLayer.startTime = t0;
        resultingPrecompLayer.inPoint = t0;
        resultingPrecompLayer.outPoint = t3;
    }

    return {
        precompLayer: resultingPrecompLayer,
        precomp: newComp,
        result: {
            originalName: origName,
            precompName: precompName,
            timeSpan: { inPoint: t0, outPoint: t3, duration: spanDuration, frames: totalFrames },
            headFrames: 2,
            midFrames: midEndFrame - midStartFrame,
            tailFrames: 2,
            frameBlendingDisabledOnEdges: true
        }
    };
};

$._dalaSuite.cutToF = function () {
    return $._dalaSuite.runWithUndo("Dala Suite - Cut To F", function () {
        var comp = $._dalaSuite.getActiveComp();
        var selectedLayers = $._dalaSuite.getSelectedLayers(comp);

        $._dalaSuite.debug.log("Cut To F initiated: Processing " + selectedLayers.length + " layer(s) into 3-part split + pre-comp (First 2F + Mid + Last 2F)...");

        // Clone list of layers to process and sort descending by layer index (bottom-to-top)
        // so duplicating/pre-composing higher-index layers does not shift or invalidate the indices of lower-index layers!
        var layersToProcess = [];
        for (var i = 0; i < selectedLayers.length; i++) {
            layersToProcess.push(selectedLayers[i]);
        }
        layersToProcess.sort(function (a, b) {
            return b.index - a.index;
        });

        var results = [];
        var skipped = [];
        var createdPrecompLayers = [];

        for (var j = 0; j < layersToProcess.length; j++) {
            var r = $._dalaSuite.cutToFLayer(comp, layersToProcess[j]);
            if (r.skipped) {
                skipped.push(r.skipped);
                continue;
            }
            if (r.precompLayer) {
                createdPrecompLayers.push(r.precompLayer);
            }
            results.push(r.result);
        }

        if (results.length === 0 && skipped.length > 0) {
            throw new Error(skipped[0].reason);
        }

        // Deselect everything and select the newly created precomp layers in the timeline
        for (var d = 1; d <= comp.numLayers; d++) {
            comp.layer(d).selected = false;
        }
        for (var s = 0; s < createdPrecompLayers.length; s++) {
            createdPrecompLayers[s].selected = true;
        }

        var message = "Cut to F: Processed " + results.length + " layer" + (results.length === 1 ? "" : "s") + " (First 2F + Mid + Last 2F) & pre-composed independently.";
        if (skipped.length > 0) {
            message += " (" + skipped.length + " skipped: too short).";
        }

        return $._dalaSuite.formatResult(true, message, {
            processed: results,
            skipped: skipped,
            count: results.length
        });
    });
};
