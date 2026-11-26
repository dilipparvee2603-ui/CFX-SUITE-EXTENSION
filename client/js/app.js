/**
 * Dala Suite - Client Application Logic
 * Dark Marine Blue Theme Pro Architecture
 * Independent multi-layer Twixtor speed ramping, 3-layer Cut To F timeline split,
 * and stretch keyframes toggles across all tools.
 */

(function () {
    'use strict';

    // Application State
    var state = {
        cs: null,
        isCep: false,
        activeView: 'home',
        activeTwixtorSubTab: 'dialog',
        compInfo: {
            hasComp: false,
            compName: "No Active Comp",
            width: 1920,
            height: 1080,
            fps: 60,
            selectedLayerCount: 0,
            selectedLayers: []
        },
        settings: {
            presetRootDir: "",
            presetFolderName: "presets",
            showBannerVideo: true,
            debugMode: false,
            defaultFps: 60,
            twixtorStretchKeyframes: true,
            zoomStretchKeyframes: true,
            shakeStretchKeyframes: false
        },
        presets: [],
        presetCategories: [],
        selectedPreset: null,
        selectedShakePreset: "Individual Clip Shake 1.ffx",
        selectedZoomPreset: "myzoom.ffx",
        selectedTwixtorSpeedPreset: "twixtor mid fast speedramp.ffx",
        selectedCategoryForView: null,
        selectedCategoryPreset: null,
        activeCategoryFilter: 'all',
        debugLogs: []
    };

    // DOM Elements Cache
    var dom = {};

    function init() {
        cacheDom();
        loadSettings();
        initCSInterface();
        initBannerElement();
        bindEvents();
        updateUI();
        refreshCompInfo();
        refreshPresets();
    }

    function cacheDom() {
        dom.navItems = document.querySelectorAll('.nav-item');
        dom.views = document.querySelectorAll('.view-panel');
        dom.bannerContainer = document.getElementById('banner-container');
        dom.bannerVideo = document.getElementById('banner-video');
        dom.bannerCanvas = document.getElementById('banner-canvas');
        
        // Header & Status
        dom.brandHomeBtn = document.getElementById('brand-home-btn');
        dom.btnReload = document.getElementById('btn-reload');
        dom.btnSettingsHeader = document.getElementById('btn-settings-header');
        dom.compDot = document.getElementById('comp-status-dot');
        dom.compName = document.getElementById('comp-name-text');
        dom.compDetails = document.getElementById('comp-details-text');
        dom.layerBadge = document.getElementById('selected-layers-badge');
        
        // Home view quick buttons
        dom.quickCutToF = document.getElementById('quick-cut-to-f');
        dom.quickTwixtorDialog = document.getElementById('quick-twixtor-dialog');
        dom.quickTwixtorSpeed = document.getElementById('quick-twixtor-speed');
        dom.quickZoom = document.getElementById('quick-zoom');
        dom.quickShake = document.getElementById('quick-shake');
        dom.quickShakeTitle = document.getElementById('quick-shake-title');
        dom.quickShakeSub = document.getElementById('quick-shake-sub');
        dom.dynamicHomeCards = document.getElementById('dynamic-home-cards');

        // Nav items & dynamic mounts
        dom.navItemShake = document.getElementById('nav-item-shake');
        dom.navTextShake = document.getElementById('nav-text-shake');
        dom.dynamicNavCategories = document.getElementById('dynamic-nav-categories');
        
        // Cut To F View
        dom.btnApplyCutToF = document.getElementById('btn-apply-cut-to-f');
        
        // Twixtor View: Sub-Tabs & Cards
        dom.tabTwixtorDialog = document.getElementById('tab-twixtor-dialog');
        dom.tabTwixtorSpeed = document.getElementById('tab-twixtor-speed');
        dom.cardTwixtorDialog = document.getElementById('twixtor-dialog-card');
        dom.cardTwixtorSpeed = document.getElementById('twixtor-speed-card');
        
        // Twixtor Dialog Controls
        dom.twixtorDialogFps = document.getElementById('twixtor-dialog-fps');
        dom.btnApplyTwixtorDialog = document.getElementById('btn-apply-twixtor-dialog');
        
        // Twixtor Speed Controls
        dom.twixtorSpeedFps = document.getElementById('twixtor-speed-fps');
        dom.twixtorSpeedPresetSelect = document.getElementById('twixtor-speed-preset-select');
        dom.twixtorStretchToggle = document.getElementById('twixtor-stretch-toggle');
        dom.btnApplyTwixtorSpeed = document.getElementById('btn-apply-twixtor-speed');
        
        // Zoom View Controls
        dom.zoomPresetSelect = document.getElementById('zoom-preset-select');
        dom.zoomCenterDisplay = document.getElementById('zoom-center-display');
        dom.zoomStretchToggle = document.getElementById('zoom-stretch-toggle');
        dom.btnApplyZoom = document.getElementById('btn-apply-zoom');
        
        // Shake View Controls
        dom.shakeSectionTitle = document.getElementById('shake-section-title');
        dom.shakeSectionTag = document.getElementById('shake-section-tag');
        dom.shakePresetsList = document.getElementById('shake-presets-list');
        dom.shakeStretchToggle = document.getElementById('shake-stretch-toggle');
        dom.btnApplyShake = document.getElementById('btn-apply-shake');
        dom.btnApplyShakeLabel = document.getElementById('btn-apply-shake-label');

        // Dynamic Category View (Arbitrary discovered folders)
        dom.viewCategory = document.getElementById('view-category');
        dom.categorySectionTitle = document.getElementById('category-section-title');
        dom.categorySectionDesc = document.getElementById('category-section-desc');
        dom.categorySectionTag = document.getElementById('category-section-tag');
        dom.categoryPresetsList = document.getElementById('category-presets-list');
        dom.categoryStretchToggle = document.getElementById('category-stretch-toggle');
        dom.btnApplyCategoryPreset = document.getElementById('btn-apply-category-preset');
        dom.btnApplyCategoryLabel = document.getElementById('btn-apply-category-label');
        
        // Presets View
        dom.presetFilterTabs = document.getElementById('preset-filter-tabs') || document.querySelector('.filter-tabs');
        dom.presetCategoryTabs = document.querySelectorAll('.filter-tabs .tab-btn');
        dom.presetSearchInput = document.getElementById('preset-search-input');
        dom.presetListContainer = document.getElementById('presets-browser-list') || document.getElementById('preset-list-container');
        dom.btnRefreshPresets = document.getElementById('btn-refresh-presets');
        dom.btnApplyBrowserPreset = document.getElementById('btn-apply-browser-preset');
        dom.presetStretchToggle = document.getElementById('preset-stretch-toggle');

        // Settings View
        dom.rootDirDisplay = document.getElementById('root-dir-display');
        dom.presetFolderInput = document.getElementById('preset-folder-input');
        dom.btnSetPresetFolder = document.getElementById('btn-set-preset-folder');
        dom.btnChangeRootDir = document.getElementById('btn-change-root-dir');
        dom.btnResetRootDir = document.getElementById('btn-reset-root-dir');
        dom.bannerToggle = document.getElementById('banner-video-toggle');
        dom.debugModeToggle = document.getElementById('debug-mode-toggle');
        dom.debugTerminalContainer = document.getElementById('debug-terminal-container');
        dom.debugTerminal = document.getElementById('debug-terminal');
        dom.btnClearLogs = document.getElementById('btn-clear-logs');
        dom.btnCopyLogs = document.getElementById('btn-copy-logs');
        
        // Browser Dev Simulator Panel
        dom.simPanel = document.getElementById('browser-simulator-panel');
        dom.simCompBtns = document.querySelectorAll('.sim-comp-btn');
        dom.simLayerChips = document.getElementById('sim-layer-chips');
        
        // Toast container
        dom.toastContainer = document.getElementById('toast-container');
    }

    function initCSInterface() {
        try {
            state.cs = new CSInterface();
            state.isCep = state.cs.isCep();
        } catch (e) {
            console.warn("Could not instantiate CSInterface:", e);
            state.isCep = false;
        }

        if (dom.simPanel) {
            dom.simPanel.style.display = state.isCep ? 'none' : 'block';
        }
    }

    // Lightweight Background Banner Controller (Continuous, GPU-optimized, auto-releasing)
    var bannerCanvasAnimId = null;
    var bannerVideoActive = false;

    function initBannerElement() {
        if (!dom.bannerVideo) return;

        // Strict background properties: muted, autoplay, continuous loop, zero interaction
        dom.bannerVideo.muted = true;
        dom.bannerVideo.defaultMuted = true;
        dom.bannerVideo.playsInline = true;
        dom.bannerVideo.loop = true;
        dom.bannerVideo.setAttribute('muted', '');
        dom.bannerVideo.setAttribute('playsinline', '');
        dom.bannerVideo.setAttribute('loop', '');

        // Fallback loop trigger in case underlying CEF engine stalls on loop end
        dom.bannerVideo.addEventListener('ended', function () {
            if (state.settings.showBannerVideo) {
                dom.bannerVideo.currentTime = 0;
                dom.bannerVideo.play().catch(function () {});
            }
        });

        // Setup Draggable Banner Height Resizer with Persistence & 50% Default
        initBannerResizer();

        // When video is successfully playing, stop canvas fallback to save 100% of canvas CPU cycles
        dom.bannerVideo.addEventListener('playing', function () {
            bannerVideoActive = true;
            if (dom.bannerVideo) dom.bannerVideo.style.display = 'block';
            stopBannerCanvasFallback();
        });

        // If video fails or cannot decode, seamlessly switch to lightweight canvas
        var handleVideoError = function (e) {
            console.warn("Banner video notice: switching to lightweight animated canvas fallback.", e);
            bannerVideoActive = false;
            if (dom.bannerVideo) dom.bannerVideo.style.display = 'none';
            startBannerCanvasFallback();
        };

        dom.bannerVideo.addEventListener('error', handleVideoError);
        var vSource = dom.bannerVideo.querySelector('source');
        if (vSource) {
            vSource.addEventListener('error', handleVideoError);
        }

        // Auto-pause when panel is hidden/minimized to release GPU/CPU back to After Effects
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                if (dom.bannerVideo && !dom.bannerVideo.paused) {
                    dom.bannerVideo.pause();
                }
                stopBannerCanvasFallback();
            } else {
                if (state.settings.showBannerVideo) {
                    if (dom.bannerVideo && bannerVideoActive && dom.bannerVideo.paused) {
                        dom.bannerVideo.play().catch(function () {});
                    } else if (!bannerVideoActive) {
                        startBannerCanvasFallback();
                    }
                }
            }
        });

        if (state.settings.showBannerVideo) {
            startBannerVideo();
        } else {
            releaseBannerResources();
        }
    }

    // Interactive Vertical Resizer for Banner Height (Defaults to ~50% height with persistence)
    function initBannerResizer() {
        var resizer = document.getElementById('banner-resizer');
        var container = dom.bannerContainer;
        if (!resizer || !container) return;

        var DEFAULT_HEIGHT = 108; // ~50% height matching guideline in user screenshot
        var MIN_HEIGHT = 48;
        var MAX_HEIGHT = 340;

        function setHeight(h, persist) {
            h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h)));
            container.style.height = h + 'px';
            if (dom.bannerVideo) {
                dom.bannerVideo.style.height = '100%';
                dom.bannerVideo.style.objectFit = 'cover';
                dom.bannerVideo.style.objectPosition = 'center center';
            }
            if (persist) {
                try {
                    localStorage.setItem('dala_banner_custom_height', h.toString());
                } catch (e) {}
            }
        }

        // Restore saved preference if any
        try {
            var saved = localStorage.getItem('dala_banner_custom_height');
            if (saved) {
                var parsed = parseInt(saved, 10);
                if (!isNaN(parsed) && parsed >= MIN_HEIGHT && parsed <= MAX_HEIGHT) {
                    setHeight(parsed, false);
                } else {
                    setHeight(DEFAULT_HEIGHT, false);
                }
            } else {
                setHeight(DEFAULT_HEIGHT, false);
            }
        } catch (e) {
            setHeight(DEFAULT_HEIGHT, false);
        }

        // Drag events
        var isDragging = false;
        var startY = 0;
        var startH = 0;

        resizer.addEventListener('mousedown', function (e) {
            e.preventDefault();
            isDragging = true;
            startY = e.clientY;
            startH = container.getBoundingClientRect().height;
            resizer.classList.add('active');
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';

            function onMouseMove(moveEvent) {
                if (!isDragging) return;
                var delta = moveEvent.clientY - startY;
                setHeight(startH + delta, false);
            }

            function onMouseUp(upEvent) {
                if (!isDragging) return;
                isDragging = false;
                resizer.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                var finalH = container.getBoundingClientRect().height;
                setHeight(finalH, true);
            }

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });

        // Double click resets to optimal 50% default
        resizer.addEventListener('dblclick', function () {
            setHeight(DEFAULT_HEIGHT, true);
            showToast("Banner height reset to 50% default (" + DEFAULT_HEIGHT + "px).", "info");
        });
    }

    function startBannerVideo() {
        if (!dom.bannerVideo) return;
        dom.bannerVideo.style.display = 'block';
        if (!dom.bannerVideo.src || dom.bannerVideo.src === window.location.href) {
            dom.bannerVideo.src = 'assets/banner/banner.mp4';
        }
        dom.bannerVideo.play().catch(function (e) {
            console.log("Banner autoplay note:", e.message);
            startBannerCanvasFallback();
        });
    }

    function releaseBannerResources() {
        if (!dom.bannerVideo) return;
        // Cease playback and instruct Chromium to release GPU decoder and hardware textures
        dom.bannerVideo.pause();
        dom.bannerVideo.removeAttribute('src');
        var sources = dom.bannerVideo.querySelectorAll('source');
        sources.forEach(function (s) { s.removeAttribute('src'); });
        dom.bannerVideo.load();
        dom.bannerVideo.style.display = 'none';
        bannerVideoActive = false;
        stopBannerCanvasFallback();
    }

    function startBannerCanvasFallback() {
        if (!dom.bannerCanvas) return;
        if (bannerCanvasAnimId) return; // Already running
        dom.bannerCanvas.style.display = 'block';
        
        var canvas = dom.bannerCanvas;
        var ctx = canvas.getContext('2d');
        var w = canvas.width = canvas.parentElement ? (canvas.parentElement.clientWidth || 380) : 380;
        var h = canvas.height = canvas.parentElement ? (canvas.parentElement.clientHeight || 56) : 56;

        var particles = [];
        for (var i = 0; i < 20; i++) {
            particles.push({
                x: Math.random() * w,
                y: Math.random() * h,
                vx: 0.25 + Math.random() * 0.5,
                vy: (Math.random() - 0.5) * 0.2,
                r: 1.0 + Math.random() * 1.8,
                alpha: 0.2 + Math.random() * 0.4
            });
        }

        var t = 0;
        function render() {
            if (!state.settings.showBannerVideo || bannerVideoActive) {
                stopBannerCanvasFallback();
                return;
            }
            t += 0.012;
            ctx.clearRect(0, 0, w, h);

            var grad = ctx.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, '#040912');
            grad.addColorStop(0.5, '#0b1626');
            grad.addColorStop(1, '#050c18');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            ctx.beginPath();
            for (var x = 0; x <= w; x += 20) {
                var y = (h * 0.5) + Math.sin(t + x * 0.015) * (h * 0.25);
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.22)';
            ctx.lineWidth = 10;
            ctx.stroke();

            for (var p = 0; p < particles.length; p++) {
                var pt = particles[p];
                pt.x += pt.vx;
                pt.y += pt.vy;
                if (pt.x > w) pt.x = 0;
                if (pt.y < 0) pt.y = h;
                if (pt.y > h) pt.y = 0;

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(68, 138, 255, ' + pt.alpha + ')';
                ctx.fill();
            }

            bannerCanvasAnimId = requestAnimationFrame(render);
        }
        bannerCanvasAnimId = requestAnimationFrame(render);
    }

    function stopBannerCanvasFallback() {
        if (bannerCanvasAnimId) {
            cancelAnimationFrame(bannerCanvasAnimId);
            bannerCanvasAnimId = null;
        }
        if (dom.bannerCanvas) {
            dom.bannerCanvas.style.display = 'none';
        }
    }

    function loadSettings() {
        try {
            var saved = localStorage.getItem('dala_suite_settings');
            if (saved) {
                var parsed = JSON.parse(saved);
                for (var key in parsed) {
                    if (state.settings.hasOwnProperty(key)) {
                        state.settings[key] = parsed[key];
                    }
                }
            }
        } catch (e) {
            console.warn("Failed to load settings:", e);
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem('dala_suite_settings', JSON.stringify(state.settings));
        } catch (e) {
            console.warn("Failed to save settings:", e);
        }
    }

    function bindEvents() {
        // Navigation clicks (sidebar and sub-tabs with data-view)
        document.querySelectorAll('.nav-item, .subtab-btn[data-view]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var target = btn.getAttribute('data-view');
                if (target) switchView(target);
            });
        });

        // Brand click -> return Home
        if (dom.brandHomeBtn) {
            dom.brandHomeBtn.addEventListener('click', function () {
                switchView('captions');
            });
        }

        // Header reload
        if (dom.btnReload) {
            dom.btnReload.addEventListener('click', function () {
                refreshCompInfo();
                refreshPresets();
                showToast("Reloaded comp status & presets.", "info");
            });
        }

        // Header donate: opens the donation page in the user's default browser
        var btnDonate = document.getElementById('btn-donate');
        if (btnDonate) {
            btnDonate.addEventListener('click', function () {
                var url = 'https://buymeachai.ezee.li/dala_aep';
                try {
                    if (state.cs && state.cs.openURLInDefaultBrowser) state.cs.openURLInDefaultBrowser(url);
                    else window.open(url, '_blank');
                    showToast("Opening the donation page in your browser. Thank you!", "info");
                } catch (eD) {
                    showToast("Could not open the browser. Donate at " + url, "error");
                }
            });
        }

        // Header settings
                // Presets category subtabs (Shakes, Zooms, Twixtor, Setups, Browser)
        var ptabBtns = document.querySelectorAll('#presets-subtabs .subtab-btn');
        var ptabPanels = {
            shake: document.getElementById('ptab-panel-shake'),
            zoom: document.getElementById('ptab-panel-zoom'),
            twixtor: document.getElementById('ptab-panel-twixtor'),
            setups: document.getElementById('ptab-panel-setups'),
            browser: document.getElementById('ptab-panel-browser')
        };

        ptabBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var target = btn.getAttribute('data-ptab');
                if (!target) return;

                ptabBtns.forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');

                for (var key in ptabPanels) {
                    if (ptabPanels[key]) {
                        ptabPanels[key].style.display = (key === target) ? 'block' : 'none';
                    }
                }

                if (target === 'zoom') {
                    updateZoomCenterDisplay();
                } else if (target === 'shake') {
                    renderShakeView();
                } else if (target === 'browser') {
                    refreshPresets();
                    renderPresetsList();
                } else if (target === 'setups') {
                    if (window.DalaSetupsUI && window.DalaSetupsUI.refresh) {
                        window.DalaSetupsUI.refresh();
                    }
                }
            });
        });

        if (dom.btnSettingsHeader) {
            dom.btnSettingsHeader.addEventListener('click', function () {
                switchView('settings');
            });
        }

        // Home Quick Buttons
        if (dom.quickCutToF) {
            dom.quickCutToF.addEventListener('click', function () {
                switchView('cut-to-f');
            });
        }
        if (dom.quickTwixtorDialog) {
            dom.quickTwixtorDialog.addEventListener('click', function () {
                switchView('twixtor');
                setTwixtorSubTab('dialog');
            });
        }
        if (dom.quickTwixtorSpeed) {
            dom.quickTwixtorSpeed.addEventListener('click', function () {
                switchView('twixtor');
                setTwixtorSubTab('speed');
            });
        }
        if (dom.quickZoom) {
            dom.quickZoom.addEventListener('click', function () {
                switchView('zoom');
            });
        }
        if (dom.quickShake) {
            dom.quickShake.addEventListener('click', function () {
                switchView('shake');
            });
        }

        // Cut To F View: Split into 3 layers
        if (dom.btnApplyCutToF) {
            dom.btnApplyCutToF.addEventListener('click', function () {
                handleCutToF();
            });
        }
        var btnQuickCutToF = document.getElementById('btn-quick-cut-to-f');
        if (btnQuickCutToF) {
            btnQuickCutToF.addEventListener('click', function () {
                handleCutToF();
            });
        }

        // Twixtor Sub-Tab Buttons (Instant seamless switching)
        if (dom.tabTwixtorDialog) {
            dom.tabTwixtorDialog.addEventListener('click', function () {
                setTwixtorSubTab('dialog');
            });
        }
        if (dom.tabTwixtorSpeed) {
            dom.tabTwixtorSpeed.addEventListener('click', function () {
                setTwixtorSubTab('speed');
            });
        }

        // Twixtor Dialog Apply
        if (dom.btnApplyTwixtorDialog) {
            dom.btnApplyTwixtorDialog.addEventListener('click', function () {
                var fps = dom.twixtorDialogFps.value || "60";
                handleTwixtorDialog(fps);
            });
        }

        // Twixtor Speed Apply (With Stretch Keyframe toggle)
        if (dom.btnApplyTwixtorSpeed) {
            dom.btnApplyTwixtorSpeed.addEventListener('click', function () {
                var fps = dom.twixtorSpeedFps.value || "60";
                var preset = dom.twixtorSpeedPresetSelect.value || state.selectedTwixtorSpeedPreset;
                var shouldStretch = dom.twixtorStretchToggle ? dom.twixtorStretchToggle.checked : true;
                handleTwixtorSpeed(fps, preset, shouldStretch);
            });
        }

        if (dom.twixtorStretchToggle) {
            dom.twixtorStretchToggle.checked = state.settings.twixtorStretchKeyframes;
            dom.twixtorStretchToggle.addEventListener('change', function () {
                state.settings.twixtorStretchKeyframes = dom.twixtorStretchToggle.checked;
                saveSettings();
            });
        }

        // Zoom View Apply (With Stretch Keyframe toggle)
        if (dom.btnApplyZoom) {
            dom.btnApplyZoom.addEventListener('click', function () {
                var preset = dom.zoomPresetSelect.value || state.selectedZoomPreset;
                var shouldStretch = dom.zoomStretchToggle ? dom.zoomStretchToggle.checked : true;
                handleZoom(preset, shouldStretch);
            });
        }

        if (dom.zoomStretchToggle) {
            dom.zoomStretchToggle.checked = state.settings.zoomStretchKeyframes;
            dom.zoomStretchToggle.addEventListener('change', function () {
                state.settings.zoomStretchKeyframes = dom.zoomStretchToggle.checked;
                saveSettings();
            });
        }

        // Shake View: Apply & Stretch Toggle
        if (dom.shakeStretchToggle) {
            dom.shakeStretchToggle.checked = state.settings.shakeStretchKeyframes;
            dom.shakeStretchToggle.addEventListener('change', function () {
                state.settings.shakeStretchKeyframes = dom.shakeStretchToggle.checked;
                saveSettings();
            });
        }

        if (dom.btnApplyShake) {
            dom.btnApplyShake.addEventListener('click', function () {
                if (!state.selectedShakePreset) {
                    showToast("Select a preset first.", "error");
                    return;
                }
                var shouldStretch = dom.shakeStretchToggle ? dom.shakeStretchToggle.checked : false;
                handleShake(state.selectedShakePreset, shouldStretch);
            });
        }

        // Dynamic Category View Apply
        if (dom.btnApplyCategoryPreset) {
            dom.btnApplyCategoryPreset.addEventListener('click', function () {
                if (!state.selectedCategoryPreset) {
                    showToast("Select a preset first.", "error");
                    return;
                }
                var shouldStretch = dom.categoryStretchToggle ? dom.categoryStretchToggle.checked : true;
                handleApplyGenericPreset(state.selectedCategoryPreset.path, shouldStretch);
            });
        }

        // Presets Browser: Category Tabs
        dom.presetCategoryTabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                dom.presetCategoryTabs.forEach(function (t) { t.classList.remove('active'); });
                tab.classList.add('active');
                state.activeCategoryFilter = tab.getAttribute('data-category') || 'all';
                renderPresetsList();
            });
        });

        // Search Input
        if (dom.presetSearchInput) {
            dom.presetSearchInput.addEventListener('input', function () {
                renderPresetsList();
            });
        }

        // Refresh Presets
        if (dom.btnRefreshPresets) {
            dom.btnRefreshPresets.addEventListener('click', function () {
                refreshPresets(true);
            });
        }

        // Apply from Presets Browser
        if (dom.btnApplyBrowserPreset) {
            dom.btnApplyBrowserPreset.addEventListener('click', function () {
                if (!state.selectedPreset) {
                    showToast("Select a preset from the list first.", "error");
                    return;
                }
                var shouldStretch = dom.presetStretchToggle ? dom.presetStretchToggle.checked : true;
                handleApplyGenericPreset(state.selectedPreset.path, shouldStretch);
            });
        }


        // Settings View: Root Directory & Custom Folder Name
        if (dom.btnSetPresetFolder) {
            dom.btnSetPresetFolder.addEventListener('click', function () {
                handleSetPresetFolder();
            });
        }

        if (dom.presetFolderInput) {
            dom.presetFolderInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSetPresetFolder();
                }
            });
        }

        if (dom.btnChangeRootDir) {
            dom.btnChangeRootDir.addEventListener('click', function () {
                handleChangeRootDir();
            });
        }

        if (dom.btnResetRootDir) {
            dom.btnResetRootDir.addEventListener('click', function () {
                handleResetRootDir();
            });
        }

        // Banner Toggle
        if (dom.bannerToggle) {
            dom.bannerToggle.checked = state.settings.showBannerVideo;
            dom.bannerToggle.addEventListener('change', function () {
                state.settings.showBannerVideo = dom.bannerToggle.checked;
                saveSettings();
                updateBannerVisibility();
                showToast("Banner video " + (state.settings.showBannerVideo ? "enabled." : "hidden."), "info");
            });
        }

        // Debug Mode Toggle
        if (dom.debugModeToggle) {
            dom.debugModeToggle.checked = state.settings.debugMode;
            dom.debugModeToggle.addEventListener('change', function () {
                state.settings.debugMode = dom.debugModeToggle.checked;
                saveSettings();
                updateDebugTerminalVisibility();
                evalHostScript("$._dalaSuite.debug.setEnabled(" + state.settings.debugMode + ");", null);
                showToast("Debug mode " + (state.settings.debugMode ? "activated." : "deactivated."), "info");
            });
        }

        if (dom.btnClearLogs) {
            dom.btnClearLogs.addEventListener('click', function () {
                state.debugLogs = [];
                renderDebugLogs();
                showToast("Debug logs cleared.", "info");
            });
        }

        if (dom.btnCopyLogs) {
            dom.btnCopyLogs.addEventListener('click', function () {
                var text = state.debugLogs.join("\n");
                navigator.clipboard.writeText(text).then(function () {
                    showToast("Logs copied to clipboard.", "success");
                }).catch(function () {
                    showToast("Failed to copy logs.", "error");
                });
            });
        }

        // Browser Dev Simulator Controls
        dom.simCompBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                dom.simCompBtns.forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                var w = parseInt(btn.getAttribute('data-w'), 10);
                var h = parseInt(btn.getAttribute('data-h'), 10);
                if (window.DalaHostSimulator) {
                    window.DalaHostSimulator.setCompResolution(w, h);
                    refreshCompInfo();
                }
            });
        });
    }

    function switchView(viewName, categoryName) {
        // Map sub-views to primary pillar for sidebar highlighting
        var navView = viewName;
        if (viewName === 'audio' || viewName === 'stems' || viewName === 'sfx') {
            navView = 'audio';
        } else if (viewName === 'presets' || viewName === 'shake' || viewName === 'zoom' || viewName === 'twixtor' || viewName === 'setups' || viewName === 'browser' || viewName === 'category') {
            navView = 'presets';
        } else if (viewName === 'general' || viewName === 'cut-to-f') {
            navView = 'general';
        }

        state.activeView = viewName;
        if (viewName === 'category' && categoryName) {
            state.selectedCategoryForView = categoryName;
        }

        // Highlight matching sidebar nav button
        var allNavItems = document.querySelectorAll('.nav-item');
        allNavItems.forEach(function (item) {
            var v = item.getAttribute('data-view');
            var cat = item.getAttribute('data-category');
            if (viewName === 'category') {
                if (v === 'category' && cat && state.selectedCategoryForView && cat.toLowerCase() === state.selectedCategoryForView.toLowerCase()) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            } else {
                if (v === navView) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            }
        });

        // If switching to a preset subtab (shake, zoom, twixtor, setups, browser)
        if (viewName === 'shake' || viewName === 'zoom' || viewName === 'twixtor' || viewName === 'setups' || viewName === 'browser') {
            var ptabBtn = document.querySelector('#presets-subtabs .subtab-btn[data-ptab="' + viewName + '"]');
            if (ptabBtn) ptabBtn.click();
            viewName = 'presets';
        }

        // Display matching view panel
        dom.views.forEach(function (panel) {
            var panelId = panel.id.replace('view-', '');
            if (panelId === viewName) {
                panel.style.display = 'flex';
            } else {
                panel.style.display = 'none';
            }
        });

        // Trigger view-specific refreshes
        if (viewName === 'zoom') {
            updateZoomCenterDisplay();
        } else if (viewName === 'shake') {
            renderShakeView();
        } else if (viewName === 'category') {
            renderCategoryView(state.selectedCategoryForView);
        } else if (viewName === 'presets') {
            refreshPresets();
            renderPresetsList();
        } else if (viewName === 'audio') {
            if (window.DalaAudioUI && window.DalaAudioUI.refresh) window.DalaAudioUI.refresh();
        } else if (viewName === 'stems') {
            if (window.DalaStemsUI && window.DalaStemsUI.refresh) window.DalaStemsUI.refresh();
        } else if (viewName === 'sfx') {
            if (window.DalaSfxUI && window.DalaSfxUI.detect) window.DalaSfxUI.detect();
        }
    }

    function setTwixtorSubTab(subTab) {
        state.activeTwixtorSubTab = subTab;
        if (subTab === 'speed') {
            if (dom.tabTwixtorSpeed) dom.tabTwixtorSpeed.classList.add('active');
            if (dom.tabTwixtorDialog) dom.tabTwixtorDialog.classList.remove('active');
            if (dom.cardTwixtorSpeed) dom.cardTwixtorSpeed.style.display = 'flex';
            if (dom.cardTwixtorDialog) dom.cardTwixtorDialog.style.display = 'none';
        } else {
            if (dom.tabTwixtorDialog) dom.tabTwixtorDialog.classList.add('active');
            if (dom.tabTwixtorSpeed) dom.tabTwixtorSpeed.classList.remove('active');
            if (dom.cardTwixtorDialog) dom.cardTwixtorDialog.style.display = 'flex';
            if (dom.cardTwixtorSpeed) dom.cardTwixtorSpeed.style.display = 'none';
        }
    }

    function updateUI() {
        updateBannerVisibility();
        updateDebugTerminalVisibility();
        updateRootDirDisplay();
    }

    function updateBannerVisibility() {
        if (!dom.bannerContainer) return;
        if (state.settings.showBannerVideo) {
            dom.bannerContainer.classList.remove('hidden');
            startBannerVideo();
        } else {
            dom.bannerContainer.classList.add('hidden');
            releaseBannerResources();
        }
    }

    function updateDebugTerminalVisibility() {
        if (!dom.debugTerminalContainer) return;
        dom.debugTerminalContainer.style.display = state.settings.debugMode ? 'block' : 'none';
    }

    function updateRootDirDisplay() {
        if (!dom.rootDirDisplay) return;
        var rPath = state.settings.presetRootDir;
        var fName = state.settings.presetFolderName || "presets";

        if (dom.presetFolderInput && !dom.presetFolderInput.matches(':focus')) {
            dom.presetFolderInput.value = rPath || (fName !== "presets" ? fName : "");
        }

        if (rPath) {
            dom.rootDirDisplay.textContent = rPath;
            dom.rootDirDisplay.title = rPath;
        } else if (fName && fName !== "presets") {
            dom.rootDirDisplay.textContent = fName + " (<Extension>/" + fName + ")";
            dom.rootDirDisplay.title = "Configured presets folder: " + fName;
        } else {
            dom.rootDirDisplay.textContent = "Default (<Extension>/presets)";
            dom.rootDirDisplay.title = "Default extension presets folder";
        }
    }

    function updateZoomCenterDisplay() {
        if (!dom.zoomCenterDisplay) return;
        var cx = state.compInfo.width / 2;
        var cy = state.compInfo.height / 2;
        dom.zoomCenterDisplay.textContent = cx + ", " + cy + " (" + state.compInfo.width + "x" + state.compInfo.height + ")";
    }

    function renderSimulatorChips() {
        if (!dom.simLayerChips || !window.DalaHostSimulator) return;
        dom.simLayerChips.innerHTML = '';
        var allLayers = window.DalaHostSimulator.activeComp.selectedLayers;
        var selIndices = window.DalaHostSimulator.selectedLayerIndices;

        allLayers.forEach(function (l) {
            var chip = document.createElement('div');
            chip.className = 'sim-chip' + (selIndices.indexOf(l.index) !== -1 ? ' active' : '');
            chip.textContent = "[" + l.index + "] " + l.name + (l.isText ? " (Text)" : "");
            chip.addEventListener('click', function () {
                window.DalaHostSimulator.toggleLayerSelection(l.index);
                renderSimulatorChips();
                refreshCompInfo();
            });
            dom.simLayerChips.appendChild(chip);
        });
    }

    // Refresh Active Comp and Layer Info from ExtendScript
    function refreshCompInfo() {
        evalHostScript("$._dalaSuite.getCompInfo()", function (res) {
            if (res && res.success && res.data) {
                state.compInfo = res.data;
                if (dom.compName) dom.compName.textContent = res.data.hasComp ? res.data.compName : "No Active Comp";
                if (dom.compDetails) {
                    dom.compDetails.textContent = res.data.hasComp
                        ? res.data.width + "x" + res.data.height + " @ " + res.data.fps + "fps"
                        : "Open a composition in After Effects";
                }
                if (dom.compDot) {
                    if (res.data.hasComp) {
                        dom.compDot.classList.remove('inactive');
                    } else {
                        dom.compDot.classList.add('inactive');
                    }
                }
                if (dom.layerBadge) {
                    dom.layerBadge.textContent = (res.data.selectedLayerCount || 0) + " selected";
                }
                updateZoomCenterDisplay();
            }
            if (!state.isCep) {
                renderSimulatorChips();
            }
        });
    }

    // Refresh Presets List & Categories from ExtendScript
    function refreshPresets(showToastOnComplete) {
        var rootArg = state.settings.presetRootDir || "";
        var folderArg = state.settings.presetFolderName || "";
        var cmd = "$._dalaSuite.presetEngine.scanPresets(" + JSON.stringify(rootArg) + ", " + JSON.stringify(folderArg) + ")";

        evalHostScript(cmd, function (res) {
            if (res && res.success && res.data && res.data.presets) {
                // Text Presets were removed in 2.0.3: a "text" folder in any preset root (the bundled one or the
                // user's own) no longer becomes a section, navigation entry or Home card
                var isText = function (c) { return String(c || "").toLowerCase() === "text"; };
                state.presets = res.data.presets.filter(function (p) { return !isText(p.category); });
                state.presetCategories = (res.data.categories || []).filter(function (c) { return !isText(c); });
                renderCategoryTabs(state.presetCategories);
                renderPresetsList();
                renderDynamicNavigation(state.presetCategories);
                renderDynamicHomeCards(state.presetCategories);
                renderShakeView();
                populateDropdowns();
                updateRootDirDisplay();
                if (showToastOnComplete) {
                    showToast("Discovered " + state.presets.length + " presets across " + state.presetCategories.length + " categories.", "success");
                }
            } else {
                if (showToastOnComplete) {
                    showToast(res && res.message ? res.message : "Failed to scan presets.", "error");
                }
            }
        });
    }

    function formatCategoryLabel(cat) {
        if (!cat) return "";
        if (cat.toLowerCase() === "all") return "All";
        if (/[A-Z]/.test(cat)) return cat;
        return cat.replace(/(^|\s|-|_)([a-z])/g, function (m, p1, p2) {
            return (p1 === '-' || p1 === '_' ? ' ' : p1) + p2.toUpperCase();
        });
    }

    function formatCategoryName(cat) {
        return formatCategoryLabel(cat);
    }

    function getShakeCategoryName() {
        if (!state.presetCategories || state.presetCategories.length === 0) return "shake";
        for (var i = 0; i < state.presetCategories.length; i++) {
            var c = state.presetCategories[i];
            if (c.toLowerCase().indexOf("shake") !== -1) {
                return c;
            }
        }
        return state.presetCategories[0] || "shake";
    }

    function renderDynamicNavigation(categories) {
        if (!dom.dynamicNavCategories) return;
        dom.dynamicNavCategories.innerHTML = '';

        var shakeCat = getShakeCategoryName().toLowerCase();

        categories.forEach(function (cat) {
            var cLower = cat.toLowerCase();
            if (cLower === 'twixtor' || cLower === 'zoom' || cLower === shakeCat) {
                return;
            }

            var btn = document.createElement('button');
            var isActive = (state.activeView === 'category' && state.selectedCategoryForView && state.selectedCategoryForView.toLowerCase() === cLower);
            btn.className = 'nav-item' + (isActive ? ' active' : '');
            btn.setAttribute('data-view', 'category');
            btn.setAttribute('data-category', cat);
            btn.title = formatCategoryName(cat) + " Presets";

            var iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
            btn.innerHTML = iconSvg + '<span>' + formatCategoryName(cat) + '</span>';

            btn.addEventListener('click', function () {
                switchView('category', cat);
            });

            dom.dynamicNavCategories.appendChild(btn);
        });
    }

    function renderDynamicHomeCards(categories) {
        if (!dom.dynamicHomeCards) return;
        dom.dynamicHomeCards.innerHTML = '';

        var shakeCat = getShakeCategoryName().toLowerCase();

        categories.forEach(function (cat) {
            var cLower = cat.toLowerCase();
            if (cLower === 'twixtor' || cLower === 'zoom' || cLower === shakeCat) {
                return;
            }

            var catPresets = state.presets.filter(function (p) {
                return p.category.toLowerCase() === cLower;
            });

            var card = document.createElement('div');
            card.className = 'quick-card-btn';
            card.setAttribute('data-view', 'category');
            card.setAttribute('data-category', cat);

            var iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
            card.innerHTML = iconSvg +
                '<div class="quick-name">' + formatCategoryName(cat).toUpperCase() + '</div>' +
                '<div class="quick-sub">' + catPresets.length + ' presets</div>';

            card.addEventListener('click', function () {
                switchView('category', cat);
            });

            dom.dynamicHomeCards.appendChild(card);
        });
    }

    function renderShakeView() {
        var catName = getShakeCategoryName();
        var displayName = formatCategoryName(catName);

        if (dom.navTextShake) dom.navTextShake.textContent = displayName;
        if (dom.quickShakeTitle) dom.quickShakeTitle.textContent = displayName.toUpperCase();
        if (dom.shakeSectionTitle) dom.shakeSectionTitle.textContent = displayName + " Presets";
        if (dom.btnApplyShakeLabel) dom.btnApplyShakeLabel.textContent = "APPLY " + displayName.toUpperCase();

        var shakePresets = state.presets.filter(function (p) {
            return p.category.toLowerCase() === catName.toLowerCase();
        });

        if (dom.shakeSectionTag) {
            dom.shakeSectionTag.textContent = shakePresets.length + (shakePresets.length === 1 ? " PRESET" : " PRESETS");
        }
        if (dom.quickShakeSub) {
            dom.quickShakeSub.textContent = shakePresets.length + " presets";
        }

        if (!dom.shakePresetsList) return;
        dom.shakePresetsList.innerHTML = '';

        if (shakePresets.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = "No presets found in " + displayName + " folder.";
            dom.shakePresetsList.appendChild(empty);
            return;
        }

        var hasSelected = false;
        shakePresets.forEach(function (p) {
            if (p.filename === state.selectedShakePreset || p.name === state.selectedShakePreset) {
                hasSelected = true;
            }
        });
        if (!hasSelected && shakePresets.length > 0) {
            state.selectedShakePreset = shakePresets[0].filename;
        }

        shakePresets.forEach(function (p) {
            var card = document.createElement('div');
            var isSel = (p.filename === state.selectedShakePreset || p.name === state.selectedShakePreset);
            card.className = 'selectable-card shake-card' + (isSel ? ' selected' : '');
            card.setAttribute('data-preset', p.filename);

            var nameEl = document.createElement('div');
            nameEl.className = 'card-main-name';
            nameEl.textContent = cleanPresetName(p.name);

            var badgeEl = document.createElement('div');
            badgeEl.className = 'card-badge';
            badgeEl.textContent = displayName.toUpperCase();

            card.appendChild(nameEl);
            card.appendChild(badgeEl);

            card.addEventListener('click', function () {
                var allCards = dom.shakePresetsList.querySelectorAll('.shake-card');
                allCards.forEach(function (c) { c.classList.remove('selected'); });
                card.classList.add('selected');
                state.selectedShakePreset = p.filename;
            });

            dom.shakePresetsList.appendChild(card);
        });
    }

    function renderCategoryView(catName) {
        if (!catName) {
            catName = state.selectedCategoryForView || (state.presetCategories && state.presetCategories[0]) || "";
        }
        state.selectedCategoryForView = catName;
        var displayName = formatCategoryName(catName);

        if (dom.categorySectionTitle) dom.categorySectionTitle.textContent = displayName + " Presets";
        if (dom.categorySectionDesc) dom.categorySectionDesc.textContent = "Select a preset from " + displayName + " to apply to selected layers independently.";
        if (dom.btnApplyCategoryLabel) dom.btnApplyCategoryLabel.textContent = "APPLY " + displayName.toUpperCase() + " PRESET";

        var catPresets = state.presets.filter(function (p) {
            return p.category.toLowerCase() === catName.toLowerCase();
        });

        if (dom.categorySectionTag) {
            dom.categorySectionTag.textContent = catPresets.length + (catPresets.length === 1 ? " PRESET" : " PRESETS");
        }

        if (!dom.categoryPresetsList) return;
        dom.categoryPresetsList.innerHTML = '';

        if (catPresets.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = "No presets found in " + displayName + " folder.";
            dom.categoryPresetsList.appendChild(empty);
            return;
        }

        var hasSelected = false;
        catPresets.forEach(function (p) {
            if (state.selectedCategoryPreset && state.selectedCategoryPreset.path === p.path) {
                hasSelected = true;
            }
        });
        if (!hasSelected && catPresets.length > 0) {
            state.selectedCategoryPreset = catPresets[0];
        }

        catPresets.forEach(function (p) {
            var card = document.createElement('div');
            var isSel = (state.selectedCategoryPreset && state.selectedCategoryPreset.path === p.path);
            card.className = 'selectable-card' + (isSel ? ' selected' : '');

            var nameEl = document.createElement('div');
            nameEl.className = 'card-main-name';
            nameEl.textContent = cleanPresetName(p.name);

            var badgeEl = document.createElement('div');
            badgeEl.className = 'card-badge';
            badgeEl.textContent = displayName.toUpperCase();

            card.appendChild(nameEl);
            card.appendChild(badgeEl);

            card.addEventListener('click', function () {
                state.selectedCategoryPreset = p;
                var allCards = dom.categoryPresetsList.querySelectorAll('.selectable-card');
                allCards.forEach(function (c) { c.classList.remove('selected'); });
                card.classList.add('selected');
            });

            dom.categoryPresetsList.appendChild(card);
        });
    }

    function renderCategoryTabs(categories) {
        if (!dom.presetFilterTabs) return;

        var catList = ["all"];
        if (categories && categories.length > 0) {
            for (var i = 0; i < categories.length; i++) {
                var c = categories[i].toLowerCase();
                if (catList.indexOf(c) === -1 && c !== "all") {
                    catList.push(c);
                }
            }
        } else {
            catList = ["all", "twixtor", "zoom", "shake", "other"];
        }

        // If the current filter is no longer in list, reset to 'all'
        if (catList.indexOf(state.activeCategoryFilter) === -1) {
            state.activeCategoryFilter = "all";
        }

        dom.presetFilterTabs.innerHTML = '';
        catList.forEach(function (cat) {
            var btn = document.createElement('button');
            btn.className = 'tab-btn' + (cat === state.activeCategoryFilter ? ' active' : '');
            btn.setAttribute('data-category', cat);
            btn.textContent = formatCategoryLabel(cat);
            btn.addEventListener('click', function () {
                state.activeCategoryFilter = cat;
                var allTabs = dom.presetFilterTabs.querySelectorAll('.tab-btn');
                allTabs.forEach(function (t) { t.classList.remove('active'); });
                btn.classList.add('active');
                renderPresetsList();
            });
            dom.presetFilterTabs.appendChild(btn);
        });

        dom.presetCategoryTabs = dom.presetFilterTabs.querySelectorAll('.tab-btn');
    }

    function cleanPresetName(str) {
        if (!str) return '';
        try {
            return decodeURIComponent(str).replace(/\.ffx$/i, '');
        } catch (e) {
            return String(str).replace(/\.ffx$/i, '');
        }
    }

    function populateDropdowns() {
        if (dom.twixtorSpeedPresetSelect) {
            dom.twixtorSpeedPresetSelect.innerHTML = '';
            var twixtorPresets = state.presets.filter(function (p) {
                return p.category.toLowerCase().indexOf('twixtor') !== -1;
            });
            if (twixtorPresets.length === 0) {
                twixtorPresets = state.presets;
            }
            twixtorPresets.forEach(function (p) {
                var opt = document.createElement('option');
                opt.value = p.filename;
                opt.textContent = cleanPresetName(p.name);
                dom.twixtorSpeedPresetSelect.appendChild(opt);
            });
        }

        if (dom.zoomPresetSelect) {
            dom.zoomPresetSelect.innerHTML = '';
            var zoomPresets = state.presets.filter(function (p) {
                return p.category.toLowerCase().indexOf('zoom') !== -1;
            });
            if (zoomPresets.length === 0) {
                zoomPresets = state.presets;
            }
            zoomPresets.forEach(function (p) {
                var optZ = document.createElement('option');
                optZ.value = p.filename;
                optZ.textContent = cleanPresetName(p.name);
                dom.zoomPresetSelect.appendChild(optZ);
            });
        }
    }

    function renderPresetsList() {
        if (!dom.presetListContainer) return;
        dom.presetListContainer.innerHTML = '';

        var query = (dom.presetSearchInput ? dom.presetSearchInput.value : '').toLowerCase().trim();
        var activeFilter = (state.activeCategoryFilter || 'all').toLowerCase();

        var catsToDisplay = [];
        if (activeFilter === 'all') {
            catsToDisplay = state.presetCategories.slice();
        } else {
            state.presetCategories.forEach(function (c) {
                if (c.toLowerCase() === activeFilter) {
                    catsToDisplay.push(c);
                }
            });
            if (catsToDisplay.length === 0) {
                catsToDisplay = [activeFilter];
            }
        }

        var totalRendered = 0;

        catsToDisplay.forEach(function (cat) {
            var catPresets = state.presets.filter(function (p) {
                if (p.category.toLowerCase() !== cat.toLowerCase()) return false;
                if (!query) return true;
                var cleanName = cleanPresetName(p.name).toLowerCase();
                return cleanName.indexOf(query) !== -1 || p.category.toLowerCase().indexOf(query) !== -1;
            });

            if (query && catPresets.length === 0) {
                return;
            }

            var sectionEl = document.createElement('div');
            sectionEl.className = 'preset-category-section';
            sectionEl.setAttribute('data-category', cat);

            var headerEl = document.createElement('div');
            headerEl.className = 'preset-section-header';

            var titleEl = document.createElement('div');
            titleEl.className = 'preset-section-title';
            titleEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.75;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg> ' + formatCategoryName(cat);

            var tagEl = document.createElement('span');
            tagEl.className = 'card-tag';
            tagEl.textContent = catPresets.length + (catPresets.length === 1 ? ' PRESET' : ' PRESETS');

            headerEl.appendChild(titleEl);
            headerEl.appendChild(tagEl);
            sectionEl.appendChild(headerEl);

            var gridEl = document.createElement('div');
            gridEl.className = 'preset-cards-grid';

            if (catPresets.length === 0) {
                var emptyNotice = document.createElement('div');
                emptyNotice.className = 'empty-state';
                emptyNotice.style.padding = '12px';
                emptyNotice.textContent = "No presets in this folder.";
                gridEl.appendChild(emptyNotice);
            } else {
                catPresets.forEach(function (p) {
                    var isSel = (state.selectedPreset && state.selectedPreset.path === p.path);
                    var card = document.createElement('div');
                    card.className = 'selectable-card' + (isSel ? ' selected' : '');

                    var nameEl = document.createElement('div');
                    nameEl.className = 'card-main-name';
                    nameEl.textContent = cleanPresetName(p.name);

                    var badgeEl = document.createElement('div');
                    badgeEl.className = 'card-badge';
                    badgeEl.textContent = formatCategoryName(p.category).toUpperCase();

                    card.appendChild(nameEl);
                    card.appendChild(badgeEl);

                    card.addEventListener('click', function () {
                        state.selectedPreset = p;
                        var allCards = dom.presetListContainer.querySelectorAll('.selectable-card');
                        allCards.forEach(function (c) { c.classList.remove('selected'); });
                        card.classList.add('selected');
                    });

                    gridEl.appendChild(card);
                    totalRendered++;
                });
            }

            sectionEl.appendChild(gridEl);
            dom.presetListContainer.appendChild(sectionEl);
        });

        if (totalRendered === 0 && query) {
            var empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'No presets found matching "' + query + '".';
            dom.presetListContainer.appendChild(empty);
        } else if (state.presets.length === 0) {
            var emptyAll = document.createElement('div');
            emptyAll.className = 'empty-state';
            emptyAll.textContent = 'No presets discovered. Check your presets root folder.';
            dom.presetListContainer.appendChild(emptyAll);
        }
    }

    // Execute ExtendScript Command & Parse Output
    function evalHostScript(script, callback) {
        if (!state.cs) {
            if (typeof callback === 'function') callback({ success: false, message: "CSInterface unavailable." });
            return;
        }

        state.cs.evalScript(script, function (rawResult) {
            var parsed = null;
            try {
                parsed = JSON.parse(rawResult);
            } catch (err) {
                console.error("Failed to parse ExtendScript response:", rawResult, err);
                parsed = {
                    success: false,
                    message: rawResult || "Invalid response from After Effects.",
                    error: err.toString()
                };
            }

            if (parsed.debugLogs && parsed.debugLogs.length > 0) {
                state.debugLogs = state.debugLogs.concat(parsed.debugLogs);
                renderDebugLogs();
            }

            if (typeof callback === 'function') {
                callback(parsed);
            }
        });
    }

    function renderDebugLogs() {
        if (!dom.debugTerminal) return;
        dom.debugTerminal.innerHTML = '';
        state.debugLogs.forEach(function (line) {
            var el = document.createElement('div');
            el.className = 'log-line';
            if (line.indexOf('ERROR') !== -1 || line.indexOf('failed') !== -1) {
                el.classList.add('log-error');
            } else if (line.indexOf('Found') !== -1 || line.indexOf('Split') !== -1 || line.indexOf('Applied') !== -1) {
                el.classList.add('log-success');
            } else if (line.indexOf('Warning') !== -1 || line.indexOf('skipped') !== -1) {
                el.classList.add('log-warn');
            }
            el.textContent = line;
            dom.debugTerminal.appendChild(el);
        });
        dom.debugTerminal.scrollTop = dom.debugTerminal.scrollHeight;
    }

    // Handlers for Operations
    function handleCutToF() {
        evalHostScript("$._dalaSuite.cutToF()", function (res) {
            if (res.success) {
                showToast(res.message, "success");
                refreshCompInfo();
            } else {
                showToast(res.message || res.error || "Cut To F failed.", "error");
            }
        });
    }

    function handleTwixtorDialog(fps) {
        evalHostScript("$._dalaSuite.twixtor.applyDialog('" + fps + "')", function (res) {
            if (res.success) {
                showToast(res.message, "success");
                refreshCompInfo();
            } else {
                showToast(res.message || res.error || "Twixtor Dialog failed.", "error");
            }
        });
    }

    function handleTwixtorSpeed(fps, preset, shouldStretch) {
        var stretchArg = shouldStretch ? "true" : "false";
        evalHostScript("$._dalaSuite.twixtor.applySpeed('" + fps + "', '" + preset + "', " + stretchArg + ")", function (res) {
            if (res.success) {
                showToast(res.message, "success");
                refreshCompInfo();
            } else {
                showToast(res.message || res.error || "Twixtor Speed failed.", "error");
            }
        });
    }

    function handleZoom(preset, shouldStretch) {
        var stretchArg = shouldStretch ? "true" : "false";
        evalHostScript("$._dalaSuite.zoom.applyZoom('" + preset + "', " + stretchArg + ")", function (res) {
            if (res.success) {
                showToast(res.message, "success");
                refreshCompInfo();
            } else {
                showToast(res.message || res.error || "Zoom failed.", "error");
            }
        });
    }

    function handleShake(preset, stretch) {
        evalHostScript("$._dalaSuite.shake.applyShake('" + preset + "', " + (stretch ? "true" : "false") + ")", function (res) {
            if (res.success) {
                showToast(res.message, "success");
                refreshCompInfo();
            } else {
                showToast(res.message || res.error || "Shake failed.", "error");
            }
        });
    }

    function handleApplyGenericPreset(path, shouldStretch) {
        var stretchArg = shouldStretch ? "true" : "false";
        evalHostScript("$._dalaSuite.presetEngine.applyGenericPreset(" + JSON.stringify(path) + ", " + stretchArg + ")", function (res) {
            if (res.success) {
                showToast(res.message, "success");
                refreshCompInfo();
            } else {
                showToast(res.message || res.error || "Preset apply failed.", "error");
            }
        });
    }

    function handleSetPresetFolder() {
        if (!dom.presetFolderInput) return;
        var val = dom.presetFolderInput.value.trim();
        if (!val) {
            handleResetRootDir();
            return;
        }

        if (val.indexOf('/') !== -1 || val.indexOf('\\') !== -1 || val.indexOf(':') !== -1) {
            state.settings.presetRootDir = val;
        } else {
            state.settings.presetRootDir = "";
            state.settings.presetFolderName = val;
        }

        saveSettings();
        updateRootDirDisplay();

        var cmd = "$._dalaSuite.presetEngine.setCustomRootDir(" + JSON.stringify(state.settings.presetRootDir) + ", " + JSON.stringify(state.settings.presetFolderName) + ")";
        evalHostScript(cmd, function () {
            refreshPresets(true);
            showToast("Preset directory set to: " + (state.settings.presetRootDir || state.settings.presetFolderName), "success");
        });
    }

    function handleChangeRootDir() {
        evalHostScript("$._dalaSuite.selectFolderDialog('Select Preset Root Directory')", function (res) {
            if (res.success && res.data && res.data.path) {
                state.settings.presetRootDir = res.data.path;
                saveSettings();
                updateRootDirDisplay();
                refreshPresets(true);
            }
        });
    }

    function handleResetRootDir() {
        state.settings.presetRootDir = "";
        state.settings.presetFolderName = "presets";
        if (dom.presetFolderInput) dom.presetFolderInput.value = "";
        saveSettings();
        updateRootDirDisplay();
        evalHostScript("$._dalaSuite.presetEngine.setCustomRootDir('', 'presets')", function () {
            refreshPresets(true);
            showToast("Preset root reset to default (presets).", "info");
        });
    }
    // the panel's one status message (js/toast.js)
    function showToast(message, type) { if (window.CFXToast) window.CFXToast(message, type); else if (window.DalaToast) window.DalaToast(message, type); }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    document.addEventListener('DOMContentLoaded', init);
})();
