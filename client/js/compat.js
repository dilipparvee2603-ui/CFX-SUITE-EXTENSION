/**
 * Dala Suite - panel compatibility with older After Effects (ES5). After Effects 2020 / 2021 run their panels on
 * Chromium 61 / 74, which ignore "gap" on flex containers (Chromium 84+): there the <html> element gets
 * .no-flexgap and style.css adds the same spacing as margins.
 */
(function () {
    'use strict';
    try {
        var d = document.createElement('div');
        d.style.display = 'flex';
        d.style.flexDirection = 'column';
        d.style.rowGap = '1px';
        d.appendChild(document.createElement('div'));
        d.appendChild(document.createElement('div'));
        d.style.position = 'absolute';
        d.style.visibility = 'hidden';
        (document.body || document.documentElement).appendChild(d);
        var supported = d.scrollHeight === 1;
        d.parentNode.removeChild(d);
        if (!supported) document.documentElement.className += ' no-flexgap';
    } catch (e) {}
})();
