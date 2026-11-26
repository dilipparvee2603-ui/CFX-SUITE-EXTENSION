/**
 * Dala Suite - Shake Module
 * Applies Shake presets with optional time-only keyframe stretching to layer duration.
 * Fully isolated for multi-layer processing without playhead interference.
 */

if (typeof $._dalaSuite === "undefined") {
    $._dalaSuite = {};
}

$._dalaSuite.shake = {

    applyShake: function (presetIdentifier, shouldStretchKeyframes) {
        return $._dalaSuite.runWithUndo("Dala Suite - Apply Shake", function () {
            var comp = $._dalaSuite.getActiveComp();
            var selectedLayers = $._dalaSuite.getSelectedLayers(comp);

            var defaultPreset = "soft advanced twitch.ffx";
            var presetFile = $._dalaSuite.presetEngine.resolvePreset(
                presetIdentifier,
                "shake",
                defaultPreset
            );

            if (!presetFile || !presetFile.exists) {
                throw new Error("Preset not found:\n" + (presetFile ? presetFile.fsName : presetIdentifier));
            }

            var stretchEnabled = !!shouldStretchKeyframes;
            var targetLayers = [];
            for (var l = 0; l < selectedLayers.length; l++) {
                targetLayers.push(selectedLayers[l]);
            }
            var origCompTime = comp.time;

            var results = [];
            $._dalaSuite.debug.log("Applying Shake preset to " + targetLayers.length + " layer(s) independently (Stretch: " + (stretchEnabled ? "ON" : "OFF") + ")");

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

                    var snapshot = stretchEnabled ? $._dalaSuite.keyframeEngine.snapshotLayer(layer) : null;

                    // Apply preset
                    $._dalaSuite.applyPresetChecked(layer, presetFile);

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
                        preset: presetFile.name,
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

            var msg = "Applied " + presetFile.name.replace(/\.ffx$/i, "") + " to " + results.length + " layer" + (results.length === 1 ? "" : "s");
            if (stretchEnabled) {
                msg += " (keyframes stretched to each layer duration).";
            } else {
                msg += " (authored timing preserved).";
            }

            return $._dalaSuite.formatResult(true, msg, {
                count: results.length,
                preset: presetFile.name,
                stretched: stretchEnabled,
                layers: results
            });
        });
    }
};
