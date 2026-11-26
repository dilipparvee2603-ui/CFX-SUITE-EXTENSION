/**
 * Dala Suite - Preset Engine
 * Dynamically discovers .ffx presets and categories from configurable root folder,
 * eliminates playhead bias with safe CTI clamping, and stretches keyframes safely.
 */

if (typeof $._dalaSuite === "undefined") {
    $._dalaSuite = {};
}

$._dalaSuite.presetEngine = {
    customRootDir: "",
    customFolderName: "presets",

    setCustomRootDir: function (dirPath, folderName) {
        if (folderName && typeof folderName === "string" && folderName.trim() !== "") {
            this.customFolderName = folderName.replace(/[\\\/]/g, "").trim();
        }
        if (dirPath && typeof dirPath === "string" && dirPath.trim() !== "") {
            this.customRootDir = $._dalaSuite.normalizePath(dirPath.trim());
            $._dalaSuite.debug.log("Preset root directory updated: " + this.customRootDir);
        } else {
            this.customRootDir = "";
            $._dalaSuite.debug.log("Preset root directory reset to default folder: " + this.customFolderName);
        }
        return this.getRootDir().fsName;
    },

    getRootDir: function () {
        if (this.customRootDir) {
            var customFolder = new Folder(this.customRootDir);
            if (customFolder.exists) {
                return customFolder;
            }
            // Check relative to extension folder
            var extRoot = $._dalaSuite.getExtensionFolder();
            var relFolder = new Folder(extRoot.fsName + "/" + this.customRootDir);
            if (relFolder.exists) {
                return relFolder;
            }
            var relPresetFolder = new Folder(extRoot.fsName + "/presets/" + this.customRootDir);
            if (relPresetFolder.exists) {
                return relPresetFolder;
            }
        }

        // Check configured folder name
        if (this.customFolderName) {
            var extRoot2 = $._dalaSuite.getExtensionFolder();
            var nameFolder = new Folder(extRoot2.fsName + "/" + this.customFolderName);
            if (nameFolder.exists) {
                return nameFolder;
            }
            var namePresetFolder = new Folder(extRoot2.fsName + "/presets/" + this.customFolderName);
            if (namePresetFolder.exists) {
                return namePresetFolder;
            }
        }

        return $._dalaSuite.getDefaultPresetsFolder(this.customFolderName);
    },

    getRootDirName: function () {
        var root = this.getRootDir();
        return root ? root.name : "presets";
    },

    // Resolve preset File object from path, category, or fallback name dynamically
    resolvePreset: function (identifier, category, fallbackFilename) {
        if (identifier) {
            var directFile = new File(identifier);
            if (directFile.exists) return directFile;

            // Check within root directory
            var root = this.getRootDir();
            var checkInRoot = new File(root.fsName + "/" + identifier);
            if (checkInRoot.exists) return checkInRoot;

            if (category) {
                var checkInCat = new File(root.fsName + "/" + category + "/" + identifier);
                if (checkInCat.exists) return checkInCat;
                if (identifier.toLowerCase().indexOf(".ffx") === -1) {
                    var checkWithFfx = new File(root.fsName + "/" + category + "/" + identifier + ".ffx");
                    if (checkWithFfx.exists) return checkWithFfx;
                }
            }

            // Dynamically search across all subfolders in root
            var rootFolders = root.getFiles();
            if (rootFolders) {
                for (var f = 0; f < rootFolders.length; f++) {
                    if (rootFolders[f] instanceof Folder) {
                        var searchFfx = new File(rootFolders[f].fsName + "/" + identifier);
                        if (searchFfx.exists) return searchFfx;
                        if (identifier.toLowerCase().indexOf(".ffx") === -1) {
                            var searchWithExt = new File(rootFolders[f].fsName + "/" + identifier + ".ffx");
                            if (searchWithExt.exists) return searchWithExt;
                        }
                    }
                }
            }
        }

        // Check fallback filename
        if (fallbackFilename) {
            var rootFolder = this.getRootDir();
            if (category) {
                var catFile = new File(rootFolder.fsName + "/" + category + "/" + fallbackFilename);
                if (catFile.exists) return catFile;
            }

            // Search fallback across all subfolders in root
            var allSub = rootFolder.getFiles();
            if (allSub) {
                for (var s = 0; s < allSub.length; s++) {
                    if (allSub[s] instanceof Folder) {
                        var checkFallback = new File(allSub[s].fsName + "/" + fallbackFilename);
                        if (checkFallback.exists) return checkFallback;
                    }
                }
            }

            // Check default presets directory
            var defaultFolder = $._dalaSuite.getDefaultPresetsFolder();
            if (category) {
                var defCatFile = new File(defaultFolder.fsName + "/" + category + "/" + fallbackFilename);
                if (defCatFile.exists) return defCatFile;
            }
            var defFallback = new File(defaultFolder.fsName + "/" + fallbackFilename);
            if (defFallback.exists) return defFallback;
        }

        return null;
    },

    // Dynamically scan directory for all .ffx presets and discover categories from actual folder names
    scanPresets: function (customPath, customFolderName) {
        if (customPath || customFolderName) {
            this.setCustomRootDir(customPath, customFolderName);
        }

        var root = this.getRootDir();
        if (!root.exists) {
            throw new Error("Preset root directory does not exist:\n" + root.fsName);
        }

        var discovered = [];
        var categoriesSet = {};
        var discoveredCategories = [];

        function registerCategory(catName) {
            if (!catName) return;
            var catKey = catName.toLowerCase();
            if (!categoriesSet[catKey]) {
                categoriesSet[catKey] = true;
                discoveredCategories.push(catName);
            }
        }

        function scanFolder(folder, categoryName) {
            if (!folder.exists) return;
            var items = folder.getFiles();
            if (!items) return;

            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item instanceof File) {
                    var name = item.name;
                    if (name.slice(-4).toLowerCase() === ".ffx") {
                        var displayName = name.slice(0, -4);
                        discovered.push({
                            name: displayName,
                            filename: name,
                            path: item.fsName,
                            category: categoryName,
                            categoryId: categoryName.toLowerCase(),
                            size: item.length
                        });
                        registerCategory(categoryName);
                    }
                } else if (item instanceof Folder) {
                    // Check nested subfolders
                    scanFolder(item, categoryName);
                }
            }
        }

        // 1. Dynamically scan all subdirectories inside root: each folder name is a category
        var rootItems = root.getFiles();
        if (rootItems) {
            for (var i = 0; i < rootItems.length; i++) {
                var item = rootItems[i];
                if (item instanceof Folder) {
                    var folderName = item.name;
                    // Skip hidden or system folders (e.g. .git, .DS_Store)
                    if (folderName.indexOf(".") === 0) continue;
                    scanFolder(item, folderName);
                } else if (item instanceof File) {
                    var fName = item.name;
                    if (fName.slice(-4).toLowerCase() === ".ffx") {
                        var rootCat = (root.name && root.name.toLowerCase() !== "presets") ? root.name : "Root";
                        discovered.push({
                            name: fName.slice(0, -4),
                            filename: fName,
                            path: item.fsName,
                            category: rootCat,
                            categoryId: rootCat.toLowerCase(),
                            size: item.length
                        });
                        registerCategory(rootCat);
                    }
                }
            }
        }

        $._dalaSuite.debug.log("Discovered " + discovered.length + " .ffx presets in root: " + root.fsName + " across categories: " + discoveredCategories.join(", "));

        return $._dalaSuite.formatResult(true, "Discovered " + discovered.length + " presets.", {
            rootDir: root.fsName,
            rootFolderName: root.name,
            categories: discoveredCategories,
            presets: discovered
        });
    },

    // Apply generic preset to selected layers with independent layer isolation & keyframe stretch
    applyGenericPreset: function (presetPath, shouldStretch, extraFps) {
        return $._dalaSuite.runWithUndo("Dala Suite - Apply Preset", function () {
            var comp = $._dalaSuite.getActiveComp();
            var selectedLayers = $._dalaSuite.getSelectedLayers(comp);

            var presetFile = new File(presetPath);
            if (!presetFile.exists) {
                throw new Error("Preset not found:\n" + presetPath);
            }

            var origTime = comp.time;
            var origSelection = [];
            for (var s = 0; s < selectedLayers.length; s++) {
                origSelection.push(selectedLayers[s].index);
            }

            var processedCount = 0;
            for (var i = 0; i < selectedLayers.length; i++) {
                var layer = selectedLayers[i];

                // 1. Isolate selection to this layer only
                for (var d = 1; d <= comp.numLayers; d++) {
                    comp.layer(d).selected = false;
                }
                layer.selected = true;

                // 2. Safely move CTI to layer inPoint (clamped to [0, comp.duration] to eliminate playhead bias)
                var timing = $._dalaSuite.getValidLayerTiming(comp, layer);
                $._dalaSuite.setSafeCompTime(comp, timing.safeCtiTime);

                // 3. Snapshot layer properties before applying preset
                var snapshot = shouldStretch ? $._dalaSuite.keyframeEngine.snapshotLayer(layer) : null;

                // 4. Apply preset
                $._dalaSuite.applyPresetChecked(layer, presetFile);

                // 5. Intelligent detection: if preset added Twixtor effect, configure FPS & uncheck "In FPS is Out FPS"
                if ($._dalaSuite.twixtor && $._dalaSuite.twixtor.findTwixtorEffect) {
                    var twx = $._dalaSuite.twixtor.findTwixtorEffect(layer);
                    if (twx) {
                        var targetFps = (extraFps && !isNaN(parseFloat(extraFps))) ? parseFloat(extraFps) : (comp ? Math.round(1 / comp.frameDuration) : 60);
                        $._dalaSuite.twixtor.configureTwixtorFPS(twx, targetFps);
                    }
                }

                // 6. Intelligent detection: if preset is Zoom or has zoom center, adapt center
                if ($._dalaSuite.zoom && $._dalaSuite.zoom.adaptZoomCenter) {
                    try {
                        $._dalaSuite.zoom.adaptZoomCenter(layer, snapshot, comp);
                    } catch (eZoom) {}
                }

                // 7. If stretch enabled, remap keyframe time positions without altering values or easing
                if (shouldStretch && snapshot) {
                    var newProps = $._dalaSuite.keyframeEngine.detectPresetKeyframes(layer, snapshot);
                    if (newProps.length > 0) {
                        var bounds = $._dalaSuite.keyframeEngine.calculateTimeBounds(newProps);
                        if (bounds.totalKeys > 0) {
                            var oldStart = bounds.start;
                            var oldEnd = bounds.end;
                            var targetStart = layer.inPoint;
                            var targetEnd = layer.outPoint;

                            for (var p = 0; p < newProps.length; p++) {
                                var prop = newProps[p];
                                $._dalaSuite.keyframeEngine.remapTimeOnly(prop, oldStart, oldEnd, targetStart, targetEnd);
                            }
                        }
                    }
                }
                processedCount++;
            }

            // Restore playhead and multi-selection safely
            $._dalaSuite.setSafeCompTime(comp, origTime);
            for (var r = 0; r < origSelection.length; r++) {
                try {
                    comp.layer(origSelection[r]).selected = true;
                } catch (eSel) {}
            }

            return $._dalaSuite.formatResult(
                true,
                "Applied preset \"" + presetFile.name.replace(/\.ffx$/i, "") + "\" to " + processedCount + " layer(s)" + (shouldStretch ? " (stretched)." : "."),
                { count: processedCount, preset: presetFile.name, stretched: shouldStretch }
            );
        });
    }
};
