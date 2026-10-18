import { describe, expect, it } from "vitest";
import { SentenceStream, splitSentences, type Sentence } from "../src/speech/sentences.ts";

const texts = (s: Sentence[]) => s.map((x) => x.text);

/** feeds `text` one character at a time; returns each sentence with the character index that released it */
function charByChar(text: string, opts?: ConstructorParameters<typeof SentenceStream>[0]) {
  const ss = new SentenceStream(opts);
  const out: { text: string; at: number }[] = [];
  for (let i = 0; i < text.length; i++) for (const s of ss.push(text[i])) out.push({ text: s.text, at: i });
  for (const s of ss.flush()) out.push({ text: s.text, at: text.length });
  return out;
}

describe("SentenceStream", () => {
  it("emits each sentence as soon as the next character confirms its end", () => {
    const text = "Bugün hava gerçekten çok güzel. Yarın da güneşli olacak mı? Bilmiyorum!";
    const out = charByChar(text);
    expect(out.map((o) => o.text)).toEqual(["Bugün hava gerçekten çok güzel.", "Yarın da güneşli olacak mı?", "Bilmiyorum!"]);
    // a full stop is settled by the next word (ordinal / abbreviation check), "?" and "!" by the space
    expect(out[0].at).toBe(text.indexOf("Yarın"));
    expect(out[1].at).toBe(text.indexOf("Bilmiyorum") - 1);
    expect(out[2].at).toBe(text.length); // the last one on flush
  });

  it("merges very short sentences with the next one", () => {
    expect(texts(splitSentences("Merhaba! Size nasıl yardımcı olabilirim? Evet. Tamam, anladım şimdi."))).toEqual([
      "Merhaba! Size nasıl yardımcı olabilirim?",
      "Evet. Tamam, anladım şimdi.",
    ]);
  });

  it("keeps Turkish abbreviations, initials and A.Ş. inside the sentence", () => {
    expect(
      texts(
        splitSentences(
          "Dr. Ahmet Yılmaz ile Prof. Dr. Ayşe Kaya bugün geldi. Elma, armut vb. meyveler aldık. Örn. bu cümle bölünmemeli. " +
            "M. Kemal Atatürk 1881'de doğdu. Kadıköy St. Paul kilisesi eski. XYZ A.Ş. bugün açıklama yaptı. Oda No. 5 boştu.",
        ),
      ),
    ).toEqual([
      "Dr. Ahmet Yılmaz ile Prof. Dr. Ayşe Kaya bugün geldi.",
      "Elma, armut vb. meyveler aldık.",
      "Örn. bu cümle bölünmemeli.",
      "M. Kemal Atatürk 1881'de doğdu.",
      "Kadıköy St. Paul kilisesi eski.",
      "XYZ A.Ş. bugün açıklama yaptı.",
      "Oda No. 5 boştu.",
    ]);
  });

  it("ends a sentence at vb. / vs. when a capitalised word follows", () => {
    expect(texts(splitSentences("Masaya elma, armut vs. koyduk. Sonra eve döndük ve dinlendik."))).toEqual([
      "Masaya elma, armut vs. koyduk.",
      "Sonra eve döndük ve dinlendik.",
    ]);
    expect(texts(splitSentences("Kalem, defter, silgi vb. Hepsini çantaya koyduk."))).toEqual(["Kalem, defter, silgi vb.", "Hepsini çantaya koyduk."]);
  });

  it("never splits decimals or thousands, even when a delta ends right after the dot", () => {
    const ss = new SentenceStream();
    expect(ss.push("Fiyat 3.")).toEqual([]);
    expect(ss.push("5 lira oldu ve nüfus 1.")).toEqual([]);
    const a = ss.push("250 kişiye çıktı. Sonra");
    expect(texts(a)).toEqual(["Fiyat 3.5 lira oldu ve nüfus 1.250 kişiye çıktı."]);
    expect(texts(ss.flush())).toEqual(["Sonra"]);
  });

  it("does not split ordinals followed by a lowercase word", () => {
    expect(texts(splitSentences("Bu yapı 15. yüzyılda inşa edildi. 2. kattaki daire ise yeni."))).toEqual([
      "Bu yapı 15. yüzyılda inşa edildi.",
      "2. kattaki daire ise yeni.",
    ]);
  });

  it("waits for the character after a stop before deciding", () => {
    const ss = new SentenceStream();
    expect(ss.push("Bu ilk cümle oldu.")).toEqual([]);
    expect(ss.push(" ")).toEqual([]); // the next word decides (ordinal / abbreviation)
    expect(texts(ss.push("İkinci"))).toEqual(["Bu ilk cümle oldu."]);
  });

  it("splits at ellipses, ?! runs, closing quotes, colons and line breaks", () => {
    expect(
      texts(
        splitSentences('Hmm, bir düşüneyim… Gerçekten mi?! Annem "Yarın gel." dedi ve gitti. Not: bunu unutma lütfen\nİkinci satır burada'),
      ),
    ).toEqual(["Hmm, bir düşüneyim…", "Gerçekten mi?!", 'Annem "Yarın gel." dedi ve gitti.', "Not: bunu unutma lütfen", "İkinci satır burada"]);
  });

  it("does not split times, URLs or file names", () => {
    expect(texts(splitSentences("Toplantı 14:30'da başlıyor, adres openrouter.ai/docs sayfasında. Dosya rapor.pdf olarak geldi."))).toEqual([
      "Toplantı 14:30'da başlıyor, adres openrouter.ai/docs sayfasında.",
      "Dosya rapor.pdf olarak geldi.",
    ]);
  });

  it("cuts a sentence that runs over maxChars at a comma, else at a space", () => {
    const clause = "bu uzun cümle bir türlü bitmiyor";
    const long = Array.from({ length: 12 }, () => clause).join(", ") + ".";
    const out = charByChar(long, { maxChars: 120 });
    expect(out.length).toBeGreaterThan(2);
    for (const o of out) expect(o.text.length).toBeLessThanOrEqual(120);
    expect(out.slice(0, -1).every((o) => o.text.endsWith(","))).toBe(true);
    expect(out.map((o) => o.text).join(" ")).toBe(long);

    const noCommas = Array.from({ length: 60 }, (_, i) => `kelime${i}`).join(" ");
    const out2 = texts(splitSentences(noCommas, { maxChars: 100 }));
    for (const s of out2) expect(s.length).toBeLessThanOrEqual(100);
    expect(out2.join(" ")).toBe(noCommas);
  });

  it("keeps a fenced code block whole, also while it streams", () => {
    const text = "İşte örnek:\n```js\nconst a = 1. toString();\nconsole.log(a);\n```\nBu kadar basit.";
    const out = charByChar(text);
    expect(out.map((o) => o.text)).toEqual(["İşte örnek:", "```js\nconst a = 1. toString();\nconsole.log(a);\n```", "Bu kadar basit."]);
  });

  it("flushes an unterminated code block at the end", () => {
    expect(texts(splitSentences("Kod:\n```\nprint(1)"))).toEqual(["Kod:", "```\nprint(1)"]);
  });

  it("reports offsets into the whole reply", () => {
    const text = "  Birinci cümle burada.\n\n- madde bir\n- madde iki\nSon cümle de burada!  ";
    const ss = new SentenceStream({ minChars: 0 });
    const all = [...ss.push(text.slice(0, 20)), ...ss.push(text.slice(20)), ...ss.flush()];
    expect(all.map((s) => s.text)).toEqual(["Birinci cümle burada.", "- madde bir", "- madde iki", "Son cümle de burada!"]);
    for (const s of all) expect(text.slice(s.start, s.end)).toBe(s.text);
    expect(all.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(ss.text).toBe(text);
  });

  it("gives the same sentences however the text is chunked", () => {
    const text = "Dr. Ali 3.5 km yürüdü. Sonra eve döndü! Peki ya sen? 15. yüzyılda kalan bu ev çok eski… Evet: öyle.";
    const whole = texts(splitSentences(text));
    for (let size = 1; size <= 9; size++) {
      const ss = new SentenceStream();
      const out: Sentence[] = [];
      for (let i = 0; i < text.length; i += size) out.push(...ss.push(text.slice(i, i + size)));
      out.push(...ss.flush());
      expect(texts(out), `chunk size ${size}`).toEqual(whole);
    }
  });

  it("emits nothing for whitespace", () => {
    const ss = new SentenceStream();
    expect([...ss.push("   \n\n  "), ...ss.flush()]).toEqual([]);
  });
});
