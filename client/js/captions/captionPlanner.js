/**
 * Dala Suite - Auto Captions planner (ES5, no DOM: also runs under Node for tests)
 *
 * Turns timed caption words (Whisper / translation output) into caption groups:
 *   words -> cleaned words (pieces joined, optional upper case)
 *         -> phrases (cut at real pauses and sentence ends)
 *         -> captions (a phrase too long for one caption is cut where the pieces come out balanced,
 *            preferring clause ends, never ending on "the" / "a" / "to" or leaving a lone word behind)
 *         -> 1 or 2 balanced lines per caption
 *         -> each caption's speech span: s = its first word's start, e = its last word's end
 * The host builds one text layer per caption from the speech spans: a layer runs from its speech start
 * to the next caption's speech start (see host/captions.jsx). Times are seconds from the start of the
 * rendered audio; the host adds the comp offset.
 */
(function (root) {
    'use strict';

    var DEFAULTS = {
        maxCharsPerLine: 24,   // room for a whole spoken phrase (long Tanglish / Hinglish words) on two lines
        maxLines: 2,
        maxWords: 7,
        singleLineMax: 18,     // a caption this short stays on one line
        maxDuration: 3.6,      // seconds of speech a single caption may cover
        gapBreak: 0.55,        // a pause this long always starts a new caption
        capsBreak: false,      // a capitalised word starts a new sentence (Whisper's English drops full stops)
        uppercase: true,
        punctuation: 'keep'    // keep | none (drop . , ! ? and quotes)
    };

    var SENTENCE_END = /[.!?…।]["'”’)\]]*$/;
    var CLAUSE_END = /[,;:—–]["'”’)\]]*$/;
    var WEAK_LINE_END = /^(a|an|the|to|of|and|or|but|in|on|at|for|with|my|your|his|her|our|their|its|is|i|we|you|he|she|they|it|this|that|so|if|as|by|from)$/i;
    var FILLERS = /^(and|so|but|um|uh|like|well|okay|ok|yeah|oh|now|then|just)$/i;

    function merge(a, b) {
        var o = {}, k;
        for (k in a) if (a.hasOwnProperty(k)) o[k] = a[k];
        if (b) for (k in b) if (b.hasOwnProperty(k) && b[k] !== undefined && b[k] !== null) o[k] = b[k];
        return o;
    }

    // ------------------------------------------------------------------ words
    function cleanWords(raw, o) {
        var out = [], i;
        for (i = 0; i < raw.length; i++) {
            var r = raw[i];
            if (!r || typeof r.w !== 'string') continue;
            var w = r.w.replace(/\s+/g, ' ').trim();
            if (!w) continue;
            var s = +r.s, e = +r.e;
            if (!(e >= s)) e = s;
            var db = (typeof r.db === 'number' && isFinite(r.db)) ? r.db : undefined;   // loudness (speech engine)
            if (out.length && (r.j || /^[.,!?;:'’%)\]।]/.test(w))) {   // a piece of the previous word
                var p = out[out.length - 1];
                p.w += w; p.e = Math.max(p.e, e);
                if (db !== undefined) p.db = (p.db === undefined) ? db : Math.max(p.db, db);
                continue;
            }
            out.push({ w: w, s: s, e: e, db: db });
        }
        for (i = 0; i < out.length; i++) {
            var x = out[i];
            x.orig = x.w;
            var t = x.w;
            if (o.punctuation === 'none') t = t.replace(/[.,!?;:…"“”।]/g, '');
            if (o.uppercase) t = t.toUpperCase();      // no effect on Tamil / Devanagari script
            x.w = t || x.w;
        }
        return out;
    }

    function plainWord(w) { return w.orig.replace(/[^A-Za-z']/g, ''); }

    function joinedLength(ws, a, b) {
        var n = 0, i;
        for (i = a; i < b; i++) n += ws[i].w.length + (i > a ? 1 : 0);
        return n;
    }

    /** Best split of words into lines: [] of arrays of words. */
    function splitLines(ws, o) {
        var n = ws.length, total = joinedLength(ws, 0, n);
        if (n < 2 || o.maxLines < 2 || (total <= o.singleLineMax) || n === 2 && total <= o.maxCharsPerLine) return [ws.slice()];
        var best = -1, bestCost = 1e9, b;
        for (b = 1; b < n; b++) {
            var l1 = joinedLength(ws, 0, b), l2 = joinedLength(ws, b, n);
            var cost = Math.max(l1, l2);
            if (l1 > o.maxCharsPerLine || l2 > o.maxCharsPerLine) cost += 100;
            if (WEAK_LINE_END.test(plainWord(ws[b - 1]))) cost += 4;
            if (CLAUSE_END.test(ws[b - 1].orig) || SENTENCE_END.test(ws[b - 1].orig)) cost -= 3;
            if (l2 > l1 + 6) cost += 2;
            if (cost < bestCost) { bestCost = cost; best = b; }
        }
        return [ws.slice(0, best), ws.slice(best)];
    }

    function fits(ws, o) {
        if (ws.length > o.maxWords) return false;
        if (joinedLength(ws, 0, ws.length) > o.maxCharsPerLine * o.maxLines) return false;
        if (ws.length && ws[ws.length - 1].e - ws[0].s > o.maxDuration) return false;
        var lines = splitLines(ws, o), i;
        for (i = 0; i < lines.length; i++) if (joinedLength(lines[i], 0, lines[i].length) > o.maxCharsPerLine && lines[i].length > 1) return false;
        return true;
    }

    /** Phrases: words cut at real pauses and sentence ends (a caption never spans one of those). */
    function phrasesOf(ws, o) {
        var out = [], cur = [], i;
        for (i = 0; i < ws.length; i++) {
            if (cur.length) {
                var last = cur[cur.length - 1], gap = ws[i].s - last.e;
                if (gap >= o.gapBreak || SENTENCE_END.test(last.orig) || (CLAUSE_END.test(last.orig) && gap >= 0.3) ||
                    (o.capsBreak && /^[A-Z]/.test(ws[i].orig) && !/^I(\W|$)/.test(ws[i].orig))) {
                    out.push(cur);
                    cur = [];
                }
            }
            cur.push(ws[i]);
        }
        if (cur.length) out.push(cur);
        return out;
    }

    /** Cost of making ph[a..b) one caption: fewer, evenly filled captions that end on a clause win; a lone
     *  short word or a flash shorter than 0.6 s loses. */
    function captionCost(ph, a, b, o) {
        var g = ph.slice(a, b), len = joinedLength(g, 0, g.length), cap = o.maxCharsPerLine * o.maxLines;
        var cost = 10 + 6 * Math.pow(1 - Math.min(1, len / cap), 2);
        if (g.length === 1 && len <= 12) cost += 4;
        if (g[g.length - 1].e - g[0].s < 0.6) cost += 3;
        if (b < ph.length) {
            var endW = g[g.length - 1];
            if (CLAUSE_END.test(endW.orig)) cost -= 3;
            if (WEAK_LINE_END.test(plainWord(endW))) cost += 4;
            if (FILLERS.test(plainWord(ph[b]))) cost -= 1;
        }
        return cost;
    }

    /** A phrase too long for one caption, cut where the total cost is lowest (balanced, no orphan words). */
    function splitPhrase(ph, o) {
        var n = ph.length, best = [0], from = [0], i, j;
        if (fits(ph, o)) return [ph];
        for (i = 1; i <= n; i++) {
            best[i] = 1e18;
            for (j = i - 1; j >= 0; j--) {
                if (i - j > 1 && !fits(ph.slice(j, i), o)) break;    // longer spans will not fit either
                var c = best[j] + captionCost(ph, j, i, o);
                if (c < best[i]) { best[i] = c; from[i] = j; }
            }
        }
        var cuts = [];
        for (i = n; i > 0; i = from[i]) cuts.unshift(ph.slice(from[i], i));
        return cuts;
    }

    function group(ws, o) {
        var groups = [], ph = phrasesOf(ws, o), i;
        for (i = 0; i < ph.length; i++) groups = groups.concat(splitPhrase(ph[i], o));
        // a lone short word that trails a caption without a pause joins it when it fits
        var out = [];
        for (i = 0; i < groups.length; i++) {
            var g = groups[i], prev = out.length ? out[out.length - 1] : null;
            if (prev && g.length === 1 && g[0].w.length <= 5 &&
                g[0].s - prev[prev.length - 1].e < o.gapBreak * 0.6 &&
                !SENTENCE_END.test(prev[prev.length - 1].orig) && fits(prev.concat(g), o)) {
                out[out.length - 1] = prev.concat(g);
            } else {
                out.push(g);
            }
        }
        return out;
    }

    function lineText(line) { return line.map(function (w) { return w.w; }).join(' '); }

    // ------------------------------------------------------------------ public
    function plan(rawWords, options) {
        var o = merge(DEFAULTS, options);
        var ws = cleanWords(rawWords || [], o);
        var groups = group(ws, o), out = [], i;
        for (i = 0; i < groups.length; i++) {
            var g = groups[i];
            out.push({
                id: (i + 1 < 10 ? '0' : '') + (i + 1),
                s: Math.round(g[0].s * 1000) / 1000,
                e: Math.round(g[g.length - 1].e * 1000) / 1000,
                lines: splitLines(g, o).map(lineText),
                // each word's time and loudness: the style director (captionDirector.js) reads them
                words: g.map(function (w) { var x = { w: w.w, s: Math.round(w.s * 1000) / 1000, e: Math.round(w.e * 1000) / 1000 }; if (w.db !== undefined) x.db = Math.round(w.db * 10) / 10; return x; })
            });
        }
        return { captions: out, words: ws.length, options: o };
    }

    /** Re-splits a caption text the user edited into 1-2 lines (same rules). */
    function relineText(text, options) {
        var o = merge(DEFAULTS, options);
        var ws = String(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).map(function (t) { return { w: t, orig: t, s: 0, e: 0 }; });
        if (!ws.length) return [];
        return splitLines(ws, o).map(lineText);
    }

    // ------------------------------------------------------------------ edited captions

    var WORD_TIME = 0.32;      // seconds a word the user added takes when there is room for it
    var MIN_WORD_TIME = 0.12;  // less room than this per added word: it shares its neighbours' time instead

    function plainKey(w) { return String(w).toLowerCase().replace(/[.,!?;:…"“”'’()\[\]।-]/g, ''); }

    /** Pairs the edited words with the recognised ones (edit distance: a word kept costs 0, a word rewritten in
     *  place 1.2, one added or removed 1; pairs off the diagonal cost a little more, so a rewritten text keeps its
     *  place in the speech). Returns, for each edited word, the index of its recognised word or -1. */
    function alignWords(E, R) {
        var m = E.length, n = R.length, i, j, D = [], B = [];
        var ek = E.map(plainKey), rk = R.map(function (r) { return plainKey(r.w); });
        for (i = 0; i <= m; i++) { D.push(new Float64Array(n + 1)); B.push(new Uint8Array(n + 1)); }
        for (i = 1; i <= m; i++) { D[i][0] = i; B[i][0] = 1; }
        for (j = 1; j <= n; j++) { D[0][j] = j; B[0][j] = 2; }
        for (i = 1; i <= m; i++) {
            for (j = 1; j <= n; j++) {
                var off = Math.abs(i / m - j / n);
                var d = D[i - 1][j - 1] + (ek[i - 1] === rk[j - 1] ? 0.1 * off : 1.2 + 0.8 * off), how = 0;
                if (D[i - 1][j] + 1 < d) { d = D[i - 1][j] + 1; how = 1; }     // an added word
                if (D[i][j - 1] + 1 < d) { d = D[i][j - 1] + 1; how = 2; }     // a removed word
                D[i][j] = d; B[i][j] = how;
            }
        }
        var map = [];
        for (i = m, j = n; i > 0 || j > 0;) {
            var h = (i > 0 && j > 0) ? B[i][j] : (i > 0 ? 1 : 2);
            if (h === 0) { map[i - 1] = j - 1; i--; j--; } else if (h === 1) { map[i - 1] = -1; i--; } else j--;
        }
        return map;
    }

    /** Times for the edited words: a kept or rewritten word keeps its recognised time; added words follow the
     *  word before them (or lead into the word after), sharing their neighbours' time when the speech gives
     *  them no room. total: length of the audio (seconds). */
    function timeWords(E, R, map, total) {
        var m = E.length, t = [], i, j, k;
        for (i = 0; i < m; i++) t[i] = map[i] >= 0 ? { s: R[map[i]].s, e: R[map[i]].e, db: R[map[i]].db } : null;
        function spread(from, to, a, b) {          // words [from, to) over [a, b] by their length
            var len = 0, acc = 0;
            for (k = from; k < to; k++) len += E[k].length + 1;
            for (k = from; k < to; k++) {
                var s = a + (b - a) * acc / len;
                acc += E[k].length + 1;
                t[k] = { s: s, e: a + (b - a) * acc / len, db: t[k] && t[k].db };
            }
        }
        if (!R.length || map.every(function (x) { return x < 0; })) {
            var a0 = R.length ? R[0].s : 0, b0 = R.length ? R[R.length - 1].e : Math.min(total || 1e9, m * WORD_TIME);
            spread(0, m, a0, Math.max(b0, a0 + m * MIN_WORD_TIME));
            return t;
        }
        for (i = 0; i < m;) {
            if (t[i]) { i++; continue; }
            for (j = i; j < m && !t[j]; j++) {}
            var cnt = j - i, L = i > 0 ? t[i - 1] : null, Rt = j < m ? t[j] : null, need = cnt * WORD_TIME;
            if (L && Rt) {
                if (Rt.s - L.e >= cnt * MIN_WORD_TIME) spread(i, j, L.e, Math.min(Rt.s, L.e + need));
                else spread(i - 1, j + 1, L.s, Math.max(Rt.e, L.s + (cnt + 2) * MIN_WORD_TIME));   // no gap: share
            } else if (Rt) {
                if (Rt.s >= cnt * MIN_WORD_TIME) spread(i, j, Math.max(0, Rt.s - need), Rt.s);
                else spread(i, j + 1, 0, Math.max(Rt.e, (cnt + 1) * MIN_WORD_TIME));
            } else {
                var end = total ? Math.min(total, L.e + need) : L.e + need;
                if (end - L.e >= cnt * MIN_WORD_TIME) spread(i, j, L.e, end);
                else spread(i - 1, j, L.s, Math.max(end, L.s + (cnt + 1) * MIN_WORD_TIME));
            }
            i = j;
        }
        return t;
    }

    /** Captions from the text box as the user left it: one caption per non-empty line, any number of lines and
     *  words. The words are matched with the recognised ones (plan.captions[].words), so every line keeps the
     *  time it is spoken - lines split, joined, rewritten or added all land where they belong.
     *  options: { total: audio length in seconds } plus the line rules (maxCharsPerLine...). */
    function fromText(text, planned, options) {
        var o = merge(DEFAULTS, options), R = [], i, j;
        (planned && planned.captions || []).forEach(function (c) { (c.words || []).forEach(function (w) { R.push(w); }); });
        var rows = String(text || '').replace(/\r/g, '').split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
        var E = [], lineOf = [];
        for (i = 0; i < rows.length; i++) rows[i].split(' ').forEach(function (w) { E.push(w); lineOf.push(i); });
        if (!E.length) return [];
        var map = alignWords(E, R), t = timeWords(E, R, map, o.total);
        // the recognised words each line kept: first / last index (a line of new words has none)
        var first = [], last = [];
        for (j = 0; j < E.length; j++) if (map[j] >= 0) {
            var li = lineOf[j];
            if (first[li] === undefined) first[li] = map[j];
            last[li] = map[j];
        }
        var out = [], fd = 1 / 30, prevLast = -1;
        for (i = 0; i < rows.length; i++) {
            var ws = [];
            for (j = 0; j < E.length; j++) if (lineOf[j] === i) ws.push({ w: E[j], orig: E[j], s: t[j].s, e: t[j].e, db: t[j].db });
            var s = ws[0].s, e = ws[ws.length - 1].e;
            if (first[i] !== undefined) {
                // spoken words the user removed at the line's edges still belong to its phrase (no pause between):
                // the caption keeps the phrase's time
                var r0 = first[i], r1 = last[i], nextFirst = R.length, q;
                for (q = i + 1; q < rows.length; q++) if (first[q] !== undefined) { nextFirst = first[q]; break; }
                while (r0 - 1 > prevLast && R[r0].s - R[r0 - 1].e < 0.3) r0--;
                while (r1 + 1 < nextFirst && R[r1 + 1].s - R[r1].e < 0.3) r1++;
                s = Math.min(s, R[r0].s);
                e = Math.max(e, R[r1].e);
                prevLast = r1;
            }
            // every caption starts after the one before it and lasts long enough to read
            if (out.length && s < out[out.length - 1].s + fd * 3) s = out[out.length - 1].s + fd * 3;
            if (e < s + 0.2) e = s + 0.2;
            out.push({
                id: (i + 1 < 10 ? '0' : '') + (i + 1),
                s: Math.round(s * 1000) / 1000,
                e: Math.round(e * 1000) / 1000,
                lines: splitLines(ws, o).map(lineText),
                words: ws.map(function (w) { var x = { w: w.w, s: Math.round(w.s * 1000) / 1000, e: Math.round(w.e * 1000) / 1000 }; if (w.db !== undefined) x.db = w.db; return x; })
            });
        }
        return out;
    }

    var api = { plan: plan, relineText: relineText, fromText: fromText, DEFAULTS: DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.CFXCaptionPlanner = root.DalaCaptionPlanner = api;
})(typeof window !== 'undefined' ? window : this);
