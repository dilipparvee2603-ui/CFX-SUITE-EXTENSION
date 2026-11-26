/**
 * CFX Suite Pro - General Tools Controller (Client-side JS)
 * Handles Un-precompose, Interactive Easing Curves, and 9-Point Anchor Alignments.
 */

(function (root) {
    'use strict';

    var cs = null;
    var state = {
        inEase: 50,
        outEase: 50,
        boundsType: 'sourceRect', // 'sourceRect' | 'layer'
        parentToController: true,
        deleteOriginal: false
    };

    var dom = {};

    function getCS() {
        if (!cs && typeof CSInterface !== 'undefined') {
            cs = new CSInterface();
        }
        return cs;
    }

    function toast(msg, type) {
        if (root.CFXToast) root.CFXToast(msg, type);
        else if (root.DalaToast) root.DalaToast(msg, type);
        else console.log('[CFX Tools Toast]', type, msg);
    }

    function hostCall(funcName, arg, cb) {
        var interfaceObj = getCS();
        if (!interfaceObj) {
            toast('After Effects is not connected.', 'error');
            if (cb) cb({ success: false, message: 'No CSInterface' });
            return;
        }

        var paramStr = (arg === undefined) ? '' : JSON.stringify(JSON.stringify(arg));
        var script = '$._cfxSuite.generalTools.' + funcName + '(' + paramStr + ')';

        interfaceObj.evalScript(script, function (resRaw) {
            var res = null;
            try {
                res = (typeof resRaw === 'string') ? JSON.parse(resRaw) : resRaw;
            } catch (e) {
                res = { success: false, message: 'Invalid response from After Effects: ' + resRaw };
            }

            if (res && res.message) {
                toast(res.message, res.success ? 'success' : 'error');
            }
            if (cb) cb(res);
        });
    }

    // =========================================================================
    // SVG BEZIER CURVE RENDERER
    // =========================================================================

    function updateCurvePreview() {
        if (!dom.curvePath) return;

        var inInf = Math.max(0.1, Math.min(100, state.inEase));
        var outInf = Math.max(0.1, Math.min(100, state.outEase));

        // SVG ViewBox: 0 0 100 100
        // Start: (10, 90) -> Bottom-Left
        // End:   (90, 10) -> Top-Right
        var startX = 10, startY = 90;
        var endX = 90, endY = 10;

        // Control point 1 (Out ease of first keyframe)
        var cp1X = startX + (outInf / 100) * (endX - startX);
        var cp1Y = startY;

        // Control point 2 (In ease of second keyframe)
        var cp2X = endX - (inInf / 100) * (endX - startX);
        var cp2Y = endY;

        var d = 'M ' + startX + ' ' + startY + ' C ' + cp1X + ' ' + cp1Y + ', ' + cp2X + ' ' + cp2Y + ', ' + endX + ' ' + endY;
        dom.curvePath.setAttribute('d', d);

        // Control handles lines & dots
        if (dom.handleLine1) {
            dom.handleLine1.setAttribute('x1', startX);
            dom.handleLine1.setAttribute('y1', startY);
            dom.handleLine1.setAttribute('x2', cp1X);
            dom.handleLine1.setAttribute('y2', cp1Y);
        }
        if (dom.handleLine2) {
            dom.handleLine2.setAttribute('x1', endX);
            dom.handleLine2.setAttribute('y1', endY);
            dom.handleLine2.setAttribute('x2', cp2X);
            dom.handleLine2.setAttribute('y2', cp2Y);
        }
        if (dom.handleDot1) {
            dom.handleDot1.setAttribute('cx', cp1X);
            dom.handleDot1.setAttribute('cy', cp1Y);
        }
        if (dom.handleDot2) {
            dom.handleDot2.setAttribute('cx', cp2X);
            dom.handleDot2.setAttribute('cy', cp2Y);
        }

        // Labels
        if (dom.labelIn) dom.labelIn.textContent = Math.round(inInf) + '%';
        if (dom.labelOut) dom.labelOut.textContent = Math.round(outInf) + '%';
    }

    // =========================================================================
    // INITIALIZATION & EVENT BINDING
    // =========================================================================

    function cacheDom() {
        // Un-precompose DOM
        dom.btnUnprecompose = document.getElementById('btn-unprecompose');
        dom.chkParentController = document.getElementById('chk-parent-controller');
        dom.chkDeleteOriginal = document.getElementById('chk-delete-original');

        // Easing DOM
        dom.curvePath = document.getElementById('ease-curve-path');
        dom.handleLine1 = document.getElementById('ease-handle-line1');
        dom.handleLine2 = document.getElementById('ease-handle-line2');
        dom.handleDot1 = document.getElementById('ease-handle-dot1');
        dom.handleDot2 = document.getElementById('ease-handle-dot2');

        dom.sliderIn = document.getElementById('slider-ease-in');
        dom.sliderOut = document.getElementById('slider-ease-out');
        dom.labelIn = document.getElementById('label-ease-in');
        dom.labelOut = document.getElementById('label-ease-out');

        dom.btnApplyEase = document.getElementById('btn-apply-ease');
        dom.btnCopyEase = document.getElementById('btn-copy-ease');
        dom.btnPasteEase = document.getElementById('btn-paste-ease');
        dom.easePresetBtns = document.querySelectorAll('.ease-preset-btn');

        // Anchor DOM
        dom.anchorBtns = document.querySelectorAll('.anchor-grid-btn');
        dom.btnCenterAnchorComp = document.getElementById('btn-center-anchor-comp');
        dom.boundsRadios = document.querySelectorAll('input[name="anchor-bounds-mode"]');
    }

    function setEasingValues(inVal, outVal) {
        state.inEase = Math.round(inVal);
        state.outEase = Math.round(outVal);

        if (dom.sliderIn) dom.sliderIn.value = state.inEase;
        if (dom.sliderOut) dom.sliderOut.value = state.outEase;

        updateCurvePreview();
    }

    function bindEvents() {
        // --- 1. Un-precompose ---
        if (dom.btnUnprecompose) {
            dom.btnUnprecompose.addEventListener('click', function () {
                var opts = {
                    parentToController: dom.chkParentController ? dom.chkParentController.checked : true,
                    deleteOriginal: dom.chkDeleteOriginal ? dom.chkDeleteOriginal.checked : false,
                    muteOriginal: true
                };
                hostCall('unprecompose', opts);
            });
        }

        // --- 2. Easing Sliders & Presets ---
        if (dom.sliderIn) {
            dom.sliderIn.addEventListener('input', function () {
                state.inEase = parseFloat(dom.sliderIn.value) || 0;
                updateCurvePreview();
            });
        }
        if (dom.sliderOut) {
            dom.sliderOut.addEventListener('input', function () {
                state.outEase = parseFloat(dom.sliderOut.value) || 0;
                updateCurvePreview();
            });
        }

        if (dom.easePresetBtns) {
            dom.easePresetBtns.forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var preset = btn.getAttribute('data-ease');
                    if (!preset) return;

                    dom.easePresetBtns.forEach(function (b) { b.classList.remove('active'); });
                    btn.classList.add('active');

                    if (preset === 'linear') {
                        setEasingValues(0.1, 0.1);
                        hostCall('applyEasing', { type: 'linear' });
                    } else if (preset === 'easyEase') {
                        setEasingValues(33.33, 33.33);
                        hostCall('applyEasing', { type: 'easyEase' });
                    } else if (preset === 'soft') {
                        setEasingValues(50, 50);
                        hostCall('applyEasing', { type: 'soft' });
                    } else if (preset === 'strong') {
                        setEasingValues(75, 75);
                        hostCall('applyEasing', { type: 'strong' });
                    } else if (preset === 'extreme') {
                        setEasingValues(88, 88);
                        hostCall('applyEasing', { type: 'extreme' });
                    } else if (preset === 'snapIn') {
                        setEasingValues(15, 85);
                        hostCall('applyEasing', { type: 'snapIn' });
                    } else if (preset === 'snapOut') {
                        setEasingValues(85, 15);
                        hostCall('applyEasing', { type: 'snapOut' });
                    }
                });
            });
        }

        if (dom.btnApplyEase) {
            dom.btnApplyEase.addEventListener('click', function () {
                hostCall('applyEasing', {
                    type: 'custom',
                    inEase: state.inEase,
                    outEase: state.outEase
                });
            });
        }

        if (dom.btnCopyEase) {
            dom.btnCopyEase.addEventListener('click', function () {
                hostCall('copyEase', undefined, function (res) {
                    if (res && res.success && res.data) {
                        setEasingValues(res.data.inEase, res.data.outEase);
                    }
                });
            });
        }

        if (dom.btnPasteEase) {
            dom.btnPasteEase.addEventListener('click', function () {
                hostCall('pasteEase');
            });
        }

        // --- 3. Anchor Grid & Alignments ---
        if (dom.anchorBtns) {
            dom.anchorBtns.forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var align = btn.getAttribute('data-anchor');
                    if (!align) return;

                    dom.anchorBtns.forEach(function (b) { b.classList.remove('active'); });
                    btn.classList.add('active');

                    hostCall('alignAnchor', {
                        alignment: align,
                        boundsType: state.boundsType
                    });
                });
            });
        }

        if (dom.btnCenterAnchorComp) {
            dom.btnCenterAnchorComp.addEventListener('click', function () {
                hostCall('centerAnchorAndComp');
            });
        }

        if (dom.boundsRadios) {
            dom.boundsRadios.forEach(function (r) {
                r.addEventListener('change', function () {
                    if (r.checked) state.boundsType = r.value;
                });
            });
        }
    }

    function init() {
        cacheDom();
        bindEvents();
        updateCurvePreview();
    }

    root.CFXGeneralTools = {
        init: init,
        unprecompose: function (opts) { hostCall('unprecompose', opts); },
        applyEasing: function (opts) { hostCall('applyEasing', opts); },
        copyEase: function () { hostCall('copyEase'); },
        pasteEase: function () { hostCall('pasteEase'); },
        alignAnchor: function (align) { hostCall('alignAnchor', { alignment: align, boundsType: state.boundsType }); },
        centerAnchorAndComp: function () { hostCall('centerAnchorAndComp'); },
        setEasing: setEasingValues
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);
