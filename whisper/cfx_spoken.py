"""Dala Suite - captions in the Tamil and Hindi people actually speak (films, reels, everyday talk).

Whisper and the NLLB translator write Tamil the way it is printed (senthamizh: "போகிறேன்", "வந்துவிட்டான்",
"நீங்கள்") and Hindi in its formal, Sanskritised register (shuddh: "परंतु", "केवल", "जीवन"). Film dialogue is
spoken Tamil ("போறேன்", "வந்துட்டான்", "நீங்க") and everyday Hindustani ("लेकिन", "सिर्फ़", "ज़िंदगी").
These rules turn the written forms into the spoken ones, word by word (so every word keeps its timing):

  Tamil  - after the correspondence between formal writing and informal speech taught in the University of
           Chicago Tamil course (tamilcourse.uchicago.edu, "Spelling correspondence between informal speech and
           formal writing"), applied in reverse: present tense (-கிறேன் -> -றேன், இருக்கிறது -> இருக்கு),
           completive (-விட்டான் -> -ட்டான்), negative (-வில்லை -> -ல), pronoun and verb plurals (-ர்கள் /
           -ங்கள் -> -ங்க), case endings (-இல் -> -உல, -இடம் -> -கிட்ட, -உடைய -> -ஓட, -இலிருந்து -> -உலருந்து),
           the quotative (என்று -> -ன்னு, joined to the word before), conditionals (-ஆல் -> -ஆ), adverbs (-ஆக
           -> -ஆ), palatalised / simplified stems (தெரிந்து -> தெரிஞ்சு, படித்து -> படிச்சு, பார்த்து -> பாத்து)
           and everyday words (மிகவும் -> ரொம்ப, சிறிது -> கொஞ்சம், எதற்கு -> எதுக்கு).
  Hindi  - formal words swapped for the ones films and conversation use (परंतु / किंतु -> लेकिन, केवल ->
           सिर्फ़, जीवन -> ज़िंदगी, सहायता -> मदद, आवश्यक -> ज़रूरी, धन्यवाद -> शुक्रिया ...).

A word the rules do not know is left exactly as it is: the rules only change endings and words that are
unambiguous, so a name or an English word in Tamil script is never touched.

    import dala_spoken; dala_spoken.tamil_words(words) / dala_spoken.tamil_text(s) / dala_spoken.hindi_text(s)
"""
import re

# ------------------------------------------------------------------ Tamil

# whole words (punctuation around them is kept)
TA_WORDS = {
    u"நீங்கள்": u"நீங்க", u"நாங்கள்": u"நாங்க", u"அவர்கள்": u"அவங்க", u"இவர்கள்": u"இவங்க",
    u"எவர்கள்": u"எவங்க", u"உங்கள்": u"உங்க", u"எங்கள்": u"எங்க", u"நம்முடைய": u"நம்மோட", u"நம்": u"நம்ம",
    u"இல்லை": u"இல்ல", u"வேண்டும்": u"வேணும்", u"வேண்டாம்": u"வேணாம்",
    u"எங்கே": u"எங்க", u"இங்கே": u"இங்க", u"அங்கே": u"அங்க",
    u"எப்போது": u"எப்போ", u"இப்போது": u"இப்போ", u"அப்போது": u"அப்போ",
    u"ஒன்று": u"ஒண்ணு", u"ஒன்றும்": u"ஒண்ணும்", u"இரண்டு": u"ரெண்டு", u"மூன்று": u"மூணு", u"நான்கு": u"நாலு",
    u"ஐந்து": u"அஞ்சு", u"ஒன்பது": u"ஒம்பது", u"ஏதாவது": u"ஏதாச்சும்", u"எல்லோரும்": u"எல்லாரும்",
    u"எதற்கு": u"எதுக்கு", u"அதற்கு": u"அதுக்கு", u"இதற்கு": u"இதுக்கு", u"எதற்காக": u"எதுக்காக",
    u"அதனால்": u"அதனால", u"இதனால்": u"இதனால", u"எதனால்": u"எதனால", u"ஆனால்": u"ஆனா",
    u"மிகவும்": u"ரொம்ப", u"சிறிது": u"கொஞ்சம்", u"நன்றாக": u"நல்லா", u"நன்றாகவே": u"நல்லாவே",
    u"அவளிடம்": u"அவகிட்ட", u"என்னிடம்": u"என்கிட்ட", u"உன்னிடம்": u"உன்கிட்ட", u"நம்மிடம்": u"நம்மகிட்ட",
    u"செய்": u"பண்ணு", u"செய்கிறேன்": u"பண்றேன்", u"செய்கிறாய்": u"பண்ற", u"செய்கிறான்": u"பண்றான்",
    u"செய்கிறாள்": u"பண்றா", u"செய்கிறார்": u"பண்றாரு", u"செய்கிறது": u"பண்ணுது", u"செய்கிறீர்கள்": u"பண்றீங்க",
    u"செய்து": u"செஞ்சு", u"செய்த": u"செஞ்ச", u"செய்தேன்": u"செஞ்சேன்", u"செய்தான்": u"செஞ்சான்",
    u"செய்தாள்": u"செஞ்சா", u"செய்தார்": u"செஞ்சாரு", u"செய்தது": u"செஞ்சது", u"செய்தாய்": u"செஞ்ச",
    u"வாருங்கள்": u"வாங்க", u"சாப்பிட்டாயா": u"சாப்டியா", u"சாப்பிட்டேன்": u"சாப்டேன்",
    u"வந்தது": u"வந்துச்சு", u"இருந்தது": u"இருந்துச்சு", u"போனது": u"போச்சு", u"ஆனது": u"ஆச்சு",
    u"முடிந்தது": u"முடிஞ்சுது", u"தெரிந்தது": u"தெரிஞ்சுது", u"புரிந்தது": u"புரிஞ்சுது",
}

# endings, tried in order (longest / most specific first); each is (written ending, spoken ending)
TA_ENDINGS = [
    # "be" in the present: இருக்கிறான் -> இருக்கான்
    (u"ருக்கிறார்கள்", u"ருக்காங்க"), (u"ருக்கிறீர்கள்", u"ருக்கீங்க"), (u"ருக்கிறேன்", u"ருக்கேன்"),
    (u"ருக்கிறாய்", u"ருக்க"), (u"ருக்கிறான்", u"ருக்கான்"), (u"ருக்கிறாள்", u"ருக்கா"), (u"ருக்கிறார்", u"ருக்காரு"),
    (u"ருக்கிறோம்", u"ருக்கோம்"), (u"ருக்கிறது", u"ருக்கு"),
    # strong verbs (-க்கிற-): பார்க்கிறேன் -> பார்க்குறேன் (then பார் -> பா below)
    (u"க்கிறார்கள்", u"க்குறாங்க"), (u"க்கிறீர்கள்", u"க்குறீங்க"), (u"க்கிறேன்", u"க்குறேன்"), (u"க்கிறாய்", u"க்குற"),
    (u"க்கிறான்", u"க்குறான்"), (u"க்கிறாள்", u"க்குறா"), (u"க்கிறார்", u"க்குறாரு"), (u"க்கிறோம்", u"க்குறோம்"),
    (u"க்கிறது", u"க்குது"), (u"க்கின்றன", u"க்குது"), (u"க்கிற", u"க்குற"),
    # வருகிறேன் -> வர்றேன் (வரு- + -கிற- becomes வர்ற-)
    (u"ருகிறார்கள்", u"ர்றாங்க"), (u"ருகிறீர்கள்", u"ர்றீங்க"), (u"ருகிறேன்", u"ர்றேன்"), (u"ருகிறாய்", u"ர்ற"),
    (u"ருகிறான்", u"ர்றான்"), (u"ருகிறாள்", u"ர்றா"), (u"ருகிறார்", u"ர்றாரு"), (u"ருகிறோம்", u"ர்றோம்"),
    (u"ருகிறது", u"ருது"),
    # weak verbs (-கிற-): போகிறேன் -> போறேன், சொல்கிறேன் -> சொல்றேன்
    (u"கிறார்கள்", u"றாங்க"), (u"கிறீர்கள்", u"றீங்க"), (u"கிறேன்", u"றேன்"), (u"கிறாய்", u"ற"), (u"கிறான்", u"றான்"),
    (u"கிறாள்", u"றா"), (u"கிறார்", u"றாரு"), (u"கிறோம்", u"றோம்"), (u"கிறது", u"குது"), (u"கின்றன", u"குது"),
    (u"கின்றேன்", u"றேன்"), (u"கின்றான்", u"றான்"),
    # completive: வந்துவிட்டான் -> வந்துட்டான், போய்விட்டான் -> போயிட்டான், வந்துவிடு -> வந்துடு
    (u"ய்விட்டார்கள்", u"யிட்டாங்க"), (u"ுவிட்டார்கள்", u"ுட்டாங்க"),
    (u"ய்விட்ட", u"யிட்ட"), (u"ுவிட்ட", u"ுட்ட"), (u"ய்விடு", u"யிடு"), (u"ுவிடு", u"ுடு"),
    (u"ய்விட்டேன்", u"யிட்டேன்"), (u"ுவிட்டேன்", u"ுட்டேன்"), (u"ய்விட்டான்", u"யிட்டான்"), (u"ுவிட்டான்", u"ுட்டான்"),
    (u"ுவிட்டாள்", u"ுட்டா"), (u"ுவிட்டார்", u"ுட்டாரு"), (u"ுவிட்டது", u"ுடுச்சு"), (u"ய்விட்டது", u"யிடுச்சு"),
    # negative: வரவில்லை -> வரல, தெரியவில்லை -> தெரியல
    (u"வில்லை", u"ல"),
    # plurals of persons and verbs: வந்தார்கள் -> வந்தாங்க, போங்கள் -> போங்க
    (u"ார்கள்", u"ாங்க"), (u"ீர்கள்", u"ீங்க"), (u"ங்கள்", u"ங்க"),
    # must / mustn't: வரவேண்டும் -> வரணும்
    (u"வேண்டும்", u"ணும்"), (u"வேண்டாம்", u"வேணாம்"),
    # whose / to whom: என்னுடைய -> என்னோட, அவனிடம் -> அவன்கிட்ட, அப்பாவிடம் -> அப்பாகிட்ட
    (u"ுடைய", u"ோட"), (u"னிடம்", u"ன்கிட்ட"), (u"ரிடம்", u"ர்கிட்ட"), (u"ாவிடம்", u"ாகிட்ட"),
    # from (place): வீட்டிலிருந்து -> வீட்டுலருந்து
    (u"ிலிருந்து", u"ுலருந்து"),
]
# in (place): வீட்டில் -> வீட்டுல, மண்ணில் -> மண்ணுல, ஊரில் -> ஊருல - only after these consonants, so
# கோயில் / மயில் / தமிழில் keep their spelling
TA_LOCATIVE = re.compile(u"(ட்ட|ண்ண|ன்ன|க்க|த்த|ப்ப|ற்ற|ல்ல|ள்ள|ம்ம|ர|ட|ண|ன|ல|ள)ில(்|தான்|ே|ும்)$")
# what follows the த of a past stem in a verb form: -து, -த, -தேன், -தான், -தது, -துட்டான் ...
TA_VERB_REST = u"(ு|ேன்|ான்|ாள்|ார்|ாரு|ாய்|ோம்|ீங்க|ாங்க|து|ுட்டேன்|ுட்டான்|ுட்டா|ுட்டாங்க|)$"
TA_STEMS = [
    # palatalised and simplified stems people say: தெரிந்து -> தெரிஞ்சு, படித்து -> படிச்சு, பார்த்து -> பாத்து.
    # Only on verb endings, so சிந்தனை / சித்தப்பா / பார்த்திபன் keep their spelling.
    (re.compile(u"ிந்த" + TA_VERB_REST), u"ிஞ்ச\\1"), (re.compile(u"ித்த" + TA_VERB_REST), u"ிச்ச\\1"),
    (re.compile(u"ைத்த" + TA_VERB_REST), u"ைச்ச\\1"), (re.compile(u"^பார்த்த" + TA_VERB_REST), u"பாத்த\\1"),
    (re.compile(u"^பார்க்க(ணும்|லாம்|ல|)$"), u"பாக்க\\1"),
    (re.compile(u"^பார்க்கு(றேன்|ற|றான்|றா|றாரு|றோம்|றீங்க|றாங்க|து|ம்)$"), u"பாக்கு\\1"),
    (re.compile(u"^சாப்பிட்(டேன்|டான்|டா|டாள்|டாரு|டோம்|டீங்க|டாங்க|டியா|டு|ட)$"), u"சாப்ட்\\1"),
]
# continuous aspect: பார்த்துக்கொண்டு -> பார்த்துக்கிட்டு (before the compound split below)
TA_ASPECT = [(re.compile(u"க்கொண்டிரு"), u"க்கிட்டிரு"), (re.compile(u"க்கொண்டு$"), u"க்கிட்டு")]
# a verb + a helper verb in one word (முடிந்து+டுச்சு, பார்த்து+க்கிட்டு): the stem rules apply to the first part
TA_COMPOUND = re.compile(u"^(.+ு)(டுச்சு|ட்டான்|ட்டேன்|ட்டா|ட்டாரு|ட்டாங்க|ட்டோம்|டு|க்கிட்டு|க்கிட்டிரு.*)$")
# -ஆல் (if): only after a verb stem (வந்தால், சொன்னால், போனால்), never names like கோபால் / விஷால்
TA_IF = re.compile(u"(ந்த|ன்ன|ட்ட|த்த|ச்ச|ய்த|ன|ண்ட|ற்ற|ல்ல|க்க|ப்ப)ால்$")
TA_PUNCT = re.compile(u"^([\"'“”‘’(\\[]*)(.*?)([\"'“”‘’)\\],.;:!?।…]*)$")
TA_SCRIPT = re.compile(u"[஀-௿]")


def _ta_word(core):
    if core in TA_WORDS:
        return TA_WORDS[core]
    w = core
    for a, b in TA_ENDINGS:
        if w.endswith(a) and len(w) > len(a):
            w = w[:-len(a)] + b
            break
    m = TA_LOCATIVE.search(w)
    if m and len(w) >= 4:
        tail = {u"்": u"ுல", u"தான்": u"ுலதான்", u"ே": u"ுல", u"ும்": u"ுலயும்"}[m.group(2)]
        w = w[:m.start(2) - 2] + tail                  # (drops the ி and the ல the match ends on)
    if w == u"ஆக" or len(w) < 4:
        return w
    for rx, rep in TA_ASPECT:
        w = rx.sub(rep, w)
    c = TA_COMPOUND.match(w)
    head, aux = (c.group(1), c.group(2)) if c else (w, u"")
    for rx, rep in TA_STEMS:
        head = rx.sub(rep, head)
    w = head + aux
    if w.endswith(u"ாக") and len(w) >= 5:          # வேகமாக -> வேகமா
        w = w[:-1]
    if TA_IF.search(w):                             # வந்தால் -> வந்தா
        w = w[:-2]
    return w


def tamil_token(tok):
    """One written word -> the spoken form (punctuation kept)."""
    if not TA_SCRIPT.search(tok):
        return tok
    m = TA_PUNCT.match(tok)
    pre, core, post = m.group(1), m.group(2), m.group(3)
    return pre + _ta_word(core) + post


def tamil_words(words):
    """[{w, s, e, ...}] -> the same words in spoken Tamil; the quotative என்று / என்றால் is joined to the word
    before it (அவன் வருவான் என்று -> அவன் வருவான்னு) and takes over that word's end time."""
    out = []
    for w in words:
        tok = w["w"]
        m = TA_PUNCT.match(tok)
        core = m.group(2)
        if core in (u"என்று", u"என்றால்", u"என்கிறான்", u"என்றான்") and out and TA_SCRIPT.search(out[-1]["w"]):
            q = {u"என்று": u"னு", u"என்றால்": u"னா", u"என்கிறான்": u"ங்கறான்", u"என்றான்": u"னான்"}[core]
            prev = out[-1]
            pm = TA_PUNCT.match(prev["w"])
            base = pm.group(2)
            joined = base + (q if base.endswith(u"்") else u"ன்" + q if q.startswith(u"ன") else q)
            prev["w"] = pm.group(1) + joined + m.group(3)
            prev["e"] = max(prev["e"], w["e"])
            continue
        nw = dict(w)
        nw["w"] = tamil_token(tok)
        out.append(nw)
    return out


def tamil_text(s):
    words = [{"w": t, "s": 0, "e": 0} for t in s.split()]
    return " ".join(w["w"] for w in tamil_words(words))


# ------------------------------------------------------------------ Hindi

HI_WORDS = {
    u"परंतु": u"लेकिन", u"परन्तु": u"लेकिन", u"किंतु": u"लेकिन", u"किन्तु": u"लेकिन", u"केवल": u"सिर्फ़",
    u"अत्यंत": u"बहुत", u"अत्यधिक": u"बहुत ज़्यादा", u"अति": u"बहुत", u"शीघ्र": u"जल्दी", u"तुरंत": u"फ़ौरन",
    u"जीवन": u"ज़िंदगी", u"हृदय": u"दिल", u"प्रेम": u"प्यार", u"मित्र": u"दोस्त", u"मित्रों": u"दोस्तों",
    u"सहायता": u"मदद", u"आवश्यक": u"ज़रूरी", u"आवश्यकता": u"ज़रूरत", u"धन्यवाद": u"शुक्रिया",
    u"क्षमा": u"माफ़", u"प्रश्न": u"सवाल", u"उत्तर": u"जवाब", u"कारण": u"वजह", u"निर्णय": u"फ़ैसला",
    u"प्रतीक्षा": u"इंतज़ार", u"प्रयास": u"कोशिश", u"उपयोग": u"इस्तेमाल", u"प्रयोग": u"इस्तेमाल",
    u"आरंभ": u"शुरू", u"प्रारंभ": u"शुरू", u"समाप्त": u"ख़त्म", u"प्रसन्न": u"ख़ुश", u"स्वयं": u"ख़ुद",
    u"संसार": u"दुनिया", u"विश्व": u"दुनिया", u"सदैव": u"हमेशा", u"सदा": u"हमेशा", u"कदापि": u"कभी",
    u"यद्यपि": u"हालाँकि", u"अतः": u"इसलिए", u"तथा": u"और", u"एवं": u"और", u"अथवा": u"या",
    u"भोजन": u"खाना", u"जल": u"पानी", u"वस्त्र": u"कपड़े", u"विवाह": u"शादी", u"पुत्र": u"बेटा", u"पुत्री": u"बेटी",
    u"नेत्र": u"आँखें", u"असत्य": u"झूठ", u"सत्य": u"सच", u"वार्तालाप": u"बातचीत", u"कठिन": u"मुश्किल",
    u"सरल": u"आसान", u"शत्रु": u"दुश्मन", u"युद्ध": u"जंग", u"भय": u"डर", u"साहस": u"हिम्मत", u"स्मरण": u"याद",
    u"निकट": u"पास", u"समीप": u"पास", u"दूरभाष": u"फ़ोन", u"कृपया": u"ज़रा",
}
HI_PUNCT = re.compile(u"^([\"'“”‘’(\\[]*)(.*?)([\"'“”‘’)\\],.;:!?।…]*)$")


def hindi_token(tok):
    m = HI_PUNCT.match(tok)
    core = m.group(2)
    return m.group(1) + HI_WORDS.get(core, core) + m.group(3)


def hindi_words(words):
    out = []
    for w in words:
        nw = dict(w)
        nw["w"] = hindi_token(w["w"])
        out.append(nw)
    return out


def hindi_text(s):
    return " ".join(hindi_token(t) for t in s.split())
