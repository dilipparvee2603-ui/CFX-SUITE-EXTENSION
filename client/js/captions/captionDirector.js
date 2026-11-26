/**
 * Dala Suite - caption style director (ES5, no DOM: also runs under Node for tests)
 *
 * Decides, line by line, which look of a style family (Text Preset 1 / 2) each caption gets and how its words
 * fill that look's text slots - the way an editor would place them:
 *   - it listens: every word's loudness (from the speech engine), how stretched it was spoken and the pause
 *     before it mark the words that carry the line; loud short lines and shouts become "hero" moments
 *   - it reads: questions get the question looks, shouts / commands the exclamation looks (from the sample text
 *     each look was designed with), names, numbers, ALL-CAPS and address words (sir, da, maa, bhai...) are
 *     emphasis, small words (the, to, la, ka...) never are
 *   - it composes: the emphasised word lands in the big slot of the look, the lead-in words in the small one;
 *     long lines go to the looks that hold two lines; nothing is cramped or left half empty
 *   - it varies: never the same look twice in a row, the hero look only now and then, every look gets used
 *   - "In order" mode simply loops through the looks.
 * Each slot also gets the time its words are spoken, so a kinetic look reveals each part as it is said.
 *
 *   DalaCaptionDirector.direct(captions, family, { mode: 'smart' | 'order' })
 *     captions: [{ id, s, e, lines, words: [{ w, s, e, db }] }]   family: a styles/<id>.json (profiles only needed)
 *     -> [{ id, style, tier, why, slots: [{ slot, text, lines, s, e }] }]
 */
(function (root) {
    'use strict';

    var STOP = /^(a|an|the|is|are|was|were|am|be|to|of|and|or|but|so|in|on|at|for|with|by|from|as|it|its|i|you|he|she|we|they|me|him|her|us|them|my|your|his|our|their|this|that|these|those|do|does|did|not|no|if|then|than|just|oru|la|le|nu|nnu|ah|a|um|ku|kku|ta|tha|dhaan|than|thaan|ka|ki|ke|ko|se|me|mein|hai|hain|tha|thi|aur|bhi|hi|to|na|ne|yeh|woh|ye|wo)$/i;
    var STOP_SCRIPT = /^(ஒரு|அந்த|இந்த|நான்|நீ|அது|இது|தான்|கூட|மேல|எல்லாம்|है|हैं|का|की|के|को|से|में|और|तो|भी|ही|ना|ने|यह|वह|था|थी|मैं|तुम|आप)$/;
    var ADDRESS = /^(sir|madam|da|di|dei|dey|ey|maa|ma|amma|appa|anna|akka|thambi|machan|macha|mapla|bro|boss|thalaiva|thalaivaa|bhai|yaar|ji|re|arre|beta|dude|man|guys|சார்|டா|டி|டேய்|மா|அம்மா|அண்ணா|தம்பி|மச்சான்|தலைவா|भाई|यार|जी|अरे|सर)$/i;
    var QUESTION = /^(what|why|who|whom|whose|where|when|how|which|enna|ennada|yen|yenda|yaaru|yaru|enga|engae|eppadi|eppo|epdi|ethuku|edhuku|ethana|evlo|kya|kyun|kyon|kaun|kahan|kaise|kab|kitna|kitne|என்ன|ஏன்|யாரு|யார்|எங்க|எங்கே|எப்படி|எப்போ|எப்ப|எதுக்கு|எத்தனை|எவ்வளவு|क्या|क्यों|कौन|कहाँ|कहां|कैसे|कब|कितना|कितने)[?!.,]*$/i;

    function clean(w) { return String(w).replace(/^[\s"'“”‘’(\[]+|[\s"'“”‘’)\],.;:!?।…]+$/g, ''); }
    function isLatin(s) { return /[A-Za-z]/.test(s) && !/[^\u0000-ɏ -⁯\s]/.test(s); }
    function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); var m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
    function hash(a, b) { var h = 2166136261, s = a + '|' + b; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return (h % 1000) / 1000; }

    /** A caption's words with times: its own words, or (edited text) the text spread over the caption's speech. */
    function wordsOf(c) {
        var text = (c.lines || []).join(' ').replace(/\s+/g, ' ').trim(), toks = text ? text.split(' ') : [], ws = c.words || [], i;
        if (ws.length === toks.length) {
            var same = [];
            for (i = 0; i < toks.length; i++) same.push({ w: toks[i], s: +ws[i].s, e: +ws[i].e, db: ws[i].db });
            return same;
        }
        var total = 0, out = [], t = +c.s, span = Math.max(0.2, (+c.e) - (+c.s));
        for (i = 0; i < toks.length; i++) total += toks[i].length + 1;
        for (i = 0; i < toks.length; i++) {
            var d = span * (toks[i].length + 1) / total;
            out.push({ w: toks[i], s: t, e: t + d * 0.92 });
            t += d;
        }
        return out;
    }

    // ------------------------------------------------------------------ listening + reading

    function analyse(captions) {
        var all = [], perChar = [], dbs = [], i, j;
        for (i = 0; i < captions.length; i++) {
            var ws = wordsOf(captions[i]);
            all.push(ws);
            for (j = 0; j < ws.length; j++) {
                var len = Math.max(1, clean(ws[j].w).length);
                perChar.push((ws[j].e - ws[j].s) / len);
                if (typeof ws[j].db === 'number' && isFinite(ws[j].db)) dbs.push(ws[j].db);
            }
        }
        var pc = median(perChar) || 0.07, dbMed = median(dbs), dbDev = 0;
        for (i = 0; i < dbs.length; i++) dbDev += Math.abs(dbs[i] - dbMed);
        dbDev = dbs.length ? Math.max(2, dbDev / dbs.length) : 4;
        var lines = [];
        for (i = 0; i < captions.length; i++) {
            var w = all[i], emph = [], lineDb = [];
            for (j = 0; j < w.length; j++) {
                var raw = String(w[j].w), c = clean(raw), sc = 0, len2 = Math.max(1, c.length);
                if (typeof w[j].db === 'number' && isFinite(w[j].db)) { sc += (w[j].db - dbMed) / dbDev * 0.9; lineDb.push(w[j].db); }
                var stretch = ((w[j].e - w[j].s) / len2) / pc;
                if (stretch > 1.45) sc += Math.min(1, (stretch - 1.45) * 0.8);
                if (j > 0 && w[j].s - w[j - 1].e >= 0.25) sc += 0.4;               // a pause before it: weight
                if (/!/.test(raw)) sc += 1.2;
                if (/\?/.test(raw)) sc += 0.6;
                if (isLatin(c) && c.length >= 2 && c === c.toUpperCase() && c !== c.toLowerCase()) sc += 0.6;
                if (isLatin(c) && j > 0 && /^[A-Z][a-z]/.test(c)) sc += 0.5;        // a name in the middle of a line
                if (/\d/.test(c)) sc += 0.5;
                if (ADDRESS.test(c)) sc += 0.7;
                if (STOP.test(c) || STOP_SCRIPT.test(c)) sc -= 0.9;
                else if (c.length >= 4) sc += 0.25;
                emph.push(sc);
            }
            var text = w.map(function (x) { return x.w; }).join(' ');
            var last = w.length ? clean(w[w.length - 1].w) : '';
            // "nee yaaru da?" is a question even though it ends on an address word; "VETRI KONDAAN SIR" is a shout
            var q = /\?\s*$/.test(text) || (!/!\s*$/.test(text) && w.length && (QUESTION.test(clean(w[0].w)) || QUESTION.test(last)));
            var ex = !q && (/!\s*$/.test(text) || ADDRESS.test(last));
            var loud = lineDb.length ? (median(lineDb) - dbMed) / dbDev : 0;
            var peak = Math.max.apply(null, [0].concat(emph));
            var energy = loud * 0.9 + (ex ? 0.8 : 0) + (w.length <= 3 ? 0.4 : 0) + Math.min(1.5, peak) * 0.4 - (w.length >= 7 ? 0.4 : 0);
            lines.push({ words: w, emph: emph, q: !!q, ex: !!ex, energy: energy, chars: text.length, n: w.length });
        }
        // tiers: the strongest fifth of the lines (when clearly strong) are hero moments, a very loud line always is
        var en = lines.map(function (l) { return l.energy; }).sort(function (a, b) { return b - a; });
        var heroCut = Math.min(2.2, Math.max(1.4, en[Math.max(0, Math.ceil(en.length * 0.2) - 1)] || 99));
        for (i = 0; i < lines.length; i++) lines[i].tier = lines[i].energy >= heroCut ? 2 : (lines[i].energy >= 0.45 ? 1 : 0);
        return lines;
    }

    // ------------------------------------------------------------------ composing a line into a look

    function joined(ws, a, b) { var s = [], i; for (i = a; i < b; i++) s.push(ws[i].w); return s.join(' '); }

    /** Best way to pour the line's words, in order, into the look's slots (some small slots may stay empty). */
    function splitInto(line, prof) {
        var slots = prof.slots, k = slots.length, n = line.words.length, best = null;
        var topWord = 0, i;
        for (i = 1; i < n; i++) if (line.emph[i] > line.emph[topWord]) topWord = i;
        var masks = [];
        for (var m = 1; m < (1 << k); m++) {
            var used = [], hasHero = false;
            for (i = 0; i < k; i++) if (m & (1 << i)) { used.push(i); if (slots[i].role === 'hero') hasHero = true; }
            if (!hasHero || used.length > n) continue;
            masks.push(used);
        }
        function tryCuts(used, cuts) {
            var groups = [], a = 0, sc = 0, j;
            for (j = 0; j < used.length; j++) {
                var b = j < used.length - 1 ? cuts[j] : n, sl = slots[used[j]];
                var txt = joined(line.words, a, b), len = txt.length, cap = Math.max(4, sl.chars);
                sc -= Math.abs(len - cap) / cap * 0.7;
                if (len > cap * 1.6) sc -= (len / cap - 1.6) * 2;
                if (sl.role === 'hero') {
                    if (topWord >= a && topWord < b) sc += 2;
                    if (b - a <= 3) sc += 0.4;
                } else if (b - a > 5) sc -= 1;
                if (b < n && STOP.test(clean(line.words[b - 1].w))) sc -= 0.8;     // never end a part on "the" / "to"
                if (b < n && /[,;:]$/.test(line.words[b - 1].w)) sc += 0.5;          // a natural break
                // a part that is one short word still tied to the word before ("grown / ups") looks cut off;
                // a short shout ("Sir!!", "Po!") or a word after a comma stands on its own
                if (b - a === 1 && a > 0 && n >= 3 && clean(line.words[a].w).length <= 3 &&
                    !/[!?]$/.test(line.words[a].w) && !/[,;:.!?]$/.test(line.words[a - 1].w)) sc -= 1.2;
                groups.push({ slot: used[j], a: a, b: b });
                a = b;
            }
            // empty slots look unfinished - except a small lead-in line left out of a short shout
            for (j = 0; j < k; j++) if (used.indexOf(j) < 0) sc -= (slots[j].role === 'small' && n <= 3) ? 0.6 : 1.4;
            if (!best || sc > best.score) best = { score: sc, groups: groups };
        }
        function rec(used, j, from, cuts) {
            if (j === used.length - 1) { tryCuts(used, cuts); return; }
            for (var c = from + 1; c <= n - (used.length - 1 - j); c++) { cuts.push(c); rec(used, j + 1, c, cuts); cuts.pop(); }
        }
        for (i = 0; i < masks.length; i++) rec(masks[i], 0, 0, []);
        return best;
    }

    function caseFor(text, sl) {
        if (!isLatin(text)) return text;
        if (sl.caps) return text.toUpperCase();
        if (sl.lower) return text.toLowerCase();
        return text;
    }

    /** One or two balanced lines for a slot designed with that many lines. */
    function linesFor(text, sl) {
        var ws = text.split(' ');
        if (sl.lines < 2 || ws.length < 2 || text.length < 14) return [text];
        var best = 1, bestCost = 1e9, i;
        for (i = 1; i < ws.length; i++) {
            var l1 = ws.slice(0, i).join(' ').length, l2 = ws.slice(i).join(' ').length;
            var cost = Math.abs(l1 - l2) + (STOP.test(clean(ws[i - 1])) ? 4 : 0);
            if (cost < bestCost) { bestCost = cost; best = i; }
        }
        return [ws.slice(0, best).join(' '), ws.slice(best).join(' ')];
    }

    /** 2 = the family's hero title look, 1 = a strong look (big type, punchy animation), 0 = a calm one */
    function tierOfStyle(p) { return p.hero ? 2 : (p.energy >= 2 ? 1 : 0); }

    function scoreStyle(line, st, i, hist, heroHist, use, nStyles) {
        var p = st.profile, sc = 0, why = [];
        if (line.q && p.intent === 'question') { sc += 3; why.push('question look'); }
        else if (line.ex && p.intent === 'exclaim') { sc += 3; why.push('exclamation look'); }
        else if (!line.q && !line.ex && p.intent === 'calm') sc += 1;
        else if ((line.q && p.intent === 'exclaim') || (line.ex && p.intent === 'question')) sc -= 2;
        var ts = tierOfStyle(p);
        sc -= Math.abs(ts - line.tier) * 1.5;
        if (p.hero && line.tier < 2) sc -= 3;
        if (p.hero && line.tier === 2) { sc += 2; why.push('hero moment'); }
        var cap = Math.max(6, p.chars) * 1.5, r = line.chars / cap;
        if (r > 1) sc -= (r - 1) * 2.2;
        if (line.chars < p.chars * 0.35) sc -= 1;
        var multiLine = false, j;
        for (j = 0; j < p.slots.length; j++) if (p.slots[j].lines > 1) multiLine = true;
        if (line.chars > 22 && !multiLine && p.slots.length === 1) sc -= 1.5;
        if (multiLine && line.chars < 12) sc -= 1;
        var split = splitInto(line, p);
        if (!split) return null;
        sc += split.score * 0.6;
        if (hist.length && hist[hist.length - 1] === st.id) sc -= 5;
        for (j = Math.max(0, hist.length - 3); j < hist.length - 1; j++) if (hist[j] === st.id) sc -= 1.5;
        var fair = (hist.length + 1) / nStyles, extra = (use[st.id] || 0) - fair;
        if (extra > 0) sc -= extra * 0.8;
        // the hero look stays special: not again within the next 4 lines
        if (p.hero) for (j = Math.max(0, heroHist.length - 4); j < heroHist.length; j++) if (heroHist[j]) sc -= 3;
        sc += hash(i, st.id) * 0.25;                       // a stable tie-break: the same transcript always comes out the same
        return { score: sc, split: split, why: why };
    }

    function direct(captions, family, options) {
        var o = options || {}, styles = family.styles || [], lines = analyse(captions), out = [], hist = [], heroHist = [], use = {}, i, k;
        for (i = 0; i < lines.length; i++) {
            var line = lines[i], pick = null, pickSt = null;
            if (o.mode === 'order') {
                pickSt = styles[i % styles.length];
                pick = { split: splitInto(line, pickSt.profile), why: ['in order'] };
            } else {
                for (k = 0; k < styles.length; k++) {
                    var r = scoreStyle(line, styles[k], i, hist, heroHist, use, styles.length);
                    if (r && (!pick || r.score > pick.score)) { pick = r; pickSt = styles[k]; }
                }
            }
            if (!pick || !pick.split) { pickSt = styles[0]; pick = { split: splitInto(line, pickSt.profile), why: ['fallback'] }; }
            hist.push(pickSt.id);
            heroHist.push(!!pickSt.profile.hero);
            use[pickSt.id] = (use[pickSt.id] || 0) + 1;
            var slots = [], g;
            for (g = 0; g < pick.split.groups.length; g++) {
                var grp = pick.split.groups[g], sl = pickSt.profile.slots[grp.slot];
                var text = caseFor(joined(line.words, grp.a, grp.b), sl);
                slots.push({ slot: grp.slot, text: text, lines: linesFor(text, sl), s: line.words[grp.a].s, e: line.words[grp.b - 1].e });
            }
            out.push({ id: captions[i].id, style: pickSt.id, tier: line.tier, why: pick.why.join(', '), slots: slots });
        }
        return out;
    }

    var api = { direct: direct, analyse: analyse, splitInto: splitInto, wordsOf: wordsOf };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.CFXCaptionDirector = root.DalaCaptionDirector = api;
})(typeof window !== 'undefined' ? window : this);
