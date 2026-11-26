/**
 * Dala Suite - Twixtor Module
 * Handles Twixtor Dialog and Twixtor Speed presets, dynamic frame rate configuration,
 * unchecking "In FPS is Out FPS" (from RE:Vision Effects Twixtor), and independent multi-layer time-stretch.
 */

if (typeof $._dalaSuite === "undefined") {
    $._dalaSuite = {};
}

$._dalaSuite.twixtor = {

    // Find the Twixtor effect on a layer
    findTwixtorEffect: function (layer) {
        if (!layer.Effects) return null;
        for (var i = layer.Effects.numProperties; i >= 1; i--) {
            var fx = layer.Effects.property(i);
            var name = (fx.name || "").toLowerCase();
            var match = (fx.matchName || "").toLowerCase();
            if (name.indexOf("twixtor") !== -1 || match.indexOf("twixtor") !== -1) {
                return fx;
            }
        }
        return null;
    },

    // Inspect properties of Twixtor effect and apply FPS settings
    configureTwixtorFPS: function (twixtorFx, fps) {
        var numFps = Number(fps);
        if (isNaN(numFps) || numFps <= 0) {
            numFps = 60;
        }

        var inputFpsProp = null;
        var outputFpsProp = null;
        var inFpsIsOutFpsCheckbox = null;
        var compFpsCheckbox = null;

        function scanProperties(parentGroup) {
            if (!parentGroup || typeof parentGroup.numProperties !== "number") return;
            for (var i = 1; i <= parentGroup.numProperties; i++) {
                var p = parentGroup.property(i);
                if (p.propertyType === PropertyType.PROPERTY) {
                    var pName = (p.name || "").toLowerCase();
                    var pMatch = (p.matchName || "").toLowerCase();

                    // 1. Detect "In FPS is Out FPS" checkbox (RE:Vision Effects Twixtor)
                    if (
                        pName === "in fps is out fps" ||
                        pName.indexOf("in fps is out fps") !== -1 ||
                        (pName.indexOf("in") !== -1 && pName.indexOf("out") !== -1 && pName.indexOf("fps") !== -1)
                    ) {
                        inFpsIsOutFpsCheckbox = p;
                        $._dalaSuite.debug.log("Found 'In FPS is Out FPS' checkbox: " + p.name);
                    }
                    // Also check for "Use Comp Frame Rate" / "Frame Rate from Comp"
                    else if (
                        (pName.indexOf("comp") !== -1 && (pName.indexOf("rate") !== -1 || pName.indexOf("fps") !== -1)) ||
                        (pMatch.indexOf("comp") !== -1 && pMatch.indexOf("rate") !== -1) ||
                        pName.indexOf("use comp") !== -1 ||
                        pName.indexOf("frame rate from comp") !== -1
                    ) {
                        compFpsCheckbox = p;
                        $._dalaSuite.debug.log("Found comp frame-rate checkbox: " + p.name);
                    }
                    // 2. Detect Input Frame Rate
                    else if (
                        pName.indexOf("input: frame rate") !== -1 ||
                        pName.indexOf("input frame rate") !== -1 ||
                        (pName.indexOf("input") !== -1 && (pName.indexOf("rate") !== -1 || pName.indexOf("fps") !== -1)) ||
                        (pMatch.indexOf("input") !== -1 && pMatch.indexOf("fps") !== -1)
                    ) {
                        inputFpsProp = p;
                    }
                    // 3. Detect Output Frame Rate
                    else if (
                        pName.indexOf("output: frame rate") !== -1 ||
                        pName.indexOf("output frame rate") !== -1 ||
                        (pName.indexOf("output") !== -1 && (pName.indexOf("rate") !== -1 || pName.indexOf("fps") !== -1)) ||
                        (pMatch.indexOf("output") !== -1 && pMatch.indexOf("fps") !== -1)
                    ) {
                        outputFpsProp = p;
                    }
                } else if (
                    p.propertyType === PropertyType.INDEXED_GROUP ||
                    p.propertyType === PropertyType.NAMED_GROUP
                ) {
                    scanProperties(p);
                }
            }
        }

        scanProperties(twixtorFx);

        // Verification requirement: fail if frame rate controls are completely missing
        if (!inputFpsProp && !outputFpsProp) {
            throw new Error("Could not find the Twixtor frame rate controls.");
        }

        // Uncheck the "In FPS is Out FPS" checkbox from preset
        var checkboxUnchecked = false;
        var targetCheckbox = inFpsIsOutFpsCheckbox || compFpsCheckbox;

        if (targetCheckbox) {
            try {
                targetCheckbox.setValue(0);
                checkboxUnchecked = true;
                $._dalaSuite.debug.log("Twixtor checkbox '" + targetCheckbox.name + "': unchecked (value = 0)");
            } catch (eCb) {
                try {
                    targetCheckbox.setValue(false);
                    checkboxUnchecked = true;
                    $._dalaSuite.debug.log("Twixtor checkbox '" + targetCheckbox.name + "': unchecked (value = false)");
                } catch (eCb2) {}
            }
        } else {
            $._dalaSuite.debug.log("Warning: 'In FPS is Out FPS' checkbox not found on Twixtor effect.");
        }

        // Set Input FPS
        if (inputFpsProp) {
            inputFpsProp.setValue(numFps);
            $._dalaSuite.debug.log("Input Frame Rate: set to " + numFps);
        }

        // Set Output FPS (if available)
        if (outputFpsProp) {
            outputFpsProp.setValue(numFps);
            $._dalaSuite.debug.log("Output Frame Rate: set to " + numFps);
        }

        return {
            inputFpsSet: !!inputFpsProp,
            outputFpsSet: !!outputFpsProp,
            checkboxUnchecked: checkboxUnchecked,
            fps: numFps
        };
    },

    // Apply Twixtor Dialog preset to each selected layer independently
    applyDialog: function (fps, customPresetPath) {
        return $._dalaSuite.runWithUndo("Dala Suite - Twixtor Dialog", function () {
            var comp = $._dalaSuite.getActiveComp();
            var selectedLayers = $._dalaSuite.getSelectedLayers(comp);

            var presetFile = $._dalaSuite.presetEngine.resolvePreset(
                customPresetPath,
                "twixtor",
                "twixtor dialogue.ffx"
            );

            if (!presetFile || !presetFile.exists) {
                throw new Error("Preset not found:\n" + (presetFile ? presetFile.fsName : customPresetPath));
            }

            // Snapshot target layers and original playhead position
            var targetLayers = [];
            for (var l = 0; l < selectedLayers.length; l++) {
                targetLayers.push(selectedLayers[l]);
            }
            var origCompTime = comp.time;

            var results = [];
            $._dalaSuite.debug.log("Applying Twixtor Dialog preset to " + targetLayers.length + " layer(s) with FPS=" + fps);

            try {
                for (var i = 0; i < targetLayers.length; i++) {
                    var layer = targetLayers[i];
                    $._dalaSuite.debug.log("Processing Layer [" + layer.index + "] \"" + layer.name + "\"...");

                    // 1. Deselect ALL layers in composition to prevent AE applying preset to entire selection
                    for (var d = 1; d <= comp.numLayers; d++) {
                        comp.layer(d).selected = false;
                    }

                    // 2. Select ONLY the current target layer
                    layer.selected = true;

                    // 3. Move comp time safely to layer's own inPoint (clamped to [0, comp.duration])
                    var timing = $._dalaSuite.getValidLayerTiming(comp, layer);
                    $._dalaSuite.setSafeCompTime(comp, timing.safeCtiTime);

                    // 4. Apply preset to this isolated layer
                    $._dalaSuite.applyPresetChecked(layer, presetFile);

                    // 5. Find Twixtor effect on this layer
                    var twixtorFx = $._dalaSuite.twixtor.findTwixtorEffect(layer);
                    if (!twixtorFx) {
                        throw new Error("Twixtor effect could not be found on layer \"" + layer.name + "\".");
                    }
                    $._dalaSuite.debug.log("Twixtor: Found exactly 1 effect on layer");

                    // 6. Configure FPS and uncheck "In FPS is Out FPS"
                    var fpsConfig = $._dalaSuite.twixtor.configureTwixtorFPS(twixtorFx, fps);

                    results.push({
                        layerName: layer.name,
                        index: layer.index,
                        fps: fpsConfig.fps,
                        presetApplied: presetFile.name
                    });
                }
            } finally {
                // Restore original playhead time and layer selection safely
                $._dalaSuite.setSafeCompTime(comp, origCompTime);
                for (var s = 0; s < targetLayers.length; s++) {
                    targetLayers[s].selected = true;
                }
            }

            return $._dalaSuite.formatResult(
                true,
                "Applied Twixtor Dialog (" + fps + " FPS, In FPS is Out FPS unchecked) to " + results.length + " layer" + (results.length === 1 ? "" : "s") + ".",
                { count: results.length, layers: results }
            );
        });
    },

    // Apply Twixtor Speed preset with independent per-layer keyframe stretching
    applySpeed: function (fps, customPresetPath, shouldStretchKeyframes) {
        return $._dalaSuite.runWithUndo("Dala Suite - Twixtor Speed", function () {
            var comp = $._dalaSuite.getActiveComp();
            var selectedLayers = $._dalaSuite.getSelectedLayers(comp);
            var stretchEnabled = (shouldStretchKeyframes !== false && shouldStretchKeyframes !== "false");

            var presetFile = $._dalaSuite.presetEngine.resolvePreset(
                customPresetPath,
                "twixtor",
                "twixtor mid fast speedramp.ffx"
            );

            if (!presetFile || !presetFile.exists) {
                throw new Error("Preset not found:\n" + (presetFile ? presetFile.fsName : customPresetPath));
            }

            // Snapshot target layers and original playhead position
            var targetLayers = [];
            for (var l = 0; l < selectedLayers.length; l++) {
                targetLayers.push(selectedLayers[l]);
            }
            var origCompTime = comp.time;

            var results = [];
            $._dalaSuite.debug.log("Applying Twixtor Speed to " + targetLayers.length + " layer(s) independently (Stretch: " + (stretchEnabled ? "ON" : "OFF") + ") at FPS=" + fps);

            try {
                for (var i = 0; i < targetLayers.length; i++) {
                    var layer = targetLayers[i];
                    $._dalaSuite.debug.log("----------------------------------------");
                    $._dalaSuite.debug.log("PROCESSING LAYER [" + (i + 1) + "/" + targetLayers.length + "]: " + layer.name);
                    $._dalaSuite.debug.log("  Layer InPoint: " + layer.inPoint.toFixed(3) + "s, OutPoint: " + layer.outPoint.toFixed(3) + "s");

                    // 1. Deselect ALL layers in composition so AE never duplicates preset onto other layers
                    for (var d = 1; d <= comp.numLayers; d++) {
                        comp.layer(d).selected = false;
                    }

                    // 2. Select ONLY this current layer
                    layer.selected = true;

                    // 3. Move comp time safely to layer's own inPoint (clamped to [0, comp.duration])
                    var timing = $._dalaSuite.getValidLayerTiming(comp, layer);
                    $._dalaSuite.setSafeCompTime(comp, timing.safeCtiTime);

                    // 4. Snapshot keyframes state on this layer before preset application
                    var snapshot = stretchEnabled ? $._dalaSuite.keyframeEngine.snapshotLayer(layer) : null;

                    // 5. Apply Twixtor Speed preset to this layer only
                    $._dalaSuite.applyPresetChecked(layer, presetFile);

                    // 6. Find Twixtor effect created on this layer
                    var twixtorFx = $._dalaSuite.twixtor.findTwixtorEffect(layer);
                    if (!twixtorFx) {
                        throw new Error("Twixtor effect could not be found on layer \"" + layer.name + "\".");
                    }
                    $._dalaSuite.debug.log("  Twixtor Effect: Found exactly 1 effect");

                    // 7. Configure FPS and uncheck "In FPS is Out FPS"
                    var fpsConfig = $._dalaSuite.twixtor.configureTwixtorFPS(twixtorFx, fps);

                    // 8. Stretch preset keyframes to layer duration (first key at inPoint, last at outPoint, mid at 50%)
                    var stretchInfo = null;
                    if (stretchEnabled && snapshot) {
                        stretchInfo = $._dalaSuite.keyframeEngine.stretchLayerKeyframes(
                            layer,
                            snapshot,
                            layer.inPoint,
                            layer.outPoint
                        );
                    }

                    results.push({
                        layerName: layer.name,
                        index: layer.index,
                        inPoint: layer.inPoint,
                        outPoint: layer.outPoint,
                        durationFrames: Math.round((layer.outPoint - layer.inPoint) / comp.frameDuration),
                        fps: fpsConfig.fps,
                        stretched: stretchEnabled,
                        stretch: stretchInfo
                    });
                }
            } finally {
                // Restore original playhead position and multi-selection safely
                $._dalaSuite.setSafeCompTime(comp, origCompTime);
                for (var s = 0; s < targetLayers.length; s++) {
                    targetLayers[s].selected = true;
                }
            }

            var msg = "Applied Twixtor Speed (" + fps + " FPS) independently to " + results.length + " layer" + (results.length === 1 ? "" : "s");
            if (stretchEnabled) {
                msg += " (keyframes stretched to each layer's boundaries).";
            } else {
                msg += " (authored timing preserved).";
            }

            return $._dalaSuite.formatResult(true, msg, { count: results.length, layers: results });
        });
    }
};
