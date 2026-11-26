/**
 * Dala Suite - the one status message of the panel (ES5). Every tab calls DalaToast(message, type):
 * a single small message at the bottom, replaced by the next one (never a stack that covers the panel).
 * Long text is cut to two lines (the whole text shows on hover); a click dismisses it.
 *   type: 'success' | 'info' | 'error' (errors stay a little longer)
 */
(function (root) {
    'use strict';
    var el = null, msg = null, timer = 0, fade = 0;

    function hide() {
        clearTimeout(timer);
        if (!el) return;
        el.classList.add('out');
        clearTimeout(fade);
        fade = setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 200);
    }

    function show(message, type) {
        var box = document.getElementById('toast-container');
        if (!box || !message) return;
        type = type === 'success' || type === 'error' ? type : 'info';
        clearTimeout(timer); clearTimeout(fade);
        if (!el) {
            el = document.createElement('div');
            msg = document.createElement('span');
            msg.className = 'toast-msg';
            el.appendChild(msg);
            el.addEventListener('click', hide);
        }
        if (el.parentNode !== box) { while (box.firstChild) box.removeChild(box.firstChild); box.appendChild(el); }
        el.className = 'toast ' + type;
        msg.textContent = String(message);
        el.title = String(message);
        // restart the entry animation for a new message
        void el.offsetWidth;
        el.classList.add('in');
        timer = setTimeout(hide, type === 'error' ? 5000 : 2600);
    }

    root.DalaToast = show;
    root.DalaToast.hide = hide;
    root.CFXToast = show;
    root.CFXToast.hide = hide;
})(window);
