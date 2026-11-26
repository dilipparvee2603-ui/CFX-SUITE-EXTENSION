/**
 * CFX Suite - ExtendScript Utilities
 * Core helper functions, JSON polyfill, and logging.
 */

// JSON Polyfill for ExtendScript (ECMAScript 3 compatible)
if (typeof JSON !== "object") {
    JSON = {};
}

(function () {
    "use strict";

    function f(n) {
        return n < 10 ? "0" + n : n;
    }

    if (typeof Date.prototype.toJSON !== "function") {
        Date.prototype.toJSON = function () {
            return isFinite(this.valueOf())
                ? this.getUTCFullYear() + "-" +
                  f(this.getUTCMonth() + 1) + "-" +
                  f(this.getUTCDate()) + "T" +
                  f(this.getUTCHours()) + ":" +
                  f(this.getUTCMinutes()) + ":" +
                  f(this.getUTCSeconds()) + "Z"
                : null;
        };
        String.prototype.toJSON =
            Number.prototype.toJSON =
            Boolean.prototype.toJSON = function () {
                return this.valueOf();
            };
    }

    var cx = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
        escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
        gap,
        indent,
        meta = {
            "\b": "\\b",
            "\t": "\\t",
            "\n": "\\n",
            "\f": "\\f",
            "\r": "\\r",
            '"': '\\"',
            "\\": "\\\\"
        },
        rep;

    function quote(string) {
        escapable.lastIndex = 0;
        return escapable.test(string)
            ? '"' +
              string.replace(escapable, function (a) {
                  var c = meta[a];
                  return typeof c === "string"
                      ? c
                      : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
              }) +
              '"'
            : '"' + string + '"';
    }

    function str(key, holder) {
        var i, k, v, length, mind = gap, partial, value = holder[key];

        if (value && typeof value === "object" && typeof value.toJSON === "function") {
            value = value.toJSON(key);
        }

        if (typeof rep === "function") {
            value = rep.call(holder, key, value);
        }

        switch (typeof value) {
            case "string":
                return quote(value);
            case "number":
                return isFinite(value) ? String(value) : "null";
            case "boolean":
            case "null":
                return String(value);
            case "object":
                if (!value) {
                    return "null";
                }
                gap += indent;
                partial = [];

                if (Object.prototype.toString.apply(value) === "[object Array]") {
                    length = value.length;
                    for (i = 0; i < length; i += 1) {
                        partial[i] = str(i, value) || "null";
                    }
                    v = partial.length === 0
                        ? "[]"
                        : gap
                        ? "[\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "]"
                        : "[" + partial.join(",") + "]";
                    gap = mind;
                    return v;
                }

                if (rep && typeof rep === "object") {
                    length = rep.length;
                    for (i = 0; i < length; i += 1) {
                        if (typeof rep[i] === "string") {
                            k = rep[i];
                            v = str(k, value);
                            if (v) {
                                partial.push(quote(k) + (gap ? ": " : ":") + v);
                            }
                        }
                    }
                } else {
                    for (k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            v = str(k, value);
                            if (v) {
                                partial.push(quote(k) + (gap ? ": " : ":") + v);
                            }
                        }
                    }
                }

                v = partial.length === 0
                    ? "{}"
                    : gap
                    ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}"
                    : "{" + partial.join(",") + "}";
                gap = mind;
                return v;
        }
    }

    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (value, replacer, space) {
            var i;
            gap = "";
            indent = "";

            if (typeof space === "number") {
                for (i = 0; i < space; i += 1) {
                    indent += " ";
                }
            } else if (typeof space === "string") {
                indent = space;
            }

            rep = replacer;
            if (
                replacer &&
                typeof replacer !== "function" &&
                (typeof replacer !== "object" || typeof replacer.length !== "number")
            ) {
                throw new Error("JSON.stringify");
            }

            return str("", { "": value });
        };
    }

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text, reviver) {
            var j;

            function walk(holder, key) {
                var k, v, value = holder[key];
                if (value && typeof value === "object") {
                    for (k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            v = walk(value, k);
                            if (v !== undefined) {
                                value[k] = v;
                            } else {
                                delete value[k];
                            }
                        }
                    }
                }
                return reviver.call(holder, key, value);
            }

            text = String(text);
            cx.lastIndex = 0;
            if (cx.test(text)) {
                text = text.replace(cx, function (a) {
                    return "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
                });
            }

            if (
                /^[\],:{}\s]*$/.test(
                    text
                        .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                        .replace(
                            /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,
                            "]"
                        )
                        .replace(/(?:^|:|,)(?:\s*\[)+/g, "")
                )
            ) {
                j = eval("(" + text + ")");
                return typeof reviver === "function" ? walk({ "": j }, "") : j;
            }

            throw new SyntaxError("JSON.parse");
        };
    }
})();

// CFX Suite Global Namespace
if (typeof $._cfxSuite === "undefined") {
    $._cfxSuite = {};
}
if (typeof $._dalaSuite === "undefined") {
    $._dalaSuite = $._cfxSuite;
}

// String trim polyfill for ExtendScript (ECMAScript 3 compatibility)
if (typeof String.prototype.trim !== 'function') {
    String.prototype.trim = function () {
        return this.replace(/^\s+|\s+$/g, '');
    };
}

$._cfxSuite.trim = function (str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/^\s+|\s+$/g, "");
};

// Debug Logger
$._cfxSuite.debug = {
    enabled: false,
    logs: [],
    
    setEnabled: function (flag) {
        this.enabled = !!flag;
    },
    
    log: function (message) {
        var strMsg = String(message);
        this.logs.push(strMsg);
        if (this.enabled) {
            $.writeln("[DalaSuite] " + strMsg);
        }
    },
    
    clear: function () {
        this.logs = [];
    },
    
    getLogs: function () {
        return this.logs;
    }
};

// Response Formatter
$._cfxSuite.formatResult = function (success, message, data, error) {
    var res = {
        success: !!success,
        message: message || (success ? "Operation completed successfully." : "Operation failed."),
        data: data || null,
        error: error || (success ? null : (message || "Unknown error")),
        debugLogs: $._cfxSuite.debug.getLogs()
    };
    return JSON.stringify(res);
};

// Safe Undo Wrapper
$._cfxSuite.runWithUndo = function (undoName, actionFn) {
    $._cfxSuite.debug.clear();
    app.beginUndoGroup(undoName);
    try {
        var result = actionFn();
        app.endUndoGroup();
        return result;
    } catch (err) {
        app.endUndoGroup();
        $._cfxSuite.debug.log("ERROR in " + undoName + ": " + err.toString());
        return $._cfxSuite.formatResult(false, err.message || err.toString(), null, err.toString());
    }
};

// Comp & Layer Verification
$._cfxSuite.getActiveComp = function () {
    if (!app.project) {
        throw new Error("No open project in After Effects.");
    }
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) {
        throw new Error("No active composition. Please open and select a composition.");
    }
    return comp;
};

$._cfxSuite.getSelectedLayers = function (comp) {
    if (!comp) {
        comp = $._cfxSuite.getActiveComp();
    }
    var layers = comp.selectedLayers;
    if (!layers || layers.length === 0) {
        throw new Error("Select one or more layers in the active composition.");
    }
    return layers;
};

// Extension Paths
$._cfxSuite.getExtensionFolder = function () {
    // Current file is in host/, so parent is extension root
    var currentFile = new File($.fileName);
    return currentFile.parent.parent;
};

$._cfxSuite.getDefaultPresetsFolder = function (folderName) {
    var extRoot = $._cfxSuite.getExtensionFolder();
    var targetName = folderName || "presets";
    var f = new Folder(extRoot.fsName + "/" + targetName);
    if (!f.exists) {
        f = new Folder(extRoot.fsName + "\\" + targetName);
    }
    // If specific custom folder was requested but doesn't exist, fallback to presets
    if (!f.exists && targetName !== "presets") {
        f = new Folder(extRoot.fsName + "/presets");
        if (!f.exists) {
            f = new Folder(extRoot.fsName + "\\presets");
        }
    }
    return f;
};

// Normalize path string (handles Windows backslashes)
$._cfxSuite.normalizePath = function (pathStr) {
    if (!pathStr) return "";
    return pathStr.replace(/\\/g, "/");
};

// Safe composition playhead navigation
// Clamps CTI time safely within [minTime, comp.duration] to prevent After Effects runtime errors
// e.g. "Unable to set 'time'. Value -0.1 out of range 0 to 10800."
$._cfxSuite.setSafeCompTime = function (comp, time) {
    if (!comp) return 0;
    var minTime = 0;
    try {
        if (typeof comp.displayStartTime === "number" && !isNaN(comp.displayStartTime) && comp.displayStartTime >= 0) {
            minTime = 0;
        }
    } catch (eDisp) {}

    var maxTime = 10800; // AE 3-hour limit fallback
    try {
        if (typeof comp.duration === "number" && !isNaN(comp.duration) && comp.duration > 0) {
            maxTime = comp.duration;
        }
    } catch (eDur) {}

    var safeTime = time;
    if (typeof safeTime !== "number" || isNaN(safeTime)) {
        safeTime = 0;
    }

    if (safeTime < minTime) {
        safeTime = minTime;
    } else if (safeTime > maxTime) {
        safeTime = maxTime;
    }

    try {
        comp.time = safeTime;
    } catch (errTime) {
        // Fallback to minTime if direct assignment threw
        try {
            comp.time = minTime;
            safeTime = minTime;
        } catch (errFallback) {}
    }

    return safeTime;
};

// Validate and retrieve safe layer and playhead timing
// Handles negative inPoints (layers slipped left before 0s), layers beyond comp end, and zero-durations
$._cfxSuite.getValidLayerTiming = function (comp, layer) {
    var minTime = 0;
    var maxTime = 10800;
    if (comp && typeof comp.duration === "number" && !isNaN(comp.duration) && comp.duration > 0) {
        maxTime = comp.duration;
    }

    var inPoint = 0;
    var outPoint = 0;
    try {
        inPoint = layer.inPoint;
        outPoint = layer.outPoint;
    } catch (ePts) {}

    var frameDur = (comp && typeof comp.frameDuration === "number") ? comp.frameDuration : 0.04;
    var rawDuration = outPoint - inPoint;
    var validDuration = rawDuration;
    if (validDuration <= 0) {
        validDuration = frameDur;
        outPoint = inPoint + validDuration;
    }

    // Clamped CTI time for preset placement: must remain within [minTime, maxTime]
    var safeCtiTime = inPoint;
    if (safeCtiTime < minTime) {
        safeCtiTime = minTime;
    } else if (safeCtiTime > maxTime) {
        safeCtiTime = maxTime;
    }

    return {
        rawInPoint: inPoint,
        rawOutPoint: outPoint,
        duration: validDuration,
        safeCtiTime: safeCtiTime,
        isSlippedBeforeZero: inPoint < 0,
        isBeyondCompEnd: outPoint > maxTime,
        minCompTime: minTime,
        maxCompTime: maxTime
    };
};

/**
 * Applies an animation preset (.ffx) only when every effect it uses is available here. Bundled presets use
 * third-party plug-ins (Sapphire, Video Copilot Twitch, Boris FX Continuum, RE:Vision Twixtor, Deep Glow);
 * without them After Effects shows "missing effect" errors and applies half a preset. The preset's effect match
 * names are read from the file itself ("tdmn" entries; an effect is a name that also has "<name>-0001" params).
 */
$._cfxSuite.PLUGIN_NAMES = [
    [/^S_/, "Boris FX Sapphire"], [/^Videocopilot Twitch/i, "Video Copilot Twitch"], [/^BCC/i, "Boris FX Continuum"],
    [/^Twixtor/i, "RE:Vision Twixtor"], [/^PEDG$/, "Deep Glow (Plugin Everything)"], [/^RG /i, "Red Giant (Maxon)"]
];

$._cfxSuite.presetEffects = function (presetFile) {
    var names = [], seen = {}, f = (presetFile instanceof File) ? presetFile : new File(presetFile);
    if (!f.exists) return names;
    f.encoding = "BINARY";
    if (!f.open("r")) return names;
    var s = f.read();
    f.close();
    var all = [], pos = 0;
    while ((pos = s.indexOf("tdmn", pos)) !== -1) {
        var raw = s.substr(pos + 8, 40), end = raw.indexOf("\u0000");
        var nm = end >= 0 ? raw.substr(0, end) : raw;
        if (nm) all.push(nm);
        pos += 4;
    }
    var has = {};
    for (var i = 0; i < all.length; i++) has[all[i]] = true;
    for (i = 0; i < all.length; i++) {
        var n = all[i];
        if (seen[n] || /-\d{4}$/.test(n) || /^ADBE (End of path sentinel|Group End)/.test(n)) continue;
        seen[n] = true;
        if (has[n + "-0001"] || has[n + "-0000"]) names.push(n);
    }
    return names;
};

$._cfxSuite.missingPresetEffects = function (layer, presetFile) {
    var missing = [], fx = null;
    try { fx = layer.property("ADBE Effect Parade"); } catch (e) { fx = null; }
    if (!fx) return missing;
    var list = $._cfxSuite.presetEffects(presetFile);
    for (var i = 0; i < list.length; i++) {
        var ok = false;
        try { ok = fx.canAddProperty(list[i]); } catch (e2) { ok = false; }
        if (!ok) missing.push(list[i]);
    }
    return missing;
};

$._cfxSuite.applyPresetChecked = function (layer, presetFile) {
    var missing = $._cfxSuite.missingPresetEffects(layer, presetFile);
    if (missing.length) {
        var plugins = [], seen = {};
        for (var i = 0; i < missing.length; i++) {
            var label = missing[i];
            for (var k = 0; k < $._cfxSuite.PLUGIN_NAMES.length; k++) if ($._cfxSuite.PLUGIN_NAMES[k][0].test(missing[i])) { label = $._cfxSuite.PLUGIN_NAMES[k][1]; break; }
            if (!seen[label]) { seen[label] = true; plugins.push(label); }
        }
        var name = (presetFile instanceof File) ? presetFile.displayName : String(presetFile).replace(/^.*[\\\/]/, "");
        throw new Error("The preset \"" + decodeURI(name) + "\" needs " + plugins.join(" + ") + ", which is not installed in this After Effects. Install it, or pick a preset without it.");
    }
    layer.applyPreset(presetFile);
};

/**
 * Parses JSON that CFX Suite wrote itself (layer setups in the user's AppData, the caption preset recipe in the
 * extension folder). ExtendScript has no native JSON; the json2 fallback above validates with regular
 * expressions that take ~10 s on a 400 KB setup, while evaluating it takes ~0.1 s. Only an object literal is
 * accepted; anything else goes through the strict parser.
 */
$._cfxSuite.parseOwnJson = function (text) {
    var s = String(text).replace(/^\uFEFF/, "").replace(/^\s+|\s+$/g, "");
    if (s.charAt(0) !== "{" || s.charAt(s.length - 1) !== "}") return JSON.parse(s);
    try { return eval("(" + s + ")"); } catch (e) { return JSON.parse(s); }
};
