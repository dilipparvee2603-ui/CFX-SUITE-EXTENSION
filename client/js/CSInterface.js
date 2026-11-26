/**
 * CSInterface - v11.0.0 (Adobe CEP Bridge)
 * Enhanced with graceful browser test fallback for Dala Suite
 */

(function () {
    'use strict';

    function CSInterface() {}

    /**
     * User's operating system
     */
    CSInterface.prototype.OSVersion = {
        Windows: "Windows",
        Mac: "Mac"
    };

    /**
     * Check if running inside Adobe CEP environment
     */
    CSInterface.prototype.isCep = function () {
        return typeof window.__adobe_cep__ !== 'undefined';
    };

    /**
     * Evaluates ExtendScript code in the host application.
     * @param script ExtendScript code to evaluate
     * @param callback Callback receiving the evaluated string result
     */
    CSInterface.prototype.evalScript = function (script, callback) {
        if (this.isCep()) {
            window.__adobe_cep__.evalScript(script, callback);
        } else {
            // Graceful Mock Host Simulator for browser preview/testing
            if (window.DalaHostSimulator && typeof window.DalaHostSimulator.evalScript === 'function') {
                window.DalaHostSimulator.evalScript(script, callback);
            } else {
                console.warn('[CSInterface Mock] Executing script outside CEP:', script);
                setTimeout(function () {
                    if (typeof callback === 'function') {
                        callback(JSON.stringify({
                            success: true,
                            message: "Executed in Mock Environment",
                            data: { mock: true },
                            debugLogs: ["[Simulator] Script simulated: " + script.substring(0, 80) + "..."]
                        }));
                    }
                }, 100);
            }
        }
    };

    /**
     * Reloads the extension panel
     */
    CSInterface.prototype.reload = function () {
        window.location.reload();
    };

    /**
     * Closes the extension
     */
    CSInterface.prototype.closeExtension = function () {
        if (this.isCep()) {
            window.__adobe_cep__.closeExtension();
        } else {
            console.log('[CSInterface] closeExtension requested');
        }
    };

    /**
     * Opens another extension of the bundle (the GENERAL tools' floating windows)
     */
    CSInterface.prototype.requestOpenExtension = function (extensionId, params) {
        if (this.isCep()) {
            window.__adobe_cep__.requestOpenExtension(extensionId, params || "");
        } else {
            console.log('[CSInterface] requestOpenExtension ' + extensionId);
        }
    };

    /**
     * Get system path (e.g. extension path, user data)
     */
    CSInterface.prototype.getSystemPath = function (pathType) {
        if (this.isCep()) {
            var path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
            return path;
        }
        return "/DalaSuite";
    };

    /**
     * Register an event listener
     */
    CSInterface.prototype.addEventListener = function (type, listener, obj) {
        if (this.isCep()) {
            window.__adobe_cep__.addEventListener(type, listener, obj);
        } else {
            window.addEventListener(type, listener);
        }
    };

    /**
     * Remove an event listener
     */
    CSInterface.prototype.removeEventListener = function (type, listener, obj) {
        if (this.isCep()) {
            window.__adobe_cep__.removeEventListener(type, listener, obj);
        } else {
            window.removeEventListener(type, listener);
        }
    };

    /**
     * Dispatch an event
     */
    CSInterface.prototype.dispatchEvent = function (event) {
        if (this.isCep()) {
            window.__adobe_cep__.dispatchEvent(event);
        } else {
            var customEvt = new CustomEvent(event.type, { detail: event.data });
            window.dispatchEvent(customEvt);
        }
    };

    /**
     * Open URL in default OS browser
     */
    CSInterface.prototype.openURLInDefaultBrowser = function (url) {
        if (this.isCep()) {
            if (typeof window.cep !== 'undefined' && window.cep.util) {
                window.cep.util.openURLInDefaultBrowser(url);
            } else {
                window.open(url, '_blank');
            }
        } else {
            window.open(url, '_blank');
        }
    };

    window.CSInterface = CSInterface;
})();
