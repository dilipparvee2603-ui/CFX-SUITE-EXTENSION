/**
 * Dala Suite - GENERAL > Clean Up (ES5, Node in the panel): what older projects left on the PC, keeping everything the
 * open project uses. Scan first, then clean only the ticked groups:
 *   disk     After Effects disk cache (every project's cached frames; AE rebuilds what the open project needs) - the
 *            folder from AE's preferences ("Disk Cache Controls" > Folder 7), purged by AE itself, then emptied
 *   media    media cache (conformed audio, peaks, index files) of footage the open project does not use - every Adobe
 *            version's Media Cache FolderPath (HKCU\Software\Adobe\Common NN.0\Media Cache) + the default Roaming
 *            folder; only "Media Cache Files", "Peak Files", "Analyzer Cache Files" (never the database itself)
 *   autosave auto-saves of other projects (their "Adobe After Effects Auto-Save" folders, from AE's recent projects)
 *   dala     files Dala Suite made for other projects: "Dala SFX" / "Dala Stems" folders (next to the sources, in
 *            Documents\Dala Suite), Downloads\Dala Suite\From links - unless the open project uses them
 *   temp     Dala Suite's temporary folders (DalaAudio, DalaCaptions...), except anything touched in the last 10 min
 * Caches and temporary files are deleted (they are rebuilt when needed); auto-saves and Dala files go to the Recycle
 * Bin, so they can still be restored. Project files (.aep), footage and models are never touched.
 *
 *   DalaCleanup.create(N, env) -> { scan(info, onStatus, cb(err, groups)), clean(groups, keys, info, host, onStatus, cb) }
 *   info (host/generalTools.jsx cleanupInfo): { project, files: [paths used], ae: "25.6x101", userData }
 */
(function (root) {
    'use strict';

    function create(N, env) {
        var fs = N.fs, path = N.path;
        var HOME = N.os.homedir(), TMP = N.os.tmpdir(), APPDATA = env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
        var RECENT = 10 * 60 * 1000;

        function low(p) { return path.resolve(String(p)).toLowerCase(); }
        function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
        function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

        /** async walk: every file under dir -> visit(path, stat); cb() when done (yields to the panel every 200 entries) */
        function walk(dir, visit, cb, opts) {
            var stack = [dir], n = 0, maxDepth = (opts && opts.depth) || 64, depth = {};
            depth[dir] = 0;
            (function step() {
                var t = Date.now();
                while (stack.length) {
                    var d = stack.pop(), names;
                    try { names = fs.readdirSync(d); } catch (e) { continue; }
                    for (var i = 0; i < names.length; i++) {
                        var p = path.join(d, names[i]), st;
                        try { st = fs.lstatSync(p); } catch (e2) { continue; }
                        if (st.isSymbolicLink()) continue;                      // never follow links / junctions
                        if (st.isDirectory()) { if (depth[d] < maxDepth) { depth[p] = depth[d] + 1; stack.push(p); } }
                        else visit(p, st);
                        n++;
                    }
                    if (Date.now() - t > 40) { setTimeout(step, 0); return; }
                }
                cb();
            })();
        }

        /** "Adobe After Effects NN.N Prefs.txt" -> { disk: folder or '', recent: [project paths] } (values can wrap) */
        function readPrefs(userData, ver) {
            var out = { disk: '', recent: [] }, txt = '';
            var f = path.join(userData || APPDATA, 'Adobe', 'After Effects', ver, 'Adobe After Effects ' + ver + ' Prefs.txt');
            try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { return out; }
            txt = txt.replace(/"\\\r?\n\s*"/g, '');                             // join wrapped values
            var sec = '', lines = txt.split(/\r?\n/), m;
            for (var i = 0; i < lines.length; i++) {
                if ((m = /^\["(.*)"\]/.exec(lines[i]))) { sec = m[1]; continue; }
                if (sec === 'Disk Cache Controls' && (m = /^\s*"Folder \d+"\s*=\s*"(.*)"/.exec(lines[i]))) out.disk = m[1];
                if ((m = /^\s*"MRU Project Path ID # \d+, File Path"\s*=\s*"(.*)"/.exec(lines[i]))) out.recent.push(m[1]);
            }
            return out;
        }

        /** every Adobe version's media cache folder (registry), cb(list) */
        function mediaCacheRoots(cb) {
            var roots = [path.join(APPDATA, 'Adobe', 'Common')];
            var child;
            try { child = N.cp.spawn('reg', ['query', 'HKCU\\Software\\Adobe', '/s', '/v', 'FolderPath'], { windowsHide: true }); }
            catch (e) { cb(roots); return; }
            var buf = '';
            child.stdout.on('data', function (d) { buf += String(d); });
            child.on('error', function () { cb(roots); });
            child.on('close', function () {
                var key = '', ls = buf.split(/\r?\n/), m;
                for (var i = 0; i < ls.length; i++) {
                    if (/^HKEY_/.test(ls[i])) { key = ls[i]; continue; }
                    if (/Media Cache$/i.test(key) && (m = /FolderPath\s+REG_\w+\s+(.+)$/.exec(ls[i]))) roots.push(m[1].replace(/\s+$/, ''));
                }
                cb(roots);
            });
        }

        function group(key, label, how, note, on) { return { key: key, label: label, how: how, note: note, on: on, files: [], sizes: {}, bytes: 0, kept: 0, roots: [] }; }
        function add(g, p, st) { g.files.push(p); g.sizes[p] = st.size; g.bytes += st.size; }       // sizes kept: no second pass over 20 000 files

        function scan(info, onStatus, cb) {
            var ver = (/^(\d+\.\d+)/.exec(info.ae || '') || [])[1] || '25.0';
            var used = {}, usedStem = [], i;
            (info.files || []).forEach(function (f) {
                used[low(f)] = true;
                var b = path.basename(f).toLowerCase();
                usedStem.push(b, b.replace(/\.[^.]+$/, ''));
            });
            var project = info.project ? low(info.project) : '';
            var projBase = info.project ? path.basename(info.project).replace(/\.aep$/i, '').toLowerCase() : '';
            var prefs = readPrefs(info.userData, ver);
            var G = {
                disk: group('disk', 'After Effects disk cache', 'purge', 'cached frames of every project - After Effects rebuilds what the open project needs', true),
                media: group('media', 'Media cache of other footage', 'delete', 'conformed audio, peaks and index files of footage the open project does not use', true),
                autosave: group('autosave', 'Auto-saves of other projects', 'recycle', 'to the Recycle Bin', true),
                dala: group('dala', 'Dala Suite files of other projects', 'recycle', 'SFX, stems, link downloads the open project does not use - to the Recycle Bin', true),
                temp: group('temp', 'Dala Suite temporary files', 'delete', 'left over from earlier runs', true)
            };
            var jobs = [];
            // 1. disk cache: the folder AE renders into (its "Adobe\After Effects" part when there is one)
            if (prefs.disk && isDir(prefs.disk)) {
                var dc = path.join(prefs.disk, 'Adobe', 'After Effects');
                G.disk.roots.push(isDir(dc) ? dc : prefs.disk);
                jobs.push(function (next) { onStatus('Measuring the disk cache…'); walk(G.disk.roots[0], function (p, st) { add(G.disk, p, st); }, next); });
            }
            // 2. media cache files: never the ones of footage the open project uses (their names start with the file's name)
            jobs.push(function (next) {
                mediaCacheRoots(function (roots) {
                    var seen = {}, dirs = [];
                    roots.concat(prefs.disk ? [prefs.disk] : []).forEach(function (r) {
                        ['Media Cache Files', 'Peak Files', 'Analyzer Cache Files'].forEach(function (s) { var d = path.join(r, s); if (!seen[low(d)] && isDir(d)) { seen[low(d)] = true; dirs.push(d); } });
                    });
                    G.media.roots = dirs;
                    onStatus('Reading the media cache…');
                    (function one(k) {
                        if (k >= dirs.length) { next(); return; }
                        walk(dirs[k], function (p, st) {
                            var b = path.basename(p).toLowerCase();
                            for (var u = 0; u < usedStem.length; u++) if (usedStem[u] && b.indexOf(usedStem[u]) === 0) { G.media.kept++; return; }
                            add(G.media, p, st);
                        }, function () { one(k + 1); });
                    })(0);
                });
            });
            // 3. auto-saves next to the recent projects (and the open one): all but the open project's own
            jobs.push(function (next) {
                var dirs = {}, list = prefs.recent.slice();
                if (info.project) list.push(info.project);
                list.forEach(function (p) { var d = path.join(path.dirname(p), 'Adobe After Effects Auto-Save'); if (isDir(d)) dirs[low(d)] = d; });
                ['Documents', path.join('OneDrive', 'Documents')].forEach(function (s) {
                    ['2026', '2025', '2024'].forEach(function (y) { var d = path.join(HOME, s, 'Adobe', 'After Effects ' + y, 'Auto-Save'); if (isDir(d)) dirs[low(d)] = d; });
                });
                var ds = Object.keys(dirs).map(function (k) { return dirs[k]; });
                G.autosave.roots = ds;
                onStatus('Looking for old auto-saves…');
                (function one(k) {
                    if (k >= ds.length) { next(); return; }
                    walk(ds[k], function (p, st) {
                        if (!/\.aep$/i.test(p)) return;
                        if (projBase && path.basename(p).toLowerCase().indexOf(projBase) === 0) { G.autosave.kept++; return; }
                        add(G.autosave, p, st);
                    }, function () { one(k + 1); }, { depth: 1 });
                })(0);
            });
            // 4. Dala Suite outputs: the shared folders + "Dala SFX" / "Dala Stems" next to the open project's footage and
            //    in the folders of the recent projects (two levels down)
            jobs.push(function (next) {
                var cand = {}, push = function (d) { if (isDir(d)) cand[low(d)] = d; };
                [path.join(HOME, 'Documents'), path.join(HOME, 'OneDrive', 'Documents')].forEach(function (doc) { push(path.join(doc, 'Dala Suite', 'SFX')); push(path.join(doc, 'Dala Suite', 'Stems')); });
                push(path.join(HOME, 'Downloads', 'Dala Suite', 'From links'));
                var bases = {};
                (info.files || []).forEach(function (f) { bases[low(path.dirname(f))] = path.dirname(f); });
                prefs.recent.concat(info.project ? [info.project] : []).forEach(function (p) { bases[low(path.dirname(p))] = path.dirname(p); });
                Object.keys(bases).forEach(function (k) {
                    var b = bases[k];
                    if (/^Dala (SFX|Stems)$/i.test(path.basename(b))) push(b);                 // a Dala folder the project uses files from
                    push(path.join(b, 'Dala SFX')); push(path.join(b, 'Dala Stems'));
                    var subs = [];
                    try { subs = fs.readdirSync(b); } catch (e) {}
                    for (var s = 0; s < subs.length && s < 400; s++) {
                        var d1 = path.join(b, subs[s]);
                        if (/^Dala (SFX|Stems)$/i.test(subs[s])) push(d1);
                        else if (isDir(d1)) { push(path.join(d1, 'Dala SFX')); push(path.join(d1, 'Dala Stems')); }
                    }
                });
                var ds = Object.keys(cand).map(function (k) { return cand[k]; });
                G.dala.roots = ds;
                onStatus('Looking for Dala Suite files…');
                (function one(k) {
                    if (k >= ds.length) { next(); return; }
                    walk(ds[k], function (p, st) {
                        if (used[low(p)]) { G.dala.kept++; return; }
                        if (/\.part$/i.test(p) && Date.now() - st.mtime.getTime() < RECENT) return;      // a run going on now
                        add(G.dala, p, st);
                    }, function () { one(k + 1); }, { depth: 2 });
                })(0);
            });
            // 5. Dala Suite temp folders
            jobs.push(function (next) {
                var ds = ['DalaAudio', 'DalaCaptions', 'Dala SFX', 'Dala Stems'].map(function (n) { return path.join(TMP, n); }).filter(isDir);
                G.temp.roots = ds;
                (function one(k) {
                    if (k >= ds.length) { next(); return; }
                    walk(ds[k], function (p, st) {
                        if (used[low(p)] || Date.now() - st.mtime.getTime() < RECENT) { G.temp.kept++; return; }
                        add(G.temp, p, st);
                    }, function () { one(k + 1); });
                })(0);
            });
            (function run(k) {
                if (k >= jobs.length) {
                    var list = ['disk', 'media', 'autosave', 'dala', 'temp'].map(function (key) { return G[key]; });
                    // a file the open project uses never counts, whatever group found it
                    list.forEach(function (g) { g.files = g.files.filter(function (f) { return !used[low(f)] && low(f) !== project; }); });
                    cb(null, list);
                    return;
                }
                try { jobs[k](function () { run(k + 1); }); } catch (e) { cb(e); }
            })(0);
        }

        /** removes empty folders under (not including) each root */
        function prune(roots) {
            roots.forEach(function (r) {
                (function rm(d, top) {
                    var names = [];
                    try { names = fs.readdirSync(d); } catch (e) { return; }
                    names.forEach(function (n) { var p = path.join(d, n); try { if (fs.lstatSync(p).isDirectory()) rm(p, false); } catch (e2) {} });
                    if (!top) { try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch (e3) {} }
                })(r, true);
            });
        }

        /** files to the Recycle Bin (SHFileOperation, silent, undoable) through PowerShell; cb(okCount, failCount) */
        function recycle(files, cb) {
            if (!files.length) { cb(0, 0); return; }
            var list = path.join(TMP, 'dala-recycle-' + Date.now() + '.txt'), ps1 = list.replace(/\.txt$/, '.ps1');
            var script = [
                'param([string]$list)',
                'Add-Type -TypeDefinition @"',
                'using System; using System.Runtime.InteropServices;',
                'public static class DalaBin {',
                '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
                '  struct OP { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool fAborted; public IntPtr maps; public string title; }',
                '  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref OP op);',
                '  public static int Recycle(string p) { OP o = new OP(); o.wFunc = 3; o.pFrom = p + "\\0\\0"; o.fFlags = 0x40 | 0x10 | 0x400 | 0x4; return SHFileOperation(ref o); }',
                '}',
                '"@',
                '$ok = 0; $bad = 0',
                'foreach ($p in [System.IO.File]::ReadAllLines($list, [System.Text.Encoding]::UTF8)) { if ($p -and (Test-Path -LiteralPath $p)) { if ([DalaBin]::Recycle($p) -eq 0 -and -not (Test-Path -LiteralPath $p)) { $ok++ } else { $bad++ } } }',
                'Write-Output "RESULT $ok $bad"'
            ].join('\r\n');
            try { fs.writeFileSync(list, files.join('\r\n'), 'utf8'); fs.writeFileSync(ps1, '﻿' + script, 'utf8'); } catch (e) { cb(0, files.length); return; }
            var out = '', child;
            try { child = N.cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, list], { windowsHide: true }); }
            catch (e2) { cb(0, files.length); return; }
            child.stdout.on('data', function (d) { out += String(d); });
            child.on('error', function () { cb(0, files.length); });
            child.on('close', function () {
                try { fs.unlinkSync(list); fs.unlinkSync(ps1); } catch (e3) {}
                var m = /RESULT (\d+) (\d+)/.exec(out);
                cb(m ? +m[1] : 0, m ? +m[2] : files.length);
            });
        }

        function clean(groups, keys, info, host, onStatus, cb) {
            var want = {}, res = { freed: 0, deleted: 0, recycled: 0, failed: 0, groups: {} };
            keys.forEach(function (k) { want[k] = true; });
            var todo = groups.filter(function (g) { return want[g.key] && g.files.length; });
            (function one(k) {
                if (k >= todo.length) { cb(null, res); return; }
                var g = todo[k], r = { files: 0, bytes: 0, failed: 0 };
                res.groups[g.key] = r;
                function del(files, done) {
                    var i = 0;
                    (function batch() {
                        var t = Date.now();
                        for (; i < files.length; i++) {
                            var st = null;
                            try { st = (g.sizes && g.sizes[files[i]] !== undefined) ? g.sizes[files[i]] : fs.statSync(files[i]).size; fs.unlinkSync(files[i]); r.files++; r.bytes += st; }
                            catch (e) { if (exists(files[i])) r.failed++; }
                            if (Date.now() - t > 40) { i++; onStatus(g.label + ': ' + Math.round(100 * i / files.length) + '%'); setTimeout(batch, 0); return; }
                        }
                        prune(g.roots);
                        done();
                    })();
                }
                function finishGroup() { res.freed += r.bytes; res.failed += r.failed; one(k + 1); }
                onStatus(g.label + '…');
                if (g.how === 'recycle') {
                    var sizes = g.sizes || {};
                    recycle(g.files, function (ok, bad) {
                        g.files.forEach(function (f) { if (!exists(f)) { r.files++; r.bytes += sizes[f] || 0; } });
                        r.failed = g.files.length - r.files;
                        res.recycled += r.files;
                        prune(g.roots);
                        finishGroup();
                    });
                } else if (g.how === 'purge') {
                    // After Effects empties its own disk cache first (it keeps track of it); whatever is left is deleted
                    var sz = g.sizes || {};
                    onStatus('After Effects is emptying its disk cache…');
                    host('$._dalaSuite.general.purgeCaches()', function () {
                        del(g.files, function () {
                            r.files = 0; r.bytes = 0;
                            g.files.forEach(function (f) { if (!exists(f)) { r.files++; r.bytes += sz[f] || 0; } });
                            r.failed = g.files.length - r.files;
                            res.deleted += r.files;
                            finishGroup();
                        });
                    });
                } else {
                    del(g.files, function () { res.deleted += r.files; finishGroup(); });
                }
            })(0);
        }

        return { scan: scan, clean: clean, readPrefs: readPrefs };
    }

    root.DalaCleanup = { create: create };
})(typeof window !== 'undefined' ? window : this);
