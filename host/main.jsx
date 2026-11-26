/**
 * CFX Suite Pro - Main ExtendScript Host Entry Point
 * Adobe After Effects CEP Extension
 */

// Include required modules
#include "utilities.jsx"
#include "keyframeEngine.jsx"
#include "layerRecipe.jsx"
#include "captions.jsx"
#include "captionPresets.jsx"
#include "anchorAlign.jsx"
#include "editTools.jsx"
#include "unprecompose.jsx"
#include "dalaGeneral.jsx"
#include "generalTools.jsx"
#include "presetEngine.jsx"
#include "twixtor.jsx"
#include "zoom.jsx"
#include "shake.jsx"
#include "framing.jsx"
#include "autoTracker.jsx"
#include "cutTools.jsx"
#include "audioTools.jsx"
#include "musicStems.jsx"
#include "sfxExtractor.jsx"
#include "layerSetups.jsx"

// Check project status and active composition info
$._cfxSuite.getCompInfo = function () {
    try {
        if (!app.project) {
            return $._cfxSuite.formatResult(false, "No project open.", { hasComp: false });
        }
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return $._cfxSuite.formatResult(true, "No active composition selected.", {
                hasComp: false,
                projectName: app.project.file ? app.project.file.name : "Untitled Project"
            });
        }

        var layers = comp.selectedLayers;
        var layerDetails = [];
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            layerDetails.push({
                index: l.index,
                name: l.name,
                inPoint: l.inPoint,
                outPoint: l.outPoint,
                durationFrames: Math.round((l.outPoint - l.inPoint) / comp.frameDuration),
                isText: (typeof TextLayer !== "undefined" && l instanceof TextLayer) || (l.property("Source Text") !== null)
            });
        }

        return $._cfxSuite.formatResult(true, "Comp info retrieved.", {
            hasComp: true,
            compName: comp.name,
            width: comp.width,
            height: comp.height,
            fps: Math.round(1 / comp.frameDuration * 1000) / 1000,
            frameDuration: comp.frameDuration,
            duration: comp.duration,
            selectedLayerCount: layers.length,
            selectedLayers: layerDetails
        });
    } catch (err) {
        return $._cfxSuite.formatResult(false, err.message || err.toString(), null, err.toString());
    }
};

// Ping / Version check
$._cfxSuite.ping = function () {
    return $._cfxSuite.formatResult(true, "CFX Suite Host API Active.", {
        version: "1.0.0",
        aeVersion: app.version,
        platform: $.os
    });
};

// Ensure bidirectional alias between CFX Suite and Dala Suite
if (typeof $._dalaSuite === "undefined") {
    $._dalaSuite = $._cfxSuite;
}
for (var k in $._dalaSuite) {
    if ($._dalaSuite.hasOwnProperty(k) && typeof $._cfxSuite[k] === "undefined") {
        $._cfxSuite[k] = $._dalaSuite[k];
    }
}
for (var j in $._cfxSuite) {
    if ($._cfxSuite.hasOwnProperty(j) && typeof $._dalaSuite[j] === "undefined") {
        $._dalaSuite[j] = $._cfxSuite[j];
    }
}
