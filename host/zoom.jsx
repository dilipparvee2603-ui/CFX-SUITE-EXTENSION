/**
 * Dala Suite - Zoom Module
 * Handles applying Zoom presets with automatic composition center adaptation
 * and optional time-only keyframe stretching to layer duration.
 * Fully isolated for multi-layer processing without playhead interference.
 */

if (typeof $._dalaSuite === "undefined") {
    $._dalaSuite = {};
}

$._dalaSuite.zoom = {

    // Calculate active composition center dynamically
    getCompCenter: function (comp) {
        if (!comp) comp = $._dalaSuite.getActiveComp();
        var cx = comp.width / 2.0;
        var cy = comp.height / 2.0;
        return [cx, cy];
    },

    // Adapt zoom center properties to current composition dimensions
    adaptZoomCenter: function (layer, snapshot, comp) {
        var compCenter = this.getCompCenter(comp);
        var cx = compCenter[0];
        var cy = compCenter[1];

        $._dalaSuite.debug.log("Comp size: " + comp.width + "x" + comp.height + " -> Calculated Center: [" + cx + ", " + cy + "]");

        var newEffectStartIndex = snapshot ? (snapshot.effectCount + 1) : 1;
        var currentEffectCount = layer.Effects ? layer.Effects.numProperties : 0;
        var centerAdaptedCount = 0;

        function adjustPropCenter(prop, propLabel) {
            try {
                if (prop.propertyValueType !== PropertyValueType.TwoD_SPATIAL &&
                    prop.propertyValueType !== PropertyValueType.TwoD) {
                    return false;
                }

                if (prop.numKeys > 0) {
                    var firstVal = prop.keyValue(1);
                    if (firstVal && firstVal.length >= 2) {
                        var origRefX = firstVal[0];
                        var origRefY = firstVal[1];
                        
                        var deltaX = cx - origRefX;
                        var deltaY = cy - origRefY;

                        if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
                            for (var k = 1; k <= prop.numKeys; k++) {
                                var val = prop.keyValue(k);
                                var adjustedVal = [val[0] + deltaX, val[1] + deltaY];
                                if (val.length > 2) {
                                    adjustedVal.push(val[2]);
                                }
                                prop.setValueAtKey(k, adjustedVal);
                            }
                            $._dalaSuite.debug.log("Adjusted keyframed " + propLabel + " by delta [" + deltaX.toFixed(1) + ", " + deltaY.toFixed(1) + "] to comp center [" + cx + ", " + cy + "]");
                            return true;
                        }
                    }
                } else {
                    var curVal = prop.value;
                    if (curVal && curVal.length >= 2) {
                        var deltaX = cx - curVal[0];
                        var deltaY = cy - curVal[1];
                        if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
                            var newVal = [cx, cy];
                            if (curVal.length > 2) newVal.push(curVal[2]);
                            prop.setValue(newVal);
                            $._dalaSuite.debug.log("Set static " + propLabel + " to comp center [" + cx + ", " + cy + "]");
                            return true;
                        }
                    }
                }
            } catch (err) {
                $._dalaSuite.debug.log("Center adjustment warning on " + propLabel + ": " + err.toString());
            }
            return false;
        }

        // 1. Check newly added effects
        if (layer.Effects && currentEffectCount >= newEffectStartIndex) {
            for (var e = newEffectStartIndex; e <= currentEffectCount; e++) {
                var newFx = layer.Effects.property(e);
                $._dalaSuite.keyframeEngine.traverseProperties(newFx, function (prop, path) {
                    var pName = (prop.name || "").toLowerCase();
                    if (
                        pName.indexOf("anchor") !== -1 ||
                        pName.indexOf("position") !== -1 ||
                        pName.indexOf("center") !== -1 ||
                        pName.indexOf("origin") !== -1
                    ) {
                        if (adjustPropCenter(prop, "Effect " + newFx.name + " > " + prop.name)) {
                            centerAdaptedCount++;
                        }
                    }
                }, newFx.name);
            }
        }

        // 2. Check layer Transform Position/Anchor Point
        if (centerAdaptedCount === 0 && layer.transform) {
            var posProp = layer.transform.position;
            if (posProp && posProp.isTimeVarying && posProp.numKeys > 0) {
                var prevKeys = snapshot ? (snapshot.keyframedProps["Position"] || 0) : 0;
                if (prevKeys === 0 || posProp.numKeys > prevKeys) {
                    if (adjustPropCenter(posProp, "Layer Position")) {
                        centerAdaptedCount++;
                    }
                }
            }
        }

        return {
            centerAdapted: centerAdaptedCount > 0,
            adaptedCount: centerAdaptedCount,
            compCenter: [cx, cy]
        };
    },

    // Apply Zoom preset
    applyZoom: function (customPresetPath, shouldStretchKeyframes) {
        return $._dalaSuite.runWithUndo("Dala Suite - Apply Zoom", function () {
            var comp = $._dalaSuite.getActiveComp();
            var selectedLayers = $._dalaSuite.getSelectedLayers(comp);
            var stretchEnabled = (shouldStretchKeyframes !== false && shouldStretchKeyframes !== "false");

            var presetFile = $._dalaSuite.presetEngine.resolvePreset(
                customPresetPath,
                "zoom",
                "myzoom.ffx"
            );

            if (!presetFile || !presetFile.exists) {
                throw new Error("Preset not found:\n" + (presetFile ? presetFile.fsName : customPresetPath));
            }

            var compCenter = $._dalaSuite.zoom.getCompCenter(comp);
            var targetLayers = [];
            for (var l = 0; l < selectedLayers.length; l++) {
                targetLayers.push(selectedLayers[l]);
            }
            var origCompTime = comp.time;

            var results = [];
            $._dalaSuite.debug.log("Applying Zoom preset to " + targetLayers.length + " layer(s) independently (Stretch: " + (stretchEnabled ? "ON" : "OFF") + ")");

            try {
                for (var i = 0; i < targetLayers.length; i++) {
                    var layer = targetLayers[i];
                    $._dalaSuite.debug.log("Processing Layer [" + layer.index + "] \"" + layer.name + "\"...");

                    // Deselect all layers, select current layer only
                    for (var d = 1; d <= comp.numLayers; d++) {
                        comp.layer(d).selected = false;
                    }
                    layer.selected = true;

                    // Set playhead safely to layer inPoint (clamped to [0, comp.duration])
                    var timing = $._dalaSuite.getValidLayerTiming(comp, layer);
                    $._dalaSuite.setSafeCompTime(comp, timing.safeCtiTime);

                    // 1. Snapshot layer before preset
                    var snapshot = stretchEnabled ? $._dalaSuite.keyframeEngine.snapshotLayer(layer) : null;

                    // 2. Apply preset
                    $._dalaSuite.applyPresetChecked(layer, presetFile);

                    // 3. Adapt Zoom Center to current composition dimensions
                    var centerResult = $._dalaSuite.zoom.adaptZoomCenter(layer, snapshot, comp);

                    // 4. Stretch keyframes to layer duration (if enabled)
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
                        compCenter: compCenter,
                        centerAdapted: centerResult.centerAdapted,
                        stretched: stretchEnabled,
                        stretch: stretchInfo
                    });
                }
            } finally {
                $._dalaSuite.setSafeCompTime(comp, origCompTime);
                for (var s = 0; s < targetLayers.length; s++) {
                    targetLayers[s].selected = true;
                }
            }

            var msg = "Applied Zoom (" + comp.width + "x" + comp.height + ", Center [" + compCenter[0] + ", " + compCenter[1] + "]) to " + results.length + " layer" + (results.length === 1 ? "" : "s");
            if (stretchEnabled) {
                msg += " (keyframes stretched to each layer duration).";
            } else {
                msg += " (authored timing preserved).";
            }

            return $._dalaSuite.formatResult(true, msg, { count: results.length, compCenter: compCenter, layers: results });
        });
    }
};
