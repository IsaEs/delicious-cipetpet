import { describe, expect, it } from "vitest";
import { toSpeakable } from "../src/speech/speakable.ts";

describe("toSpeakable", () => {
  it.each([
    ["**Merhaba** _dünya_, bu *gerçekten* ~~eski~~ önemli!", "Merhaba dünya, bu gerçekten eski önemli!"],
    ["# Başlık\nMetin burada.", "Başlık. Metin burada."],
    ["## Bölüm 2 ##", "Bölüm 2."],
    ["Liste:\n- elma\n- armut\n* kiraz\n1. erik\n2) incir", "Liste: elma. armut. kiraz. erik. incir."],
    ["> Alıntı satırı", "Alıntı satırı"],
    ["Önce\n\n---\n\nSonra", "Önce Sonra"],
    ["Şöyle yaz:\n```python\nprint('merhaba')\n```\nBitti.", "Şöyle yaz: kod bloğu. Bitti."],
    ["Yarım kod ```js\nconst a = 1", "Yarım kod kod bloğu."],
    ["`npm install` komutunu çalıştır.", "npm install komutunu çalıştır."],
    ["[OpenRouter](https://openrouter.ai/docs \"belgeler\") sitesine bak.", "OpenRouter sitesine bak."],
    ["Görsel: ![kedi resmi](https://x.y/kedi.png)", "Görsel: kedi resmi"],
    ["Ayrıntılar https://example.com/a?b=1 adresinde.", "Ayrıntılar bağlantı adresinde."],
    ["Bkz. www.ornek.com.tr, ya da <https://ornek.com>.", "Bkz. bağlantı, ya da bağlantı."],
    ["Harika 🎉👍🏽 oldu ❤️ 🇹🇷 tebrikler 👨‍👩‍👧!", "Harika oldu tebrikler!"],
    ["| Ad | Yaş |\n|---|:---:|\n| Ali | 30 |\n| Ayşe | 28 |", "Ad, Yaş. Ali, 30. Ayşe, 28."],
    ["Satır<br>alt satır <b>kalın</b>", "Satır alt satır kalın"],
    ["Kaçış \\*yıldız\\* ve \\_alt\\_ çizgi", "Kaçış *yıldız* ve _alt_ çizgi"],
    ["**Yarım vurgu.", "Yarım vurgu."],
    ["Bu bir snake_case_degisken adı.", "Bu bir snake_case_degisken adı."],
  ])("%j -> %j", (input, expected) => {
    expect(toSpeakable(input)).toBe(expected);
  });

  it("leaves numbers, dates, times and units for Antalia's normaliser", () => {
    const s = "Saat 14:30'da 3.5 km yürüdük, 1.250 TL harcadık; tarih 29.10.2024, oran %12.";
    expect(toSpeakable(s)).toBe(s);
  });

  it("returns an empty string when nothing speakable is left", () => {
    expect(toSpeakable("🎉🎉")).toBe("");
    expect(toSpeakable("---")).toBe("");
    expect(toSpeakable("|---|---|")).toBe("");
    expect(toSpeakable("   ")).toBe("");
    expect(toSpeakable("**")).toBe("");
  });

  it("keeps plain Turkish text as it is", () => {
    const s = "Çok güzel bir soru! Şöyle düşünebiliriz: ağaçlar ışığı sever, öyle değil mi?";
    expect(toSpeakable(s)).toBe(s);
  });
});
