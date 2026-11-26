/**
 * Dala Suite - Layer Setups view (ES5). (Unprecompose lives in the GENERAL tab: general/generalUI.js.)
 *   Save selected layers  -> $._dalaSuite.setups.save({name})
 *   list / apply / rename / delete -> $._dalaSuite.setups.*  (JSON files in %APPDATA%\DalaSuite\LayerSetups)
 */
(function (root) {
    'use strict';
    var cs = null, busy = false, at = 'cti';
    function $(id) { return document.getElementById(id); }

    function toast(message, type) { if (window.DalaToast) window.DalaToast(message, type); }

    function host(call, cb) {
        if (!cs) { cb({ success: false, message: 'After Effects is not connected.' }); return; }
        cs.evalScript(call, function (raw) {
            var res;
            try { res = JSON.parse(raw); } catch (e) { res = { success: false, message: (raw && raw !== 'undefined') ? String(raw) : 'After Effects did not answer.' }; }
            cb(res);
        });
    }
    function q(obj) { return JSON.stringify(JSON.stringify(obj)); }

    function note(text) { var n = $('ls-note'); if (n) n.textContent = text || ''; }

    function setBusy(b) {
        busy = b;
        var btns = document.querySelectorAll('#ls-card button');
        for (var i = 0; i < btns.length; i++) btns[i].disabled = b;
    }

    function fmtDate(s) {
        var d = new Date(s);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function render(list) {
        var box = $('ls-list');
        box.innerHTML = '';
        if (!list.length) {
            var e = document.createElement('div');
            e.className = 'ls-empty';
            e.textContent = 'No saved setups yet. Select layers in a comp, name them above and press Save.';
            box.appendChild(e);
            return;
        }
        list.forEach(function (s) {
            var row = document.createElement('div');
            row.className = 'ls-row';
            var info = document.createElement('div');
            info.className = 'ls-info';
            var name = document.createElement('span');
            name.className = 'ls-name';
            name.textContent = s.name;
            var meta = document.createElement('span');
            meta.className = 'ls-meta';
            meta.textContent = s.count + ' layer' + (s.count === 1 ? '' : 's') + ' · ' + (s.kinds || '') + (s.size ? ' · ' + s.size[0] + 'x' + s.size[1] : '') + ' · ' + fmtDate(s.created);
            meta.title = 'Saved from "' + s.comp + '" in ' + s.project + ' (After Effects ' + String(s.ae || '').split('x')[0] + ')';
            info.appendChild(name);
            info.appendChild(meta);
            var acts = document.createElement('div');
            acts.className = 'ls-acts';
            function mk(label, cls, title, fn) {
                var b = document.createElement('button');
                b.className = 'btn btn-sm ' + cls;
                b.textContent = label;
                b.title = title;
                b.addEventListener('click', fn);
                acts.appendChild(b);
                return b;
            }
            mk('APPLY', 'btn-primary', 'Build this setup in the active comp (or a new comp when none is open)', function () { apply(s); });
            mk('RENAME', 'btn-secondary', 'Rename this setup', function () { startRename(row, s); });
            mk('✕', 'btn-secondary', 'Delete this setup', function () { askDelete(row, s); });
            row.appendChild(info);
            row.appendChild(acts);
            box.appendChild(row);
        });
    }

    function refresh() {
        host('$._dalaSuite.setups.list()', function (res) {
            if (!res.success) { note(res.message); render([]); return; }
            render(res.data.setups || []);
            var f = $('ls-list');
            if (f) f.title = 'Stored in ' + res.data.folder;
        });
    }

    function save() {
        if (busy) return;
        var name = $('ls-name').value;
        setBusy(true);
        note('Saving…');
        host('$._dalaSuite.setups.save(' + q({ name: name }) + ')', function (res) {
            setBusy(false);
            note(res.message);
            toast(res.message, res.success ? 'success' : 'error');
            if (res.success) { $('ls-name').value = ''; refresh(); }
        });
    }

    function apply(s) {
        if (busy) return;
        setBusy(true);
        note('Applying "' + s.name + '"…');
        host('$._dalaSuite.setups.apply(' + q({ id: s.id, at: at }) + ')', function (res) {
            setBusy(false);
            note(res.message);
            var warn = res.success && res.data && res.data.warnings && res.data.warnings.length;
            toast(res.message, res.success ? (warn ? 'info' : 'success') : 'error');
        });
    }

    function startRename(row, s) {
        var info = row.querySelector('.ls-info'), acts = row.querySelector('.ls-acts');
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'form-input ls-rename';
        input.value = s.name;
        input.maxLength = 80;
        info.innerHTML = '';
        info.appendChild(input);
        acts.innerHTML = '';
        var ok = document.createElement('button');
        ok.className = 'btn btn-sm btn-primary';
        ok.textContent = 'SAVE';
        var no = document.createElement('button');
        no.className = 'btn btn-sm btn-secondary';
        no.textContent = 'CANCEL';
        acts.appendChild(ok);
        acts.appendChild(no);
        input.focus();
        input.select();
        function done() {
            host('$._dalaSuite.setups.rename(' + q({ id: s.id, name: input.value }) + ')', function (res) {
                if (!res.success) toast(res.message, 'error');
                refresh();
            });
        }
        ok.addEventListener('click', done);
        no.addEventListener('click', refresh);
        input.addEventListener('keydown', function (e) { if (e.keyCode === 13) done(); else if (e.keyCode === 27) refresh(); });
    }

    function askDelete(row, s) {
        var acts = row.querySelector('.ls-acts');
        acts.innerHTML = '';
        var lbl = document.createElement('span');
        lbl.className = 'ls-meta';
        lbl.textContent = 'Delete?';
        var yes = document.createElement('button');
        yes.className = 'btn btn-sm btn-danger';
        yes.textContent = 'DELETE';
        var no = document.createElement('button');
        no.className = 'btn btn-sm btn-secondary';
        no.textContent = 'KEEP';
        acts.appendChild(lbl);
        acts.appendChild(yes);
        acts.appendChild(no);
        yes.addEventListener('click', function () {
            host('$._dalaSuite.setups.remove(' + q({ id: s.id }) + ')', function (res) {
                toast(res.message, res.success ? 'success' : 'error');
                refresh();
            });
        });
        no.addEventListener('click', refresh);
    }

    function nav(view) {
        var b = document.querySelector('.nav-item[data-view="' + view + '"]');
        if (b) b.click();
    }

    function init() {
        try { cs = new root.CSInterface(); } catch (e) { cs = null; }
        var qs = $('quick-setups');
        if (qs) qs.addEventListener('click', function () { nav('setups'); });
        var qa = $('quick-audio');
        if (qa) qa.addEventListener('click', function () { nav('audio'); });
        if (!$('ls-card')) return;
        $('ls-save').addEventListener('click', save);
        $('ls-name').addEventListener('keydown', function (e) { if (e.keyCode === 13) save(); });
        $('ls-refresh').addEventListener('click', refresh);
        var atBtns = $('ls-at').querySelectorAll('[data-at]');
        for (var i = 0; i < atBtns.length; i++) {
            atBtns[i].addEventListener('click', function () {
                at = this.getAttribute('data-at');
                for (var j = 0; j < atBtns.length; j++) atBtns[j].classList.toggle('active', atBtns[j] === this);
            });
        }
        var navBtn = document.querySelector('.nav-item[data-view="setups"]');
        if (navBtn) navBtn.addEventListener('click', refresh);
        if (qs) qs.addEventListener('click', refresh);
    }

    root.DalaSetupsUI = { refresh: refresh, save: save };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
