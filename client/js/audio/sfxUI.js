/**
 * Dala Suite - SFX EXTRACTOR panel (ES5; the parser also runs under plain Node for tests).
 * Pulls the Centre channel out of a movie clip's 5.1 sound - the original dialogue and the effects mixed with it
 * (punches, kicks, sword clashes, impacts, whooshes, footsteps) - as a mono WAV, and adds it to the comp as an
 * audio layer timed exactly like the clip. No AI: FFmpeg (the pinned build GENERAL > Link uses, fetched once) reads
 * the file's channel layout, and the Centre is taken BY NAME (pan=mono|c0=FC: that one channel, gain 1, nothing
 * else mixed in). Layouts without a named Centre (mono, stereo, an unlabelled "6 channels") are refused with a
 * message instead of guessing. The span the layer plays is cut with an exact input seek, padded where the audio
 * track starts late or ends early (first_pts=0 / apad: sample 0 of the WAV is file time `offset`), written as
 * 32-bit float WAV at the file's own sample rate. The original layer is never changed.
 *
 *   DalaSfxUI.parseProbe(ffmpegStderr) -> { duration, start, audio: [{ aIndex, lang, codec, rate, layout, channels, count, centre, suitable }] }
 */
(function (root) {
    'use strict';
    var cs = null, N = null, link = null, dom = {};
    var S = { busy: false, job: null, range: 'layer', last: null, track: null };

    // FFmpeg's channel layouts and their channels, in FFmpeg's order (the order it decodes every codec to)
    var LAYOUTS = {
        'mono': ['FC'], 'stereo': ['FL', 'FR'], '2.1': ['FL', 'FR', 'LFE'], '3.0': ['FL', 'FR', 'FC'], '3.0(back)': ['FL', 'FR', 'BC'],
        '4.0': ['FL', 'FR', 'FC', 'BC'], 'quad': ['FL', 'FR', 'BL', 'BR'], 'quad(side)': ['FL', 'FR', 'SL', 'SR'], '3.1': ['FL', 'FR', 'FC', 'LFE'],
        '5.0': ['FL', 'FR', 'FC', 'BL', 'BR'], '5.0(side)': ['FL', 'FR', 'FC', 'SL', 'SR'], '4.1': ['FL', 'FR', 'FC', 'LFE', 'BC'],
        '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'], '5.1(side)': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
        '6.0': ['FL', 'FR', 'FC', 'BC', 'SL', 'SR'], '6.0(front)': ['FL', 'FR', 'FLC', 'FRC', 'SL', 'SR'], 'hexagonal': ['FL', 'FR', 'FC', 'BL', 'BR', 'BC'],
        '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'], '6.1(back)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'BC'], '6.1(front)': ['FL', 'FR', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
        '7.0': ['FL', 'FR', 'FC', 'BL', 'BR', 'SL', 'SR'], '7.0(front)': ['FL', 'FR', 'FC', 'FLC', 'FRC', 'SL', 'SR'],
        '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'], '7.1(wide)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'],
        '7.1(wide-side)': ['FL', 'FR', 'FC', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
        '5.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR'], '5.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR', 'TBL', 'TBR'],
        '7.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR'], '7.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR']
    };
    var NAMES = { FL: 'Front left', FR: 'Front right', FC: 'Centre', LFE: 'Low-frequency effects (subwoofer)', BL: 'Surround left (back)', BR: 'Surround right (back)',
        SL: 'Surround left (side)', SR: 'Surround right (side)', BC: 'Back centre', FLC: 'Front left of centre', FRC: 'Front right of centre',
        TFL: 'Top front left', TFR: 'Top front right', TBL: 'Top back left', TBR: 'Top back right' };

    /** FFmpeg's "-i" report -> the file's audio tracks and their channels */
    function parseProbe(text) {
        var out = { duration: null, start: 0, audio: [] }, m, a = 0;
        if ((m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?), start: (-?[\d.]+)/.exec(text))) {
            out.duration = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
            out.start = +m[4];
        }
        var lines = String(text).split(/\r?\n/), re = /Stream #\d+:(\d+)(?:\[0x[0-9a-f]+\])?(?:\(([^)]*)\))?: Audio: ([^,]+?)(?: \([^)]*\))*, (\d+) Hz, ([^,]+?)(?:, ([^,\s]+))?(?:,|$)/i;
        for (var i = 0; i < lines.length; i++) {
            m = re.exec(lines[i]);
            if (!m) continue;
            var lay = m[5].replace(/\s+$/, ''), ch = null, count = 0, cm;
            if (LAYOUTS[lay]) { ch = LAYOUTS[lay].slice(); count = ch.length; }
            else if ((cm = /^(\d+) channels(?: \(([A-Z0-9+]+)\))?$/.exec(lay))) {
                count = +cm[1];
                ch = cm[2] ? cm[2].split('+') : null;      // listed channels are named; a bare count has no order to trust
            } else if ((cm = /^(\d+) channels/.exec(lay))) count = +cm[1];
            var centre = ch ? ch.indexOf('FC') : -1;
            var title = '';
            for (var k = i + 1; k < lines.length && /^\s{6,}/.test(lines[k]); k++) {
                var t = /^\s+title\s*:\s*(.*)$/.exec(lines[k]);
                if (t) { title = t[1]; break; }
            }
            out.audio.push({ aIndex: a++, stream: +m[1], lang: m[2] || '', codec: m[3].replace(/\s+$/, ''), rate: +m[4], layout: lay, channels: ch, count: count,
                centre: centre, isDefault: /\(default\)/.test(lines[i]), title: title,
                // a real surround mix: a named Centre next to at least four other channels (5.0, 5.1, 6.1, 7.1...)
                suitable: !!ch && centre >= 0 && count >= 5 });
        }
        return out;
    }

    function $(id) { return document.getElementById(id); }
    function req(m) {
        try {
            if (typeof root.require === 'function') return root.require(m);
            if (root.cep_node && typeof root.cep_node.require === 'function') return root.cep_node.require(m);
        } catch (e) {}
        return null;
    }
    function nodeOk() {
        if (N) return true;
        var o = { fs: req('fs'), path: req('path'), os: req('os'), cp: req('child_process'), https: req('https'), crypto: req('crypto'), url: req('url') };
        for (var k in o) if (!o[k]) return false;
        N = o;
        return true;
    }
    function linker() {
        if (link) return link;
        if (!nodeOk() || !root.DalaLinkImport) return null;
        var proc = root.process || req('process');
        link = root.DalaLinkImport.create(N, (proc && proc.env) || {});
        return link;
    }
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
    /** short tag of a folder (FNV-1a), so files from different folders never share a name in Documents */
    function hash(s) {
        var h = 0x811c9dc5;
        s = String(s).toLowerCase();
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
        return ('0000000' + h.toString(16)).slice(-8).slice(0, 6);
    }
    /** 75.5 -> "01-15.500" (file-name safe; milliseconds only when not whole, so two spans never share a name) */
    function hms(s) {
        s = Math.max(0, s);
        var ms = Math.round(s * 1000) % 1000, t = Math.floor(Math.round(s * 1000) / 1000), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return (t >= 3600 ? Math.floor(t / 3600) + '-' : '') + p(Math.floor(t / 60) % 60) + '-' + p(t % 60) + (ms ? '.' + ('00' + ms).slice(-3) : '');
    }
    function dur(s) { s = Math.round(s); return s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor(s / 60 % 60) + ' min' : (s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s'); }

    // ------------------------------------------------------------------ progress / state

    function showProgress(f, label) {
        dom.progress.style.display = 'flex';
        if (f !== null && f !== undefined) dom.fill.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
        if (label) dom.label.textContent = label;
    }
    function hideProgress() { dom.progress.style.display = 'none'; }
    function setBusy(b) {
        S.busy = b;
        var btns = document.querySelectorAll('#sx-card .btn, #sx-card .subtab-btn');
        for (var i = 0; i < btns.length; i++) btns[i].disabled = b;
    }
    function note(t) { dom.note.textContent = t || ''; }
    function finish(msg, type) {
        S.job = null;
        setBusy(false);
        hideProgress();
        if (msg) { note(msg); toast(msg, type || 'info'); }
    }
    function badge() {
        var l = linker();
        if (!l) { dom.engine.textContent = 'UNAVAILABLE'; dom.engine.className = 'at-engine cap-engine bad'; return; }
        var ok = l.hasFfmpeg();
        dom.engine.textContent = ok ? 'FFMPEG READY' : 'FFMPEG: 31 MB ONCE';
        dom.engine.className = 'at-engine cap-engine' + (ok ? '' : ' warn');
        dom.engine.title = ok ? 'FFmpeg 7.1 (' + l.paths.ffmpeg + ')' : 'FFmpeg is downloaded once on the first run (31 MB, checksum-verified) - the same copy GENERAL > Link uses.';
    }

    // ------------------------------------------------------------------ channel map

    function showLayout(src, probe, track) {
        dom.map.innerHTML = '';
        if (!probe) { dom.srcBox.style.display = 'none'; return; }
        dom.srcBox.style.display = '';
        var t = probe.audio[track];
        var name = src.sourceName.length > 46 ? src.sourceName.slice(0, 43) + '…' : src.sourceName;
        dom.srcName.textContent = name;
        dom.srcName.title = src.file;
        dom.srcInfo.textContent = t ? (t.codec.toUpperCase() + ' · ' + t.layout + ' · ' + Math.round(t.rate / 100) / 10 + ' kHz' + (t.lang && t.lang !== 'und' ? ' · ' + t.lang : '') +
            (probe.audio.length > 1 ? ' · track ' + (track + 1) + ' of ' + probe.audio.length : '')) : 'no audio track';
        if (!t) return;
        var ch = t.channels || [];
        if (!ch.length) for (var u = 0; u < t.count; u++) ch.push('?');
        for (var i = 0; i < ch.length; i++) {
            var chip = document.createElement('span');
            chip.className = 'sx-ch' + (ch[i] === 'FC' && t.suitable ? ' centre' : '') + (ch[i] === '?' ? ' unknown' : '');
            chip.textContent = (i + 1) + ' ' + (ch[i] === 'FC' && t.suitable ? 'C' : ch[i]);
            chip.title = 'Channel ' + (i + 1) + ': ' + (NAMES[ch[i]] || 'unlabelled') + (ch[i] === 'FC' && t.suitable ? ' - this one is extracted' : '');
            dom.map.appendChild(chip);
        }
    }

    function verdict(t) {
        if (!t) return 'This file has no audio track.';
        if (t.suitable) return t.layout + ' found: channel ' + (t.centre + 1) + ' of ' + t.count + ' is the Centre (dialogue + effects). Only that channel is extracted.';
        if (t.count === 1) return 'This clip\'s sound is mono (one channel): there is no separate Centre channel in it. Use the original 5.1 release of the movie (DD 5.1, DD+ 5.1, AAC 5.1, DTS...).';
        if (t.count === 2) return 'This clip\'s sound is stereo' + (t.layout === 'stereo' ? '' : ' (' + t.layout + ')') + ': the dialogue, effects and music are already mixed into two channels, so there is no Centre channel to extract. Use the original 5.1 release of the movie (DD 5.1, DD+ 5.1, AAC 5.1, DTS...).';
        if (!t.channels) return 'This audio has ' + t.count + ' channels but no channel layout, so it is not known which one is the Centre - Dala will not guess. Re-export the file with its 5.1 layout, or use the original release.';
        return 'This audio is ' + t.layout + ' (' + t.channels.join(', ') + '): it has no separate Centre channel next to a full surround mix, so it is not 5.1 movie sound.';
    }

    // ------------------------------------------------------------------ ffmpeg

    function ffmpeg(job, cb) {
        var l = linker();
        if (!l) { cb('This panel cannot run FFmpeg (Node.js is off). Restart After Effects.'); return; }
        if (l.hasFfmpeg()) { cb(null, l.paths.ffmpeg); return; }
        showProgress(0.03, 'Getting FFmpeg (only once)…');
        job.dl = l.ffmpeg(function (text) {
            var m = /(\d+)%/.exec(text);
            showProgress(m ? 0.03 + 0.25 * (+m[1] / 100) : null, text);
        }, function (e, exe) {
            job.dl = null;
            badge();
            if (e) { cb(e.code === 'cancelled' ? 'cancelled' : 'FFmpeg could not be downloaded: ' + e.message + ' Check the internet connection and try again.'); return; }
            cb(null, exe);
        });
    }

    function probeFile(exe, file, job, cb) {
        var child, err = '';
        try { child = N.cp.spawn(exe, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true }); }
        catch (e) { cb('Could not start FFmpeg: ' + e.message); return; }
        job.child = child;
        child.stderr.on('data', function (d) { err += String(d); if (err.length > 200000) err = err.slice(-200000); });
        child.stdout.on('data', function () {});
        child.on('error', function (e) { cb('Could not start FFmpeg: ' + e.message); });
        child.on('close', function () {
            job.child = null;
            if (/No such file|Invalid data found|could not find codec|Permission denied/i.test(err) && !/Stream #/.test(err)) { cb('FFmpeg could not read the file: ' + (err.split(/\r?\n/).filter(Boolean).pop() || '')); return; }
            cb(null, parseProbe(err));
        });
    }

    /** the track to use: the one After Effects plays (the first) unless the user picked another one */
    function chooseTrack(probe) {
        if (S.track !== null && S.track < probe.audio.length) return S.track;
        return 0;
    }

    function mkdirs(p) {
        if (N.fs.existsSync(p)) return;
        mkdirs(N.path.dirname(p));
        try { N.fs.mkdirSync(p); } catch (e) { if (!N.fs.existsSync(p)) throw e; }
    }
    function outDir(file) {
        var cands = [N.path.join(N.path.dirname(file), 'Dala SFX'), N.path.join(N.os.homedir(), 'Documents', 'Dala Suite', 'SFX'), N.path.join(N.os.tmpdir(), 'Dala SFX')];
        for (var i = 0; i < cands.length; i++) {
            try {
                mkdirs(cands[i]);
                var probe = N.path.join(cands[i], '.write-test');
                N.fs.writeFileSync(probe, 'ok');
                N.fs.unlinkSync(probe);
                return cands[i];
            } catch (e) {}
        }
        return null;
    }
    /** path, or "name (2).wav"... when an earlier file of that name is still open in After Effects */
    function freeName(p) {
        var base = p.replace(/\.wav$/i, ''), cand = p, k = 2;
        while (N.fs.existsSync(cand)) {
            try { N.fs.unlinkSync(cand); break; } catch (e) { cand = base + ' (' + (k++) + ').wav'; }
        }
        return cand;
    }
    /** frames in a WAV file's data chunk (and its format), to check FFmpeg wrote everything */
    function wavInfo(p) {
        var B = req('buffer').Buffer;                       // (Buffer is not a global in every CEP page)
        var fd = N.fs.openSync(p, 'r'), b = B.alloc(4096), got, pos = 12, fmt = null;
        try { got = N.fs.readSync(fd, b, 0, 4096, 0); } finally { N.fs.closeSync(fd); }
        if (got < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
        while (pos + 8 <= got) {
            var id = b.toString('ascii', pos, pos + 4), size = b.readUInt32LE(pos + 4);
            if (id === 'fmt ') fmt = { tag: b.readUInt16LE(pos + 8), channels: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
            if (id === 'data') return fmt ? { fmt: fmt, frames: Math.floor(Math.min(size, N.fs.statSync(p).size - pos - 8) / (fmt.channels * fmt.bits / 8)) } : null;
            pos += 8 + size + (size & 1);
        }
        return null;
    }

    function runExtract(exe, src, t, job, cb) {
        var dir = outDir(src.file);
        if (!dir) { cb('No folder could be written for the Centre file (the movie\'s folder, Documents and Temp are all read-only?).'); return; }
        var len = src.length, rate = t.rate || 48000;
        var codec = 'pcm_f32le', bytes = 4;
        if (len * rate * 4 > 3.9e9) { codec = 'pcm_s24le'; bytes = 3; }               // WAV files stop at 4 GB
        if (len * rate * bytes > 3.9e9) { cb('This span is too long for one WAV file (' + dur(len) + '). Use Work area to extract a part of the clip.'); return; }
        // After Effects does not lock the files it plays: a name stands for one file, track and span, so an existing
        // file is only ever replaced by the same content - the movie's own file name (with its extension, plus its
        // folder when the Centre goes to the shared Documents folder), the track when it is not the first, the span
        var all = src.whole || (src.offset < 0.01 && Math.abs(src.offset + len - src.fileDuration) < 0.1);
        var name = N.path.basename(src.file).replace(/[\\\/:*?"<>|]/g, '_') +
            (N.path.dirname(dir) === N.path.dirname(src.file) ? '' : ' [' + hash(N.path.dirname(src.file)) + ']') +
            (t.aIndex > 0 ? ' track ' + (t.aIndex + 1) : '') + ' - Centre' + (all ? '' : ' ' + hms(src.offset) + ' to ' + hms(src.offset + len)) + '.wav';
        var out = freeName(N.path.join(dir, name)), part = out + '.part';
        try { if (N.fs.existsSync(part)) N.fs.unlinkSync(part); } catch (eP) {}
        var L = len.toFixed(6);
        var args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
            '-ss', src.offset.toFixed(6), '-i', src.file, '-t', L, '-map', '0:a:' + t.aIndex, '-vn', '-sn', '-dn', '-map_metadata', '-1',
            '-af', 'pan=mono|c0=FC,aresample=async=1:min_hard_comp=0.002:first_pts=0,apad=whole_dur=' + L,
            '-c:a', codec, '-f', 'wav', part];
        var child, err = '', buf = '';
        try { child = N.cp.spawn(exe, args, { windowsHide: true }); }
        catch (e) { cb('Could not start FFmpeg: ' + e.message); return; }
        job.child = child;
        job.part = part;
        child.stdout.on('data', function (d) {
            buf += String(d);
            var ls = buf.split(/\r?\n/); buf = ls.pop();
            for (var i = 0; i < ls.length; i++) {
                var m = /^out_time_(?:us|ms)=(\d+)/.exec(ls[i]);
                if (m) { var f = Math.min(1, (+m[1] / 1e6) / Math.max(0.001, len)); showProgress(0.3 + 0.62 * f, 'Extracting the Centre channel… ' + Math.floor(f * 100) + '%'); }
            }
        });
        child.stderr.on('data', function (d) { err = (err + String(d)).slice(-2000); });
        child.on('error', function (e) { cb('Could not start FFmpeg: ' + e.message); });
        child.on('close', function (code) {
            job.child = null;
            if (job.cancelled) return;
            var line = err.split(/\r?\n/).filter(Boolean).pop() || ('exit code ' + code);
            if (code !== 0) {
                try { N.fs.unlinkSync(part); } catch (e1) {}
                cb(/No space left/i.test(err) ? 'The disk is full: free some space and try again.' : 'FFmpeg could not extract the Centre channel: ' + line);
                return;
            }
            var info = null;
            try { info = wavInfo(part); } catch (e2) { info = null; }
            var want = Math.round(len * rate);
            if (!info || info.fmt.channels !== 1 || Math.abs(info.frames - want) > rate * 0.01) {
                try { N.fs.unlinkSync(part); } catch (e3) {}
                cb('The extracted file is incomplete (' + (info ? info.frames + ' of ' + want + ' samples' : 'unreadable') + '). Try again.');
                return;
            }
            try { N.fs.renameSync(part, out); } catch (e4) { cb('Could not save ' + out + ': ' + e4.message); return; }
            cb(null, { path: out, dir: dir, rate: info.fmt.rate, frames: info.frames, bits: info.fmt.bits });
        });
    }

    // ------------------------------------------------------------------ actions

    /** reads the selected clip + its file's channel layout; cb(err, src, probe, track) */
    function inspect(job, cb) {
        showLayout(null);                                   // nothing stale from an earlier clip stays on screen
        dom.verdict.textContent = '';
        host('$._dalaSuite.sfx.source(' + q({ range: S.range }) + ')', function (res) {
            if (job.cancelled) return;
            if (!res.success) { cb(res.message); return; }
            var src = res.data;
            ffmpeg(job, function (e, exe) {
                if (job.cancelled) return;
                if (e) { cb(e); return; }
                showProgress(0.3, 'Reading the channel layout of "' + src.sourceName + '"…');
                probeFile(exe, src.file, job, function (e2, probe) {
                    if (job.cancelled) return;
                    if (e2) { cb(e2); return; }
                    if (!S.last || S.last.file !== src.file) S.track = null;            // another file: back to its first track
                    S.last = { file: src.file, probe: probe };
                    var track = chooseTrack(probe);
                    showLayout(src, probe, track);
                    showTracks(probe, track);
                    cb(null, src, probe, track, exe);
                });
            });
        });
    }

    function showTracks(probe, track) {
        dom.tracks.innerHTML = '';
        dom.tracks.style.display = probe.audio.length > 1 ? '' : 'none';
        for (var i = 0; i < probe.audio.length; i++) {
            var t = probe.audio[i], b = document.createElement('button');
            b.className = 'subtab-btn' + (i === track ? ' active' : '');
            b.textContent = 'Track ' + (i + 1) + ' · ' + t.layout + (t.lang && t.lang !== 'und' ? ' · ' + t.lang : '');
            b.title = (i === 0 ? 'The track After Effects plays. ' : '') + (t.title || '') + ' ' + t.codec + ', ' + t.rate + ' Hz' + (t.suitable ? '' : ' - no Centre channel');
            b.setAttribute('data-track', String(i));
            b.addEventListener('click', function () {
                if (S.busy) return;
                S.track = +this.getAttribute('data-track');
                detect();
            });
            dom.tracks.appendChild(b);
        }
    }

    function detect() {
        if (S.busy || !nodeOk()) return;
        setBusy(true);
        S.job = { cancelled: false };
        var job = S.job;
        showProgress(0.02, 'Reading the selected clip…');
        inspect(job, function (e, src, probe, track) {
            if (job.cancelled) return;
            if (e) { if (e !== 'cancelled') finish(e, 'error'); else finish(''); return; }
            var t = probe.audio[track];
            dom.verdict.textContent = verdict(t);
            dom.verdict.className = 'at-note sx-verdict ' + (t && t.suitable ? 'ok' : 'bad');
            finish(t && t.suitable ? 'Ready: press EXTRACT CENTRE.' : '', t && t.suitable ? 'success' : 'error');
            if (!(t && t.suitable)) toast(verdict(t), 'error');
        });
    }

    function extract() {
        if (S.busy || !nodeOk()) return;
        setBusy(true);
        S.job = { cancelled: false };
        var job = S.job;
        showProgress(0.02, 'Reading the selected clip…');
        inspect(job, function (e, src, probe, track, exe) {
            if (job.cancelled) return;
            if (e) { if (e !== 'cancelled') finish(e, 'error'); else finish(''); return; }
            var t = probe.audio[track];
            dom.verdict.textContent = verdict(t);
            dom.verdict.className = 'at-note sx-verdict ' + (t && t.suitable ? 'ok' : 'bad');
            if (!t || !t.suitable) {
                var other = -1;
                for (var i = 0; i < probe.audio.length; i++) if (i !== track && probe.audio[i].suitable) { other = i; break; }
                finish(verdict(t) + (other >= 0 ? ' This file also has a ' + probe.audio[other].layout + ' track (track ' + (other + 1) + (probe.audio[other].lang ? ', ' + probe.audio[other].lang : '') + '): pick it above, then extract.' : ''), 'error');
                return;
            }
            showProgress(0.3, 'Extracting the Centre channel (' + dur(src.length) + ' of ' + t.layout + ')…');
            runExtract(exe, src, t, job, function (e2, wav) {
                if (job.cancelled) return;
                if (e2) { finish(e2, 'error'); return; }
                showProgress(0.95, 'Adding the Centre layer…');
                host('$._dalaSuite.sfx.importCentre(' + q({ compId: src.compId, layerId: src.layerId, index: src.index, name: src.name, sourceName: src.sourceName,
                    file: wav.path, offset: src.offset, spanStart: src.spanStart, spanEnd: src.spanEnd, layout: t.layout, whole: src.whole, aeAudio: src.aeAudio }) + ')', function (res) {
                    // measured in After Effects 2025: it plays no sound at all from some 5.1 files (AC-3 in MKV) and
                    // plays DD+ (E-AC3) sound from the wrong places, so the clip's own audio is no reference there
                    var hint = !src.aeAudio ? ' After Effects plays no sound from this file itself, so the Centre layer is the clip\'s only audio.'
                        : (/^eac3/i.test(t.codec) ? ' Note: After Effects does not play DD+ (E-AC3) sound in the right place, so the clip\'s own audio will not line up - the Centre layer follows the file\'s real timing, in sync with the picture.' : '');
                    finish(res.success ? res.message + hint + ' Saved as ' + wav.path + '.' : res.message + ' (The Centre file is saved as ' + wav.path + '.)', res.success ? 'success' : 'error');
                });
            });
        });
    }

    function cancel() {
        var j = S.job;
        if (!j) return;
        j.cancelled = true;
        try { if (j.dl) j.dl.cancel(); } catch (e0) {}
        try { if (j.child) j.child.kill(); } catch (e) {}
        var part = j.part;
        if (part) setTimeout(function () { try { N.fs.unlinkSync(part); } catch (e2) {} }, 1000);
        finish('Cancelled. Nothing was added to the comp.', 'info');
    }

    // ------------------------------------------------------------------ init

    function init() {
        if (!$('sx-card')) return;
        try { cs = new root.CSInterface(); } catch (e) { cs = null; }
        nodeOk();
        dom = { engine: $('sx-engine'), progress: $('sx-progress'), fill: $('sx-progress-fill'), label: $('sx-progress-label'), note: $('sx-note'),
            srcBox: $('sx-source'), srcName: $('sx-src-name'), srcInfo: $('sx-src-info'), map: $('sx-map'), verdict: $('sx-verdict'), tracks: $('sx-tracks') };
        var rb = $('sx-range').querySelectorAll('[data-range]');
        for (var i = 0; i < rb.length; i++) {
            rb[i].addEventListener('click', function () {
                if (S.busy) return;
                S.range = this.getAttribute('data-range');
                for (var j = 0; j < rb.length; j++) rb[j].classList.toggle('active', rb[j] === this);
            });
        }
        $('sx-detect').addEventListener('click', detect);
        $('sx-extract').addEventListener('click', extract);
        $('sx-cancel').addEventListener('click', cancel);
        var nav = document.querySelector('.nav-item[data-view="sfx"]');
        if (nav) nav.addEventListener('click', function () { if (!S.busy) badge(); });
        var qs = $('quick-sfx');
        if (qs) qs.addEventListener('click', function () { if (nav) nav.click(); });
        badge();
    }

    root.DalaSfxUI = { parseProbe: parseProbe, detect: detect, extract: extract, state: function () { return S; }, LAYOUTS: LAYOUTS };
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
    }
})(typeof window !== 'undefined' ? window : this);
