/**
 * Dala Suite - GENERAL > Link: paste a TikTok, YouTube, Instagram, Pinterest or X link, the video (or the
 * picture, or only the sound) is downloaded for After Effects (ES5; runs in the CEP panel and under plain Node).
 *
 * The download is done by yt-dlp (Unlicense, github.com/yt-dlp/yt-dlp). It is not shipped in the .zxp: the
 * first time, yt-dlp.exe comes from its latest GitHub release (SHA-256 checked against that release's
 * SHA2-256SUMS) into %LOCALAPPDATA%\DalaSuite\tools, and it updates itself once a day (yt-dlp -U), since those
 * sites change often. FFmpeg (the official imageio-ffmpeg 0.6.0 wheel from PyPI, pinned and SHA-256 checked)
 * joins picture and sound into an MP4 After Effects reads (H.264 first); without it only single-file formats
 * are fetched. Downloads are saved in Downloads\Dala Suite\From links. Pinterest picture pins are read from the
 * pin page itself (its og:image).
 * YouTube asks for a JavaScript runtime to solve its player challenges. Only when a YouTube download fails for
 * lack of one, Deno (MIT, pinned release 2.9.7 from github.com/denoland/deno, SHA-256 checked) is fetched once
 * into tools\deno and the download runs again with it; from then on yt-dlp always gets it (--js-runtimes).
 *
 *   var link = DalaLinkImport.create({ fs, path, os, cp, https, crypto, url }, process.env);
 *   var job = link.download(url, { audioOnly: false }, { onStatus(text) }, function (err, file) {...});
 *   job.cancel();      link.busy()      link.paths
 * Errors are { code, message, detail }: code = input | network | blocked | unavailable | private | unsupported | corrupt |
 * disk | runtime | cancelled.
 */
(function (root) {
    'use strict';

    var YTDLP = {
        exe: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        sums: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
        minSize: 1e6
    };
    var FFMPEG = {
        url: 'https://files.pythonhosted.org/packages/2c/c6/fa760e12a2483469e2bf5058c5faff664acf66cadb4df2ad6205b016a73d/imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl',
        sha256: '02fa47c83703c37df6bfe4896aab339013f62bf02c5ebf2dce6da56af04ffc0a',
        size: 31246824,
        entry: 'imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
        exeSize: 87638016
    };
    var DENO = {
        url: 'https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-pc-windows-msvc.zip',
        sha256: 'a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238',
        size: 42630221,
        entry: 'deno.exe',
        exeSize: 97462048
    };
    var DAY = 24 * 3600e3;

    function err(code, message, detail) { return { code: code, message: message, detail: detail ? String(detail) : '' }; }
    function stamp() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }

    /** the one message a failed yt-dlp run deserves, from its output */
    function linkError(t) {
        t = String(t || '');
        if (/Sign in to confirm|confirm you.re not a bot|use --cookies|cookies/i.test(t)) return err('blocked', 'The site asks to sign in for this video: try another link, or download it yourself and drop it in After Effects.', t);
        if (/Video unavailable|video is unavailable|has been removed|no longer available|not available in your country|blocked it in your country/i.test(t)) return err('unavailable', 'This video is unavailable: removed, private or blocked where you are.', t);
        if (/Private video|is private|login required|log in to|members-only|age-restricted|age restricted/i.test(t)) return err('private', 'This video is private or needs an account.', t);
        if (/Unsupported URL|is not a valid URL|No video formats|no video could be found|HTTP Error 404/i.test(t)) return err('unsupported', 'This site is not supported, or the link is wrong.', t);
        if (/getaddrinfo|Failed to resolve|timed out|Connection|Network|Temporary failure/i.test(t)) return err('network', 'No connection to the site. Check the internet connection and try again.', t);
        var last = t.split(/\r?\n/).filter(function (l) { return /ERROR/.test(l); }).pop();
        return err('runtime', 'The download failed' + (last ? ': ' + last.replace(/^.*ERROR:\s*/, '').slice(0, 160) : '.'), t);
    }

    /** a failed YouTube run in which yt-dlp had no JavaScript runtime for YouTube's player challenges */
    function wantsDeno(url, text) {
        return /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(String(url)) &&
            /JavaScript runtime|js-runtimes|challenge solv|n challenge|nsig|signature extraction|EJS/i.test(String(text));
    }

    function create(N, env) {
        var local = env.LOCALAPPDATA;
        if (!local || !N.path.isAbsolute(local)) local = N.path.join(N.os.homedir(), 'AppData', 'Local');
        var home = env.USERPROFILE && N.path.isAbsolute(env.USERPROFILE) ? env.USERPROFILE : N.os.homedir();
        var sysRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
        var P = { tools: N.path.join(local, 'DalaSuite', 'tools') };
        P.ytdlp = N.path.join(P.tools, 'yt-dlp.exe');
        P.updated = N.path.join(P.tools, 'yt-dlp.updated');
        P.ffDir = N.path.join(P.tools, 'ffmpeg');
        P.ffmpeg = N.path.join(P.ffDir, 'ffmpeg.exe');
        P.denoDir = N.path.join(P.tools, 'deno');
        P.deno = N.path.join(P.denoDir, 'deno.exe');
        P.out = N.path.join(home, 'Downloads', 'Dala Suite', 'From links');
        var running = null;

        function exists(p) { try { return N.fs.existsSync(p); } catch (e) { return false; } }
        function size(p) { try { return N.fs.statSync(p).size; } catch (e) { return 0; } }
        function mkdirs(p) { if (exists(p)) return; mkdirs(N.path.dirname(p)); try { N.fs.mkdirSync(p); } catch (e) { if (!exists(p)) throw e; } }
        function unlink(p) { try { N.fs.unlinkSync(p); } catch (e) {} }

        // ------------------------------------------------------------ https (redirects followed)

        function get(url, dest, onBytes, state, cb, hops) {
            hops = hops || 0;
            var done = false, req;
            function finish(e, body) { if (!done) { done = true; state.req = null; cb(e, body); } }
            try {
                // (an options object, not https.get(url, options, cb): older After Effects ship Node before 10.9)
                var u = N.url.parse(url);
                var opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DalaSuite', 'Accept-Language': 'en' } };
                req = N.https.get(opts, function (res) {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 8) {
                        res.resume();
                        done = true;
                        get(N.url.resolve(url, res.headers.location), dest, onBytes, state, cb, hops + 1);
                        return;
                    }
                    if (res.statusCode !== 200) { res.resume(); finish({ code: 'HTTP', message: 'HTTP ' + res.statusCode + ' for ' + url }); return; }
                    var total = +res.headers['content-length'] || 0, got = 0, chunks = [];
                    if (!dest) res.setEncoding('utf8');     // text (no Buffer: it is not a global in every CEP page)
                    res.on('data', function (d) { got += d.length; if (onBytes) onBytes(got, total); if (!dest) chunks.push(d); });
                    res.on('error', finish);
                    if (!dest) { res.on('end', function () { finish(null, chunks.join('')); }); return; }
                    var out = N.fs.createWriteStream(dest);
                    out.on('error', finish);
                    out.on('finish', function () { out.close(function () { finish(got > 0 ? null : { code: 'EMPTY', message: 'empty download' }); }); });
                    res.pipe(out);
                });
            } catch (e) { finish(e); return; }
            state.req = req;
            req.setTimeout(45000, function () { req.abort(); finish({ code: 'ETIMEDOUT', message: 'the download stalled for 45 s' }); });
            req.on('error', finish);
        }

        function sha256File(file, cb) {
            var h = N.crypto.createHash('sha256'), s = N.fs.createReadStream(file);
            s.on('data', function (d) { h.update(d); });
            s.on('error', cb);
            s.on('end', function () { cb(null, h.digest('hex')); });
        }

        function netError(e, what) {
            var c = (e && e.code) || '';
            if (/ENOSPC/.test(c)) return err('disk', 'Not enough free disk space for ' + what + '.', e.message);
            if (/EACCES|EPERM/.test(c)) return err('disk', 'Windows blocked writing ' + what + ' to ' + P.tools + '.', e.message);
            return err('network', 'Could not download ' + what + '. Check the internet connection and try again.', e && e.message);
        }

        // ------------------------------------------------------------ processes

        /** runs a program, streaming its output lines; cb(code, allText) */
        function run(exe, args, state, onLine, cb, timeoutMs) {
            var child, text = '', buf = { o: '', e: '' }, finished = false, timer = 0;
            try { child = N.cp.spawn(exe, args, { windowsHide: true, cwd: P.tools, env: env }); }
            catch (e) { cb(-1, 'Could not start ' + exe + ': ' + e.message); return; }
            state.child = child;
            function take(k, d) {
                buf[k] += String(d);
                var lines = buf[k].split(/\r?\n|\r/);
                buf[k] = lines.pop();
                for (var i = 0; i < lines.length; i++) { text += lines[i] + '\n'; if (onLine) onLine(lines[i]); }
                if (text.length > 200000) text = text.slice(-100000);
            }
            function end(code) {
                if (finished) return;
                finished = true; clearTimeout(timer); state.child = null;
                if (buf.o) { text += buf.o + '\n'; if (onLine) onLine(buf.o); }
                if (buf.e) text += buf.e + '\n';
                cb(code, text);
            }
            child.stdout.on('data', function (d) { take('o', d); });
            child.stderr.on('data', function (d) { take('e', d); });
            child.on('error', function (e) { text += 'Could not start ' + exe + ': ' + e.message + '\n'; end(-1); });
            child.on('close', function (code) { end(code); });
            // a cancelled program: do not wait for its output pipes (a leftover child process could hold them open)
            child.on('exit', function (code) { if (state.cancelled) setTimeout(function () { end(code); }, 1500); });
            if (timeoutMs) timer = setTimeout(function () { killTree(child); end(-2); }, timeoutMs);
        }

        /** yt-dlp.exe starts a second copy of itself (and FFmpeg while joining): stop the whole process tree.
         *  taskkill first - killing the first process directly would orphan the second, which keeps downloading */
        function killTree(child) {
            function direct() { try { child.kill(); } catch (e) {} }
            try { N.cp.execFile(N.path.join(sysRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, function (e) { if (e) direct(); }); }
            catch (e2) { direct(); }
        }

        // ------------------------------------------------------------ yt-dlp

        function lastUpdate() { try { return +N.fs.readFileSync(P.updated, 'utf8') || 0; } catch (e) { return 0; } }
        function markUpdated() { try { N.fs.writeFileSync(P.updated, String(Date.now())); } catch (e) {} }
        function selfUpdate(state, cb) { run(P.ytdlp, ['-U'], state, null, function () { markUpdated(); cb(); }, 60000); }

        function fetchYtdlp(state, onStatus, cb, again) {
            get(YTDLP.sums, null, null, state, function (e, body) {
                if (state.cancelled) { cb(err('cancelled', 'Cancelled.')); return; }
                if (e) { cb(netError(e, 'the video downloader')); return; }
                var m = /^([0-9a-f]{64})\s+\*?yt-dlp\.exe\s*$/m.exec(body || '');
                if (!m) { cb(err('corrupt', 'The video downloader\'s checksum list could not be read.', String(body).slice(0, 200))); return; }
                var part = P.ytdlp + '.part';
                get(YTDLP.exe, part, function (g, t) { onStatus('Getting the video downloader (only once) \u00B7 ' + (t ? Math.round(g / t * 100) + '%' : Math.round(g / 1e6) + ' MB')); }, state, function (e2) {
                    if (state.cancelled) { unlink(part); cb(err('cancelled', 'Cancelled.')); return; }
                    if (e2) { unlink(part); cb(netError(e2, 'the video downloader')); return; }
                    sha256File(part, function (e3, hex) {
                        if (e3 || hex !== m[1]) {
                            unlink(part);
                            // a new release can land between the two downloads: one more try
                            if (!again) { fetchYtdlp(state, onStatus, cb, true); return; }
                            cb(err('corrupt', 'The video downloader was damaged in transit (checksum mismatch). Try again; a proxy or antivirus may be changing downloads.', e3 ? e3.message : hex));
                            return;
                        }
                        unlink(P.ytdlp);
                        try { N.fs.renameSync(part, P.ytdlp); } catch (e4) { cb(netError(e4, 'the video downloader')); return; }
                        markUpdated();
                        cb(null);
                    });
                });
            });
        }

        function ensureYtdlp(state, onStatus, cb) {
            try { mkdirs(P.tools); } catch (e) { cb(netError(e, 'the video downloader')); return; }
            if (size(P.ytdlp) < YTDLP.minSize) { onStatus('Getting the video downloader (only once)\u2026'); fetchYtdlp(state, onStatus, cb); return; }
            if (Date.now() - lastUpdate() > DAY) { onStatus('Checking the video downloader for updates\u2026'); selfUpdate(state, function () { cb(null); }); return; }
            cb(null);
        }

        // ------------------------------------------------------------ pinned tools: FFmpeg (imageio-ffmpeg wheel), Deno

        function unzipEntry(zip, entry, dir, what, state, cb) {
            var tar = N.path.join(sysRoot, 'System32', 'tar.exe'), want = N.path.join(dir, entry.split('/').join(N.path.sep));
            function viaPowerShell() {
                var q = function (x) { return "'" + String(x).replace(/'/g, "''") + "'"; };
                var ps = N.path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
                var zipCopy = zip.replace(/\.[^.\\\/]+$/, '') + '.zip';     // Expand-Archive only opens .zip names
                try { if (zipCopy !== zip) N.fs.renameSync(zip, zipCopy); } catch (e) { cb(err('runtime', 'Could not unpack ' + what + '.', e.message)); return; }
                run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
                    'Expand-Archive -LiteralPath ' + q(zipCopy) + ' -DestinationPath ' + q(dir) + ' -Force'], state, null, function (code, text) {
                    unlink(zipCopy);
                    cb(exists(want) ? null : err('runtime', 'Could not unpack ' + what + '.', text), want);
                });
            }
            if (!exists(tar)) { viaPowerShell(); return; }
            run(tar, ['-xf', zip, '-C', dir, entry], state, null, function (code) {
                if (code === 0 && exists(want)) cb(null, want); else viaPowerShell();
            });
        }

        /** T: { url, sha256, size, entry, exeSize } - the archive is downloaded, checked, and its one program
         *  unpacked to exe (in its own folder); nothing is done when exe is already there, complete */
        function ensureTool(T, what, exe, state, onStatus, cb) {
            if (size(exe) === T.exeSize || size(exe) > 10000000) { cb(null); return; }
            var base = N.path.basename(exe, '.exe'), arc = N.path.join(P.tools, base + '.download' + N.path.extname(T.url)), tmp = N.path.join(P.tools, base + '.part');
            var title = 'Getting ' + what + ' (only once)';
            try { mkdirs(tmp); } catch (e) { cb(netError(e, what)); return; }
            onStatus(title + '\u2026');
            get(T.url, arc, function (g) { onStatus(title + ' \u00B7 ' + Math.min(100, Math.round(g / T.size * 100)) + '%'); }, state, function (e) {
                if (state.cancelled) { unlink(arc); cb(err('cancelled', 'Cancelled.')); return; }
                if (e) { unlink(arc); cb(netError(e, what)); return; }
                sha256File(arc, function (e2, hex) {
                    if (e2 || hex !== T.sha256) { unlink(arc); cb(err('corrupt', what.charAt(0).toUpperCase() + what.slice(1) + ' was damaged in transit (checksum mismatch).', e2 ? e2.message : hex)); return; }
                    onStatus('Unpacking ' + what + '\u2026');
                    unzipEntry(arc, T.entry, tmp, what, state, function (e3, got) {
                        unlink(arc);
                        if (e3) { cb(e3); return; }
                        try {
                            mkdirs(N.path.dirname(exe));
                            unlink(exe);
                            N.fs.renameSync(got, exe);
                        } catch (e4) { cb(netError(e4, what)); return; }
                        N.cp.execFile(N.path.join(sysRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'rmdir', '/s', '/q', tmp], { windowsHide: true }, function () {});
                        cb(size(exe) === T.exeSize ? null : err('corrupt', what + ' did not unpack completely.'));
                    });
                });
            });
        }
        function ensureFfmpeg(state, onStatus, cb) { ensureTool(FFMPEG, 'FFmpeg', P.ffmpeg, state, onStatus, cb); }
        function ensureDeno(state, onStatus, cb) { ensureTool(DENO, 'the YouTube helper (Deno)', P.deno, state, onStatus, cb); }

        // ------------------------------------------------------------ Pinterest picture pins

        function pinterestImage(url, state, cb) {
            get(url, null, null, state, function (e, html) {
                if (e || !html) { cb(null); return; }
                var m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) || /"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/.exec(html);
                if (!m) { cb(null); return; }
                var src = m[1].replace(/\/(236x|474x|564x|736x)\//, '/originals/');
                var ext = ((src.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i) || [0, 'jpg'])[1]).toLowerCase();
                var out = N.path.join(P.out, 'pinterest_' + stamp() + '.' + ext);
                get(src, out, null, state, function (e2) {
                    if (!e2) { cb(out); return; }
                    unlink(out);
                    get(m[1], out, null, state, function (e3) { if (e3) { unlink(out); cb(null); } else cb(out); });
                });
            });
        }

        // ------------------------------------------------------------ the download

        function ytArgs(url, audioOnly, haveFf, haveJs) {
            var a = ['--no-playlist', '--newline', '--progress', '--no-simulate', '--encoding', 'utf-8',
                '--print', 'after_move:filepath', '--restrict-filenames', '--no-mtime', '--no-part',
                '-P', P.out, '-o', '%(extractor)s_%(title).50B_%(id)s.%(ext)s'];
            if (haveFf) a.push('--ffmpeg-location', P.ffmpeg);
            if (haveJs) a.push('--js-runtimes', 'deno:' + P.deno);
            // stereo sound first (channels:2): After Effects mixes in stereo, and YouTube also offers 5.1 tracks
            if (audioOnly) a.push('-f', 'ba/b', '-S', 'channels:2', '-x', '--audio-format', 'wav');
            else if (haveFf) a.push('-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b', '-S', 'vcodec:h264,res:1080,acodec:m4a,channels:2', '--merge-output-format', 'mp4');
            else a.push('-f', 'b[ext=mp4]/b');
            a.push('--', url);
            return a;
        }

        function download(url, opts, cbs, cb) {
            opts = opts || {}; cbs = cbs || {};
            var state = { cancelled: false, req: null, child: null }, audioOnly = !!opts.audioOnly;
            var onStatus = cbs.onStatus || function () {};
            var job = {
                cancel: function () {
                    state.cancelled = true;
                    try { if (state.req) state.req.abort(); } catch (e) {}
                    if (state.child) killTree(state.child);
                }
            };
            var before = null;
            /** after a cancel, what this download wrote (parts, unmerged streams, a finished file) is deleted;
             *  again a little later, since Windows keeps a just-killed program's files locked for a moment */
            function cleanup() {
                if (!before) return;
                function sweep() { try { N.fs.readdirSync(P.out).forEach(function (f) { if (!before[f]) unlink(N.path.join(P.out, f)); }); } catch (e) {} }
                sweep(); setTimeout(sweep, 1500); setTimeout(sweep, 5000);
            }
            function finish(e, file) { running = null; if (e && e.code === 'cancelled') cleanup(); cb(e, file); }
            url = String(url || '').trim();
            if (!/^https?:\/\/\S+\.\S+/i.test(url)) { setTimeout(function () { cb(err('input', 'Paste a link first (it starts with https://).')); }, 0); return job; }
            if (running) { setTimeout(function () { cb(err('input', 'A download is already running.')); }, 0); return job; }
            running = job;
            try { mkdirs(P.out); } catch (eOut) { setTimeout(function () { finish(err('disk', 'Could not create ' + P.out + '.', eOut.message)); }, 0); return job; }
            before = {};
            try { N.fs.readdirSync(P.out).forEach(function (f) { before[f] = true; }); } catch (eList) {}

            ensureYtdlp(state, onStatus, function (e1) {
                if (e1) { finish(e1); return; }
                ensureFfmpeg(state, onStatus, function (e2) {
                    if (state.cancelled) { finish(err('cancelled', 'Cancelled.')); return; }
                    var haveFf = !e2;     // without FFmpeg: single-file formats only (lower quality on YouTube)
                    if (!haveFf && audioOnly) { finish(e2); return; }
                    var haveDeno = size(P.deno) === DENO.exeSize, denoTried = false;
                    var args = ytArgs(url, audioOnly, haveFf, haveDeno), updated = false;
                    function once() {
                        onStatus(audioOnly ? 'Downloading the sound\u2026' : 'Downloading the video\u2026');
                        run(P.ytdlp, args, state, function (l) {
                            var m = /\[download\]\s+([\d.]+)%/.exec(l);
                            if (m) onStatus((audioOnly ? 'Downloading the sound' : 'Downloading the video') + ' \u00B7 ' + Math.round(+m[1]) + '%');
                            else if (/^\[(Merger|ExtractAudio|VideoConvertor|FixupM3u8)\]/.test(l)) onStatus('Converting\u2026');
                        }, function (code, text) {
                            if (state.cancelled) { finish(err('cancelled', 'Cancelled.')); return; }
                            var lines = text.split('\n'), file = null, i;
                            for (i = lines.length - 1; i >= 0 && !file; i--) { var l = lines[i].trim(); if (l && l.charAt(0) !== '[' && N.path.isAbsolute(l) && exists(l)) file = l; }
                            if (code === 0 && file) { finish(null, file); return; }
                            // Pinterest: video pins come through yt-dlp, picture pins from the pin page
                            if (/pinterest\.|pin\.it\//i.test(url) && !audioOnly) {
                                onStatus('Getting the picture\u2026');
                                pinterestImage(url, state, function (img) { if (img) finish(null, img); else finish(linkError(text)); });
                                return;
                            }
                            var code2 = linkError(text).code, hopeless = code2 === 'unavailable' || code2 === 'private' || /Unsupported URL|not a valid URL|HTTP Error 404/i.test(text);
                            // YouTube failed for lack of a JavaScript runtime: get Deno (only once) and try again with it
                            if (!haveDeno && !denoTried && !hopeless && code2 !== 'blocked' && code2 !== 'network' && wantsDeno(url, text)) {
                                denoTried = true;
                                ensureDeno(state, onStatus, function (eD) {
                                    if (state.cancelled) { finish(err('cancelled', 'Cancelled.')); return; }
                                    if (eD) { finish(eD); return; }
                                    haveDeno = true;
                                    args = ytArgs(url, audioOnly, haveFf, true);
                                    once();
                                });
                                return;
                            }
                            // the site may have changed: update yt-dlp once and try again (not for links that can never work)
                            if (!updated && !hopeless) {
                                updated = true;
                                onStatus('Updating the video downloader\u2026');
                                selfUpdate(state, once);
                                return;
                            }
                            finish(linkError(text));
                        });
                    }
                    once();
                });
            });
            return job;
        }

        /** FFmpeg on its own (SFX Extractor): fetched once, pinned and checked like for Link. cb(err, ffmpegPath) */
        function ffmpeg(onStatus, cb) {
            var state = { cancelled: false, req: null, child: null };
            ensureFfmpeg(state, onStatus || function () {}, function (e) { cb(e, e ? null : P.ffmpeg); });
            return { cancel: function () { state.cancelled = true; try { if (state.req) state.req.abort(); } catch (eA) {} } };
        }

        return { download: download, busy: function () { return !!running; }, paths: P, args: ytArgs, ffmpeg: ffmpeg, hasFfmpeg: function () { return size(P.ffmpeg) === FFMPEG.exeSize || size(P.ffmpeg) > 10000000; } };
    }

    var api = { create: create, linkError: linkError, wantsDeno: wantsDeno, FFMPEG: FFMPEG, DENO: DENO };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.DalaLinkImport = api;
})(typeof window !== 'undefined' ? window : this);
