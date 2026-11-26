"""Dala Suite - casual romanization for Tanglish (Tamil + English) and Hinglish (Hindi + English).

Turns Tamil / Devanagari script into the spelling people actually type on phones ("naan veetuku poren",
"main ghar ja raha hoon"), keeps words that are already in Latin script, and writes the English words that
Tamil / Hindi speakers use (written in Tamil / Hindi script by speech recognition or translation) back in
English: "ஓகே சார்" -> "ok sir", "ऑफिस" -> "office".
"""
import re

# ---------------------------------------------------------------------------------------------- Tamil
TA_VOWELS = {"அ": "a", "ஆ": "aa", "இ": "i", "ஈ": "ee", "உ": "u", "ஊ": "oo", "எ": "e", "ஏ": "e", "ஐ": "ai",
             "ஒ": "o", "ஓ": "o", "ஔ": "au"}
TA_SIGNS = {"ா": "aa", "ி": "i", "ீ": "ee", "ு": "u", "ூ": "oo", "ெ": "e", "ே": "e", "ை": "ai", "ொ": "o", "ோ": "o",
            "ௌ": "au", "ௗ": "au"}
TA_VIRAMA = "்"
TA_CONS = {"க": "k", "ங": "ng", "ச": "s", "ஞ": "nj", "ட": "t", "ண": "n", "த": "th", "ந": "n", "ப": "p", "ம": "m",
           "ய": "y", "ர": "r", "ல": "l", "வ": "v", "ழ": "zh", "ள": "l", "ற": "r", "ன": "n",
           "ஜ": "j", "ஷ": "sh", "ஸ": "s", "ஹ": "h", "ஶ": "sh"}
# common words in their usual Tanglish spelling
TA_WORDS = {
    "என்ன": "enna", "நான்": "naan", "நீ": "nee", "நீங்க": "neenga", "நீங்கள்": "neengal", "நாங்க": "naanga",
    "நாம": "naama", "இல்ல": "illa", "இல்லை": "illai", "வா": "vaa", "போ": "po", "ஆமா": "aama", "சரி": "sari",
    "என்": "en", "உன்": "un", "அப்பா": "appa", "அம்மா": "amma", "அண்ணா": "anna", "அக்கா": "akka",
    "தம்பி": "thambi", "டேய்": "dei", "டா": "da", "டி": "di", "ஏன்": "yen", "எப்படி": "eppadi", "இப்போ": "ippo",
    "அப்போ": "appo", "எங்க": "enga", "இங்க": "inga", "அங்க": "anga", "யாரு": "yaaru", "யார்": "yaar",
    "எதுக்கு": "edhukku", "இது": "idhu", "அது": "adhu", "எது": "edhu", "இந்த": "indha", "அந்த": "andha",
    "எந்த": "endha", "ஒண்ணு": "onnu", "ஒன்று": "ondru", "இருக்கு": "irukku", "இருக்கா": "irukka",
    "வேணும்": "venum", "வேண்டாம்": "vendaam", "தெரியும்": "theriyum", "தெரியல": "theriyala", "பாரு": "paaru",
    "சொல்லு": "sollu", "போறேன்": "poren", "வரேன்": "varen", "நல்லா": "nalla", "ரொம்ப": "romba", "கொஞ்சம்": "konjam",
    "மட்டும்": "mattum", "தான்": "thaan", "தானே": "thaane", "கூட": "kooda", "மாதிரி": "maadhiri", "அப்புறம்": "appuram",
}
# English words written in Tamil script -> English
TA_LOAN = {
    "ஓகே": "ok", "ஓக்கே": "ok", "சார்": "sir", "சாரி": "sorry", "போன்": "phone", "போலீஸ்": "police", "ஆபீஸ்": "office",
    "தேங்க்ஸ்": "thanks", "ப்ளீஸ்": "please", "பிளீஸ்": "please", "ஹலோ": "hello", "லவ்": "love", "லைஃப்": "life",
    "லைப்": "life", "டைம்": "time", "பிளான்": "plan", "ப்ளான்": "plan", "சான்ஸ்": "chance", "பாஸ்": "boss",
    "மாஸ்": "mass", "சூப்பர்": "super", "ப்ரோ": "bro", "ஸ்கூல்": "school", "காலேஜ்": "college", "கார்": "car",
    "பைக்": "bike", "டாக்டர்": "doctor", "மேடம்": "madam", "ஃபேமிலி": "family", "பேமிலி": "family", "பிரண்ட்": "friend",
    "ஃப்ரெண்ட்": "friend", "பிரெண்ட்": "friend", "ரெடி": "ready", "வெயிட்": "wait", "ஸ்டார்ட்": "start",
    "மெசேஜ்": "message", "கால்": "call", "வீடியோ": "video", "பார்ட்டி": "party", "சினிமா": "cinema", "ஹீரோ": "hero",
    "ஸ்டைல்": "style", "செம": "sema", "மேட்டர்": "matter", "பிராப்ளம்": "problem", "ப்ராப்ளம்": "problem",
    "ஓவர்": "over", "டென்ஷன்": "tension", "ஜாலி": "jolly", "சீன்": "scene", "கேம்": "game", "டீம்": "team",
    "பவர்": "power", "கிங்": "king", "டான்": "don", "ஹேப்பி": "happy", "சேஃப்": "safe", "மிஸ்": "miss",
}


SONORANT = set("ரலளழயவ")
STRONG = {"க": "k", "ச": "ch", "ட": "t", "த": "th", "ப": "p", "ற": "t"}


def _ta_word(word):
    if word in TA_LOAN:
        return TA_LOAN[word]
    if word in TA_WORDS:
        return TA_WORDS[word]
    # split into syllable units: (consonant or None, vowel text or "" for a dead consonant)
    units = []
    i, n = 0, len(word)
    while i < n:
        ch = word[i]
        if ch in TA_VOWELS:
            units.append((None, "ye" if (ch == "ஏ" and i == 0) else TA_VOWELS[ch]))
            i += 1
        elif ch == "ஃ":
            units.append(("ஃ", ""))
            i += 1
        elif ch in TA_CONS:
            nxt = word[i + 1] if i + 1 < n else ""
            if nxt == TA_VIRAMA:
                units.append((ch, ""))
                i += 2
            elif nxt in TA_SIGNS:
                units.append((ch, TA_SIGNS[nxt]))
                i += 2
            else:
                units.append((ch, "a"))
                i += 1
        else:
            units.append(("", ch))   # digits, punctuation, Latin letters
            i += 1
    out = []
    for k, (c, v) in enumerate(units):
        if c is None or c == "":
            out.append(v)
            continue
        prev = units[k - 1] if k > 0 else None
        nxt = units[k + 1] if k + 1 < len(units) else None
        dead_prev = prev is not None and prev[0] not in (None, "") and prev[1] == ""     # previous consonant has no vowel
        prev_c = prev[0] if dead_prev else None
        after_vowel = prev is not None and (prev[1] != "" or prev[0] is None)
        if c == "ஃ":
            out.append("f" if nxt and nxt[0] == "ப" else "h")
            continue
        if c == "ப" and prev_c == "ஃ":
            out.append("" + v)
            continue
        if v == "" and nxt and nxt[0] == c and c in STRONG:
            # first half of a doubled consonant: kk, tt, pp, "ch" and "th" written once, ற்ற -> tr
            out.append({"க": "k", "ச": "", "ட": "t", "த": "", "ப": "p", "ற": "t"}[c])
            continue
        if v == "" and nxt and ((c == "ங" and nxt[0] == "க") or (c == "ஞ" and nxt[0] == "ச")):
            out.append("n")                     # ங்க -> ng, ஞ்ச -> nj
            continue
        if prev_c == c and c in STRONG:
            sound = "r" if c == "ற" else STRONG[c]
        elif c == "க":
            sound = "g" if (prev_c == "ங" or prev_c in SONORANT or (after_vowel and k > 0)) else "k"
        elif c == "ச":
            sound = "j" if prev_c == "ஞ" else "s"
        elif c == "ட":
            sound = "d" if (prev_c == "ண" or prev_c in SONORANT or (after_vowel and k > 0)) else "t"
        elif c == "த":
            sound = "dh" if (prev_c == "ந" or prev_c in SONORANT or (after_vowel and k > 0)) else "th"
        elif c == "ப":
            sound = "b" if prev_c == "ம" else "p"
        elif c == "ற":
            sound = "dr" if prev_c == "ன" else "r"
        else:
            sound = TA_CONS[c]
        out.append(sound + v)
    s = "".join(out)
    s = re.sub(r"(?<=[aeiou])y$", "i", s)                    # போய் -> poi, நாய் -> naai
    s = re.sub(r"(pp|tt|mm|nn|kk|ll)aa$", r"\1a", s)          # அப்பா -> appa, அம்மா -> amma
    return s


def tanglish(text):
    """Tamil (any mix with English) -> casual Tanglish."""
    def conv(m):
        return _ta_word(m.group(0))
    return re.sub(r"[஀-௿]+", conv, text.replace("।", "."))


# ---------------------------------------------------------------------------------------------- Hindi
HI_VOWELS = {"अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai",
             "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e"}
HI_SIGNS = {"ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o",
            "ौ": "au", "ॉ": "o", "ॅ": "e"}
HI_VIRAMA = "्"
HI_NUKTA = "़"
HI_CONS = {"क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
           "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
           "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
           "ष": "sh", "स": "s", "ह": "h", "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "फ़": "f", "ड़": "d", "ढ़": "dh"}
HI_NUKTA_CONS = {"क": "q", "ख": "kh", "ग": "gh", "ज": "z", "फ": "f", "ड": "d", "ढ": "dh"}
HI_WORDS = {
    "है": "hai", "हैं": "hain", "मैं": "main", "नहीं": "nahi", "क्या": "kya", "यह": "yeh", "ये": "ye", "वह": "woh",
    "वो": "woh", "और": "aur", "तो": "toh", "हाँ": "haan", "हां": "haan", "क्यों": "kyun", "कैसे": "kaise",
    "अच्छा": "accha", "बहुत": "bahut", "भी": "bhi", "में": "mein", "हम": "hum", "तुम": "tum", "आप": "aap",
    "कुछ": "kuch", "सब": "sab", "अब": "ab", "जब": "jab", "तब": "tab", "यहाँ": "yahan", "यहां": "yahan",
    "वहाँ": "wahan", "वहां": "wahan", "मुझे": "mujhe", "तुझे": "tujhe", "ठीक": "theek", "चलो": "chalo",
    "प्यार": "pyaar", "दोस्त": "dost", "भाई": "bhai", "यार": "yaar", "पापा": "papa", "माँ": "maa", "मां": "maa",
    "था": "tha", "थी": "thi", "थे": "the", "रहा": "raha", "रही": "rahi", "रहे": "rahe", "हूँ": "hoon", "हूं": "hoon",
    "हो": "ho", "का": "ka", "की": "ki", "के": "ke", "को": "ko", "से": "se", "पर": "par", "ने": "ne", "एक": "ek",
    "मेरा": "mera", "मेरी": "meri", "तेरा": "tera", "तेरी": "teri", "उसका": "uska", "अपना": "apna", "कौन": "kaun",
    "कहाँ": "kahan", "कहां": "kahan", "कब": "kab", "जो": "jo", "सच": "sach", "दिल": "dil", "ज़िंदगी": "zindagi",
    "जिंदगी": "zindagi", "बस": "bas", "मत": "mat", "लेकिन": "lekin", "क्योंकि": "kyunki", "इसलिए": "isliye",
    "हमें": "humein", "तुम्हें": "tumhe", "उन्हें": "unhe", "इन्हें": "inhe", "काफी": "kaafi", "काफ़ी": "kaafi",
    "फिर": "phir", "सिर्फ": "sirf", "सिर्फ़": "sirf", "हमेशा": "hamesha", "आज": "aaj", "कल": "kal",
    "सकते": "sakte", "सकता": "sakta", "चाहिए": "chahiye", "जाना": "jaana", "आना": "aana", "करना": "karna",
}
HI_LOAN = {
    "ओके": "ok", "सर": "sir", "सॉरी": "sorry", "फ़ोन": "phone", "फोन": "phone", "पुलिस": "police", "ऑफिस": "office",
    "ऑफ़िस": "office", "थैंक्स": "thanks", "प्लीज़": "please", "प्लीज": "please", "हेलो": "hello", "हैलो": "hello",
    "लव": "love", "लाइफ": "life", "लाइफ़": "life", "टाइम": "time", "प्लान": "plan", "चांस": "chance", "बॉस": "boss",
    "सुपर": "super", "ब्रो": "bro", "स्कूल": "school", "कॉलेज": "college", "कार": "car", "बाइक": "bike",
    "डॉक्टर": "doctor", "मैडम": "madam", "फैमिली": "family", "फ़ैमिली": "family", "फ्रेंड": "friend",
    "रेडी": "ready", "वेट": "wait", "मैसेज": "message", "कॉल": "call", "वीडियो": "video", "पार्टी": "party",
    "हीरो": "hero", "स्टाइल": "style", "प्रॉब्लम": "problem", "टेंशन": "tension", "गेम": "game", "टीम": "team",
    "पावर": "power", "किंग": "king", "हैप्पी": "happy", "मिस": "miss", "सेफ": "safe", "बेस्ट": "best", "सीन": "scene",
    # English words as Hindi films and everyday talk use them, typed the English way in Hinglish
    "कॉफी": "coffee", "कॉफ़ी": "coffee", "चॉइस": "choice", "टाइगर": "tiger", "फ्री": "free", "फ़्री": "free",
    "फैन": "fan", "फ़ैन": "fan", "फिल्म": "film", "फ़िल्म": "film", "फोटो": "photo", "फ़ोटो": "photo",
    "मोबाइल": "mobile", "आइडिया": "idea", "नाइस": "nice", "प्राइस": "price", "फाइट": "fight", "फ़ाइट": "fight",
    "फाइल": "file", "फ़ाइल": "file", "फाइनल": "final", "फ़ाइनल": "final", "फाइन": "fine", "फ़ाइन": "fine",
    "लाइट": "light", "राइट": "right", "नाइट": "night", "लाइन": "line", "ऑनलाइन": "online", "साइड": "side",
    "साइज": "size", "साइज़": "size", "टाइप": "type", "ड्राइवर": "driver", "प्राइवेट": "private", "मिनट": "minute",
    "सेकंड": "second", "मनी": "money", "बैंक": "bank", "टिकट": "ticket", "होटल": "hotel", "रूम": "room",
    "टेबल": "table", "केक": "cake", "बर्थडे": "birthday", "गिफ्ट": "gift", "गिफ़्ट": "gift", "शॉप": "shop",
    "शॉपिंग": "shopping", "मार्केट": "market", "मॉल": "mall", "सेल्फी": "selfie", "कैमरा": "camera",
    "सिनेमा": "cinema", "मूवी": "movie", "एक्टर": "actor", "डायरेक्टर": "director", "शो": "show",
    "न्यूज": "news", "न्यूज़": "news", "चैनल": "channel", "ट्रेन": "train", "स्टेशन": "station", "रोड": "road",
    "साइकिल": "cycle", "पेट्रोल": "petrol", "नंबर": "number", "मैनेजर": "manager", "कंपनी": "company",
    "जॉब": "job", "इंटरव्यू": "interview", "सैलरी": "salary", "एग्जाम": "exam", "एग्ज़ाम": "exam", "क्लास": "class",
    "टीचर": "teacher", "स्टूडेंट": "student", "हॉस्पिटल": "hospital", "नर्स": "nurse", "केस": "case",
    "कोर्ट": "court", "जज": "judge", "वेलकम": "welcome", "बाय": "bye", "हाय": "hi",
    "गुड": "good", "बैड": "bad", "वेरी": "very", "क्यूट": "cute", "स्मार्ट": "smart", "सिंपल": "simple",
    "सिंगल": "single", "डबल": "double", "क्रेजी": "crazy", "क्रेज़ी": "crazy", "स्वीट": "sweet", "कूल": "cool",
    "चिल": "chill", "लकी": "lucky", "श्योर": "sure", "परफेक्ट": "perfect", "परफ़ेक्ट": "perfect",
    "स्पेशल": "special", "सीरियस": "serious", "नॉर्मल": "normal", "वीकेंड": "weekend", "फ्रेंड्स": "friends",
    "फ़्रेंड": "friend", "ब्रेकअप": "breakup", "डेट": "date", "फीलिंग": "feeling", "फ़ीलिंग": "feeling",
    "मूड": "mood", "कंट्रोल": "control", "जोक": "joke", "फन": "fun", "फ़न": "fun", "फुल": "full", "फ़ुल": "full",
    "फेल": "fail", "फ़ेल": "fail", "फर्स्ट": "first", "फ़र्स्ट": "first", "लास्ट": "last", "नेक्स्ट": "next",
    "अपडेट": "update", "लैपटॉप": "laptop", "कंप्यूटर": "computer", "इंटरनेट": "internet", "पासवर्ड": "password",
    "आइसक्रीम": "ice cream", "चॉकलेट": "chocolate", "जूस": "juice", "पिज्जा": "pizza", "पिज़्ज़ा": "pizza",
    "बर्गर": "burger", "डिनर": "dinner", "लंच": "lunch", "ब्रेकफास्ट": "breakfast", "मीटिंग": "meeting",
    "प्रोजेक्ट": "project", "रिपोर्ट": "report", "थैंक": "thank", "मैच": "match",
    "क्रिकेट": "cricket", "फुटबॉल": "football", "फ़ुटबॉल": "football", "जिम": "gym", "डांस": "dance",
    "सॉन्ग": "song", "म्यूजिक": "music", "म्यूज़िक": "music", "बेबी": "baby", "डार्लिंग": "darling",
    "ऑफर": "offer", "ऑफ़र": "offer", "ऑर्डर": "order", "ऑटो": "auto",
    "पैसेंजर": "passenger", "पैसेंजर्स": "passengers", "पैसेंजेस": "passengers",
    "रॉकेट": "rocket", "स्नाइपर": "sniper", "जेलर": "jailer", "बॉम": "bomb", "बम": "bomb", "बॉम्ब": "bomb",
}


def _hi_word(word):
    if word in HI_LOAN:
        return HI_LOAN[word]
    if word in HI_WORDS:
        return HI_WORDS[word]
    units = []                      # [text, kind]; kind: V vowel, N nasal/visarga, C dead consonant,
    i, n = 0, len(word)             #                     CV consonant + vowel sign, Ca consonant + inherent a
    while i < n:
        ch = word[i]
        if ch in HI_VOWELS:
            units.append([HI_VOWELS[ch], "V"])
            i += 1
        elif ch in ("ं", "ँ"):
            nxt = word[i + 1] if i + 1 < n else ""
            units.append(["m" if nxt in ("प", "फ", "ब", "भ", "म") else "n", "N"])
            i += 1
        elif ch == "ः":
            units.append(["h", "N"])
            i += 1
        elif ch in HI_CONS:
            sound = HI_CONS[ch]
            j = i + 1
            if j < n and word[j] == HI_NUKTA:
                sound = HI_NUKTA_CONS.get(ch, sound)
                j += 1
            if j < n and word[j] == HI_VIRAMA:
                units.append([sound, "C"])
                i = j + 1
            elif j < n and word[j] in HI_SIGNS:
                units.append([sound + HI_SIGNS[word[j]], "CV"])
                i = j + 1
            else:
                units.append([sound, "Ca"])
                i = j
        else:
            units.append([ch, "O"])
            i += 1
    # schwa deletion, right to left: drop the inherent "a" at the end of the word, and in V C(a) C V
    # (between two voiced syllables) - kamal, samajhna, rahta
    keep = [u[1] != "Ca" for u in units]
    voiced = [u[1] in ("V", "CV", "Ca") for u in units]     # an undecided Ca still has its vowel
    for k in range(len(units) - 1, -1, -1):
        if units[k][1] != "Ca":
            continue
        if k == len(units) - 1:
            keep[k] = k == 0          # a one-letter word keeps its vowel
        else:
            prev_voiced = k > 0 and voiced[k - 1]
            next_voiced = voiced[k + 1]
            keep[k] = not (prev_voiced and next_voiced)
        voiced[k] = keep[k]
    s = "".join(u[0] + ("a" if (u[1] == "Ca" and keep[k]) else "") for k, u in enumerate(units))
    if sum(1 for k, u in enumerate(units) if u[1] in ("V", "CV") or (u[1] == "Ca" and keep[k])) >= 2:
        # longer words are typed with a single "a" for the long aa sign: bharat, rahul, khana (naam stays)
        s = s[:1] + s[1:].replace("aa", "a")
    s = re.sub(r"aa$", "a", s)        # mera, accha
    s = re.sub(r"ee$", "i", s)        # nahi, bhi
    s = re.sub(r"oo$", "u", s)
    if "ॉ" in word or "ऑ" in word:    # the English-only "o" vowel: an English word, so its फ is an f (offer, coffee)
        s = s.replace("ph", "f")
    s = s.replace("chchh", "chh")     # अच्छे is typed achhe, not achchhe
    return s


def hinglish(text):
    """Hindi (any mix with English) -> casual Hinglish."""
    text = text.replace("।", ".").replace("॥", ".")          # danda -> full stop
    out = re.sub(r"[ऀ-ॿ]+", lambda m: _hi_word(m.group(0)), text)
    return re.sub(r"ph\b", "f", out)                                     # sirf, taraf, saaf (phir stays)


def latin_share(text):
    """Share of words already written in Latin script (code-mixing indicator)."""
    words = re.findall(r"\w+", text)
    if not words:
        return 0.0
    return sum(1 for w in words if re.match(r"^[A-Za-z0-9']+$", w)) / float(len(words))
