// 文の中のマナ・シンボル（{G} {2} {T} {W/U} {2/W} {W/P} など）を、Scryfall のシンボルの画像にする
// （mtgtable の manaNodes と同じ。画像は svgs.scryfall.io の CDN から読む）。読めなかった記号は文字のまま出す。

const SYMBOL_URL = "https://svgs.scryfall.io/card-symbols/";
const broken = new Set<string>();

/** "{W/U}" の中身 "W/U" → 画像のファイル名 "WU"（Scryfall の命名） */
function symbolFile(code: string): string {
  return code.replace(/\//g, "").toUpperCase();
}

/** 文を、文字とシンボルの画像の並びにする */
export function manaNodes(text: string | null | undefined): Node[] {
  const s = text ?? "";
  const out: Node[] = [];
  let last = 0;
  for (const m of s.matchAll(/\{([^{}]{1,5})\}/g)) {
    if (m.index! > last) out.push(document.createTextNode(s.slice(last, m.index)));
    const url = `${SYMBOL_URL}${encodeURIComponent(symbolFile(m[1]))}.svg`;
    if (broken.has(url)) {
      out.push(document.createTextNode(m[0]));
    } else {
      const img = document.createElement("img");
      img.className = "ms";
      img.alt = m[0];
      img.title = m[0];
      img.src = url;
      img.draggable = false;
      img.addEventListener("error", () => {
        broken.add(url);
        img.replaceWith(document.createTextNode(m[0]));
      });
      out.push(img);
    }
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push(document.createTextNode(s.slice(last)));
  return out;
}
