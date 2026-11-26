/**
 * CFX Suite - Keyframe Engine
 * Safe time-only keyframe stretching system.
 * Detects newly applied preset keyframes and scales their timing to layer boundaries
 * without altering easing curves, values, or interpolation.
 */

if (typeof $._cfxSuite === "undefined") {
    $._cfxSuite = {};
}

$._cfxSuite.keyframeEngine = {
    
    // Snapshot layer property keyframe states before preset application
    snapshotLayer: function (layer) {
        var snapshot = {
            effectCount: (layer.Effects ? layer.Effects.numProperties : 0),
            effectList: [],
            keyframedProps: {} // map of prop identifier -> numKeys
        };

        if (layer.Effects) {
            for (var i = 1; i <= layer.Effects.numProperties; i++) {
                var fx = layer.Effects.property(i);
                snapshot.effectList.push({
                    name: fx.name,
                    matchName: fx.matchName,
                    index: i
                });
            }
        }

        // Snapshot transform and pre-existing properties
        this.traverseProperties(layer, function (prop, path) {
            if (prop.propertyType === PropertyType.PROPERTY && prop.isTimeVarying && prop.numKeys > 0) {
                snapshot.keyframedProps[path] = prop.numKeys;
            }
        });

        return snapshot;
    },

    // Traverse all properties of a layer or group recursively
    traverseProperties: function (parentGroup, callback, currentPath) {
        currentPath = currentPath || "";
        if (!parentGroup || typeof parentGroup.numProperties !== "number") return;

        for (var i = 1; i <= parentGroup.numProperties; i++) {
            var prop = parentGroup.property(i);
            var path = currentPath ? (currentPath + " > " + prop.name) : prop.name;

            if (prop.propertyType === PropertyType.PROPERTY) {
                callback(prop, path);
            } else if (
                prop.propertyType === PropertyType.INDEXED_GROUP ||
                prop.propertyType === PropertyType.NAMED_GROUP
            ) {
                this.traverseProperties(prop, callback, path);
            }
        }
    },

    // Detect keyframed properties created by the applied preset
    detectPresetKeyframes: function (layer, snapshot) {
        var newlyKeyframedProps = [];
        var newEffectStartIndex = snapshot.effectCount + 1;
        var currentEffectCount = layer.Effects ? layer.Effects.numProperties : 0;

        // 1. Any properties with keyframes inside newly added effects
        if (layer.Effects && currentEffectCount >= newEffectStartIndex) {
            for (var e = newEffectStartIndex; e <= currentEffectCount; e++) {
                var newFx = layer.Effects.property(e);
                this.traverseProperties(newFx, function (prop, path) {
                    if (prop.propertyType === PropertyType.PROPERTY && prop.isTimeVarying && prop.numKeys > 0) {
                        newlyKeyframedProps.push(prop);
                    }
                }, newFx.name);
            }
        }

        // 2. Any layer properties (Transform, Opacity, etc.) that gained keys
        this.traverseProperties(layer, function (prop, path) {
            // Avoid effects already handled
            if (path.indexOf("ADBE Effect Parade") !== -1 || path.indexOf("Effects") !== -1) {
                return;
            }
            if (prop.propertyType === PropertyType.PROPERTY && prop.isTimeVarying && prop.numKeys > 0) {
                var prevKeys = snapshot.keyframedProps[path] || 0;
                if (prevKeys === 0 || prop.numKeys > prevKeys) {
                    newlyKeyframedProps.push(prop);
                }
            }
        });

        return newlyKeyframedProps;
    },

    // Determine the global animation start and end time across newly keyframed properties
    calculateTimeBounds: function (propsList) {
        var minTime = Infinity;
        var maxTime = -Infinity;
        var totalKeyCount = 0;

        for (var p = 0; p < propsList.length; p++) {
            var prop = propsList[p];
            var count = prop.numKeys;
            totalKeyCount += count;
            for (var k = 1; k <= count; k++) {
                var t = prop.keyTime(k);
                if (t < minTime) minTime = t;
                if (t > maxTime) maxTime = t;
            }
        }

        return {
            start: (minTime === Infinity ? 0 : minTime),
            end: (maxTime === -Infinity ? 0.04 : (maxTime <= minTime ? minTime + 0.04 : maxTime)),
            totalKeys: totalKeyCount
        };
    },

    // Remap keyframe time positions only: strictly preserves values, easing handles, interpolation and graph shape
    remapTimeOnly: function (prop, oldStart, oldEnd, targetStart, targetEnd) {
        if (!prop || !prop.isTimeVarying || prop.numKeys === 0) return;

        var numKeys = prop.numKeys;
        var timeSpanOld = oldEnd - oldStart;
        var timeSpanTarget = targetEnd - targetStart;
        if (timeSpanTarget <= 0.00001) {
            timeSpanTarget = 0.04; // Minimum safe 1 frame duration
        }
        if (timeSpanOld <= 0.00001) {
            timeSpanOld = 0.04;
        }

        var keysData = [];

        // 1. Record all keyframe attributes exactly (values, interpolation, easing, tangents untouched)
        for (var k = 1; k <= numKeys; k++) {
            var oldT = prop.keyTime(k);
            var newT = targetStart + ((oldT - oldStart) * timeSpanTarget / timeSpanOld);

            var keyInfo = {
                newTime: newT,
                value: prop.keyValue(k),
                inInterp: null,
                outInterp: null,
                inEase: null,
                outEase: null,
                inSpatialTangent: null,
                outSpatialTangent: null,
                spatialContinuous: false,
                spatialAutoBezier: false,
                roving: false,
                temporalAutoBezier: false,
                temporalContinuous: false
            };

            try {
                keyInfo.inInterp = prop.keyInInterpolationType(k);
                keyInfo.outInterp = prop.keyOutInterpolationType(k);
            } catch (e1) {}

            try {
                keyInfo.inEase = prop.keyInTemporalEase(k);
                keyInfo.outEase = prop.keyOutTemporalEase(k);
            } catch (e2) {}

            try {
                keyInfo.inSpatialTangent = prop.keyInSpatialTangent(k);
                keyInfo.outSpatialTangent = prop.keyOutSpatialTangent(k);
                keyInfo.spatialContinuous = prop.keySpatialContinuous(k);
                keyInfo.spatialAutoBezier = prop.keySpatialAutoBezier(k);
                keyInfo.roving = prop.keyRoving(k);
            } catch (e3) {}

            try {
                keyInfo.temporalContinuous = prop.keyTemporalContinuous(k);
                keyInfo.temporalAutoBezier = prop.keyTemporalAutoBezier(k);
            } catch (e4) {}

            keysData.push(keyInfo);
        }

        // 2. Remove old keys in reverse
        for (var rem = numKeys; rem >= 1; rem--) {
            try {
                prop.removeKey(rem);
            } catch (eRem) {}
        }

        // 3. Re-add keys at new time positions, restoring original values, interpolation and easing untouched
        for (var a = 0; a < keysData.length; a++) {
            var kd = keysData[a];
            try {
                var newIdx;
                try {
                    newIdx = prop.addKey(kd.newTime);
                } catch (eAddDirect) {
                    if (kd.newTime < 0) {
                        try {
                            newIdx = prop.addKey(0);
                        } catch (eAddZero) {}
                    }
                }

                if (typeof newIdx === "number") {
                    prop.setValueAtKey(newIdx, kd.value);

                    if (kd.inInterp !== null && kd.outInterp !== null) {
                        prop.setInterpolationTypeAtKey(newIdx, kd.inInterp, kd.outInterp);
                    }

                    if (kd.inEase !== null && kd.outEase !== null) {
                        prop.setTemporalEaseAtKey(newIdx, kd.inEase, kd.outEase);
                    }

                    if (kd.inSpatialTangent !== null && kd.outSpatialTangent !== null) {
                        prop.setSpatialTangentsAtKey(newIdx, kd.inSpatialTangent, kd.outSpatialTangent);
                        prop.setSpatialContinuousAtKey(newIdx, kd.spatialContinuous);
                        prop.setSpatialAutoBezierAtKey(newIdx, kd.spatialAutoBezier);
                        prop.setRovingAtKey(newIdx, kd.roving);
                    }

                    if (kd.temporalContinuous) {
                        prop.setTemporalContinuousAtKey(newIdx, true);
                    }
                    if (kd.temporalAutoBezier) {
                        prop.setTemporalAutoBezierAtKey(newIdx, true);
                    }
                }
            } catch (eAdd) {}
        }
    },

    // Get time boundaries of all keyframes across a list of properties
    getKeyframeBounds: function (propsList) {
        var minTime = Infinity;
        var maxTime = -Infinity;
        var totalKeyCount = 0;

        for (var p = 0; p < propsList.length; p++) {
            var prop = propsList[p];
            var count = prop.numKeys;
            totalKeyCount += count;
            for (var k = 1; k <= count; k++) {
                var t = prop.keyTime(k);
                if (t < minTime) minTime = t;
                if (t > maxTime) maxTime = t;
            }
        }

        return {
            start: (minTime === Infinity ? 0 : minTime),
            end: (maxTime === -Infinity ? 0.04 : (maxTime <= minTime ? minTime + 0.04 : maxTime)),
            totalKeys: totalKeyCount
        };
    },

    // Stretch keyframes on a single property using exact Alt-drag time scaling
    stretchProperty: function (prop, oldStart, oldEnd, targetStart, targetEnd) {
        if (!prop || !prop.isTimeVarying || prop.numKeys === 0) return;

        var numKeys = prop.numKeys;
        var timeSpanOld = oldEnd - oldStart;
        var timeSpanTarget = targetEnd - targetStart;
        if (timeSpanTarget <= 0.00001) timeSpanTarget = 0.04;
        if (timeSpanOld <= 0.00001) timeSpanOld = 0.04;
        var timeRatio = (timeSpanTarget / timeSpanOld);

        var keysData = [];

        // 1. Record all keyframe attributes
        for (var k = 1; k <= numKeys; k++) {
            var oldT = prop.keyTime(k);
            var newT = targetStart + ((oldT - oldStart) * timeSpanTarget / timeSpanOld);

            var keyInfo = {
                newTime: newT,
                value: prop.keyValue(k),
                inInterp: null,
                outInterp: null,
                inEase: null,
                outEase: null,
                isSpatial: false,
                inSpatialTangent: null,
                outSpatialTangent: null,
                spatialContinuous: false,
                spatialAutoBezier: false,
                roving: false,
                temporalAutoBezier: false,
                temporalContinuous: false
            };

            try {
                keyInfo.inInterp = prop.keyInInterpolationType(k);
                keyInfo.outInterp = prop.keyOutInterpolationType(k);
            } catch (e1) {}

            try {
                var inEaseArr = prop.keyInTemporalEase(k);
                var outEaseArr = prop.keyOutTemporalEase(k);
                if (inEaseArr && outEaseArr) {
                    var newInEase = [];
                    var newOutEase = [];
                    for (var e = 0; e < inEaseArr.length; e++) {
                        // When time scales, speed (units/sec) scales inversely to preserve curve
                        var inSpd = timeRatio > 0 ? (inEaseArr[e].speed / timeRatio) : inEaseArr[e].speed;
                        var outSpd = timeRatio > 0 ? (outEaseArr[e].speed / timeRatio) : outEaseArr[e].speed;
                        newInEase.push(new KeyframeEase(inSpd, inEaseArr[e].influence));
                        newOutEase.push(new KeyframeEase(outSpd, outEaseArr[e].influence));
                    }
                    keyInfo.inEase = newInEase;
                    keyInfo.outEase = newOutEase;
                }
            } catch (e2) {}

            try {
                keyInfo.temporalContinuous = prop.keyTemporalContinuous(k);
                keyInfo.temporalAutoBezier = prop.keyTemporalAutoBezier(k);
            } catch (e3) {}

            try {
                if (prop.propertyValueType === PropertyValueType.TwoD_SPATIAL ||
                    prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL) {
                    keyInfo.isSpatial = true;
                    keyInfo.inSpatialTangent = prop.keyInSpatialTangent(k);
                    keyInfo.outSpatialTangent = prop.keyOutSpatialTangent(k);
                    keyInfo.spatialContinuous = prop.keySpatialContinuous(k);
                    keyInfo.spatialAutoBezier = prop.keySpatialAutoBezier(k);
                    keyInfo.roving = prop.keyRoving(k);
                }
            } catch (e4) {}

            keysData.push(keyInfo);
        }

        // 2. Remove old keys safely
        while (prop.numKeys > 0) {
            try {
                prop.removeKey(1);
            } catch (eRem) {
                break;
            }
        }

        // 3. Re-insert keys at newly calculated target times
        for (var i = 0; i < keysData.length; i++) {
            var item = keysData[i];
            try {
                prop.setValueAtTime(item.newTime, item.value);
            } catch (errSetTime) {
                if (item.newTime < 0) {
                    try {
                        prop.setValueAtTime(0, item.value);
                    } catch (errZero) {}
                }
            }
        }

        // 4. Re-apply interpolation, temporal ease, and tangents
        for (var idx = 0; idx < keysData.length; idx++) {
            var keyIdx = idx + 1;
            var data = keysData[idx];

            try {
                if (data.inInterp !== null && data.outInterp !== null) {
                    prop.setInterpolationTypeAtKey(keyIdx, data.inInterp, data.outInterp);
                }
            } catch (errInterp) {}

            try {
                if (data.inEase && data.outEase) {
                    prop.setTemporalEaseAtKey(keyIdx, data.inEase, data.outEase);
                }
            } catch (errEase) {}

            try {
                if (data.temporalContinuous) {
                    prop.setTemporalContinuousAtKey(keyIdx, true);
                }
                if (data.temporalAutoBezier) {
                    prop.setTemporalAutoBezierAtKey(keyIdx, true);
                }
            } catch (errTemp) {}

            try {
                if (data.isSpatial) {
                    if (data.inSpatialTangent && data.outSpatialTangent) {
                        prop.setSpatialTangentsAtKey(keyIdx, data.inSpatialTangent, data.outSpatialTangent);
                    }
                    if (data.spatialContinuous) {
                        prop.setSpatialContinuousAtKey(keyIdx, true);
                    }
                    if (data.spatialAutoBezier) {
                        prop.setSpatialAutoBezierAtKey(keyIdx, true);
                    }
                    if (data.roving) {
                        prop.setRovingAtKey(keyIdx, true);
                    }
                }
            } catch (errSpat) {}
        }
    },

    // Stretch all newly applied preset keyframes on a layer to match layer inPoint/outPoint
    stretchLayerKeyframes: function (layer, snapshot, targetStart, targetEnd) {
        if (typeof targetStart === "undefined") targetStart = layer.inPoint;
        if (typeof targetEnd === "undefined") targetEnd = layer.outPoint;

        if (targetEnd <= targetStart) {
            targetEnd = targetStart + 0.04;
        }

        var detectedProps = this.detectPresetKeyframes(layer, snapshot);
        if (detectedProps.length === 0) {
            $._cfxSuite.debug.log("No new keyframes detected on layer \"" + layer.name + "\".");
            return {
                propertyCount: 0,
                keyCount: 0,
                oldStart: 0,
                oldEnd: 0,
                targetStart: targetStart,
                targetEnd: targetEnd,
                stretchRatio: 1.0
            };
        }

        var bounds = this.calculateTimeBounds(detectedProps);
        var oldSpan = bounds.end - bounds.start;
        var targetSpan = targetEnd - targetStart;
        var ratio = oldSpan > 0.0001 ? (targetSpan / oldSpan) : 1.0;

        $._cfxSuite.debug.log("Keyframe Stretch for Layer [" + layer.index + "] \"" + layer.name + "\":");
        $._cfxSuite.debug.log(" - Detected properties: " + detectedProps.length);
        $._cfxSuite.debug.log(" - Total keyframes: " + bounds.totalKeys);
        $._cfxSuite.debug.log(" - Original range: " + bounds.start.toFixed(3) + "s -> " + bounds.end.toFixed(3) + "s (" + oldSpan.toFixed(3) + "s)");
        $._cfxSuite.debug.log(" - Target range: " + targetStart.toFixed(3) + "s -> " + targetEnd.toFixed(3) + "s (" + targetSpan.toFixed(3) + "s)");
        $._cfxSuite.debug.log(" - Stretch ratio: " + ratio.toFixed(4));

        for (var p = 0; p < detectedProps.length; p++) {
            this.stretchProperty(detectedProps[p], bounds.start, bounds.end, targetStart, targetEnd);
        }

        return {
            propertyCount: detectedProps.length,
            keyCount: bounds.totalKeys,
            oldStart: bounds.start,
            oldEnd: bounds.end,
            targetStart: targetStart,
            targetEnd: targetEnd,
            stretchRatio: ratio
        };
    }
};
