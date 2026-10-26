#!/usr/bin/env python3
"""同梱の問題で使うカードとトークンの画像 URL と日本語版（名前・印刷された文・画像）を Scryfall から引き、
app/public/cards.json にまとめる。

使い方: card-images.py
  app/public/puzzles/*.json（解答手順と一覧を除く）に出てくるカード名と、それらのカードが生成するトークン名を集め、
  通常のカードは Scryfall の /cards/collection（1 回に 75 枚まで）で英語版を、トークンは /cards/search（is:token）で引き、
  日本語版は /cards/search（lang:ja）でカード・トークンごとに引く（日本語版の無いものは英語のまま）。
  ブラウザは cards.json の URL（cards.scryfall.io の画像 CDN）から直接読む。サイトにサーバーは無い。

Scryfall の API のお願い（https://scryfall.com/docs/api）に従い、User-Agent と Accept を付け、
呼び出しの間を空ける（検索は 500 ms）。429 が返ったら待ってやり直す。画像の利用条件（Wizards of the Coast の Fan Content Policy）は design/ の V7 を参照。
"""
import gzip
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUZZLES = ROOT / "app" / "public" / "puzzles"
ENGINE = ROOT / "app" / "public" / "engine"
OUT = ROOT / "app" / "public" / "cards.json"
ZONES = ["hand", "battlefield", "graveyard", "exile", "library"]
HEADERS = {"User-Agent": "mtg-puzzle/0.1 (card image index for bundled puzzles)", "Accept": "application/json",
           "Content-Type": "application/json"}
NAME_RE = re.compile(r"^Name:(.*)$", re.MULTILINE)
HAS_JA_RE = re.compile(r"[ぁ-んァ-ヶー一-龠々]")


def card_names():
    names = set()
    for f in PUZZLES.glob("*.json"):
        if f.name.endswith(".solution.json") or f.name == "index.json":
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        for p in d["game"]["players"]:
            for z in ZONES:
                names.update(c["cardId"] for c in p.get(z, []))
    return sorted(names)


def token_names(cards):
    """同梱の問題のカードが生成するトークンの Forge での名前（例: 'Squirrel Token'）"""
    gz_files = sorted(ENGINE.glob("carddata-*.json.gz"))
    if not gz_files:
        return []
    with gzip.open(gz_files[-1], "rt", encoding="utf-8") as f:
        data = json.load(f)
    keys = data.get("keys", {})
    all_cards = data.get("cards", [])
    all_tokens = data.get("tokens", {})
    todo = [n.lower() for n in cards]
    picked = set()
    while todo:
        idx = keys.get(todo.pop())
        if idx is None or idx in picked:
            continue
        picked.add(idx)
        todo.extend(all_cards[idx].get("d") or [])
    token_todo = []
    for idx in picked:
        token_todo.extend(all_cards[idx].get("t") or [])
    seen = set()
    names = set()
    while token_todo:
        t = token_todo.pop()
        tk = all_tokens.get(t)
        if not tk or t in seen:
            continue
        seen.add(t)
        token_todo.extend(tk.get("t") or [])
        m = NAME_RE.search(tk.get("s", ""))
        if m:
            names.add(m.group(1).strip())
    return sorted(names - set(cards))


def is_token_name(name):
    return name == "Token" or name.endswith(" Token")


def token_base_name(name):
    return re.sub(r"\s+Token$", "", name)


def images(card, face_name=None):
    """表の面の画像（両面カードは face_name が一致する面、無ければ 1 面目）"""
    faces = card.get("card_faces") or []
    face = next((f for f in faces if face_name and (f.get("name") or "").lower() == face_name.lower()), None)
    if face is None and faces:
        face = faces[0]
    uris = card.get("image_uris") or (face or {}).get("image_uris") or {}
    if not uris.get("normal") or not uris.get("small"):
        return None
    out = {"normal": uris.get("normal"), "small": uris.get("small")}
    if card.get("artist"):
        out["artist"] = card.get("artist")
    return out


def get(url, data=None):
    for attempt in range(6):
        req = urllib.request.Request(url, data=data, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            if e.code == 404:  # 見つからない（日本語版が無い）
                return None
            if e.code == 429:  # 呼びすぎ。言われた時間（無ければ少しずつ長く）待ってやり直す
                time.sleep(float(e.headers.get("Retry-After") or 5 * 2 ** attempt))
                continue
            raise
    raise RuntimeError(f"Scryfall が応答しません: {url}")


def plain(card):
    """通常の版か（プロモ・フルアート・枠の特殊効果・絵違いの版は後回しにする）"""
    return not (card.get("promo") or card.get("full_art") or card.get("frame_effects") or card.get("border_color") == "borderless")


def single_face(card):
    return bool((card.get("image_uris") or {}).get("normal"))


def token_image(name):
    """トークンの英語版画像（片面・通常版を優先）"""
    base = token_base_name(name)
    q = urllib.parse.quote(f'!"{base}" is:token')
    data = get(f"https://api.scryfall.com/cards/search?q={q}&unique=prints&order=released&dir=desc")
    time.sleep(0.5)
    cards = [c for c in (data or {}).get("data", []) if images(c, base)]
    cards.sort(key=lambda c: (not single_face(c), not plain(c)))
    return images(cards[0], base) if cards else None


def strip_ruby(text):
    """Scryfall の日本語名に付いている読み仮名を外す（例: 急（きゅう）抗（こう）直（ちょっ）下（か） → 急抗直下）"""
    return re.sub(r"（[ぁ-ゖァ-ヺー]+）", "", text)


def match_face(card, face_name):
    faces = card.get("card_faces") or [card]
    if face_name and " // " not in face_name:
        return next((f for f in faces if (f.get("name") or "").lower() == face_name.lower()), faces[0])
    return faces[0]


def translated_name(card, face_name):
    if face_name and " // " in face_name and not card.get("printed_name") and len(card.get("card_faces") or []) > 1:
        parts = []
        for f in card["card_faces"]:
            p = strip_ruby(f.get("printed_name") or "")
            if not p or p.lower() == (f.get("name") or "").lower():
                return None
            parts.append(p)
        return " // ".join(parts)
    face = match_face(card, face_name)
    raw = strip_ruby(card.get("printed_name") or face.get("printed_name") or "")
    if not raw:
        return None
    en_name = face.get("name") or face_name or card.get("name") or ""
    # 英語のままの名前（出来事カードの 1 面目など、Scryfall に訳が無い）は入れない。画面は Forge の訳を使う
    return None if raw.lower() == en_name.lower() else raw


def japanese(name, token=False, query_name=None):
    """日本語版のうち、通常の版で最新のもの（無ければ特殊な版。日本語版が無ければ None）"""
    base = token_base_name(name) if token else name
    search_target = base if token else (query_name or name)
    q = urllib.parse.quote(f'!"{search_target}" is:token lang:ja' if token else f'!"{search_target}" lang:ja')
    data = get(f"https://api.scryfall.com/cards/search?q={q}&unique=prints&order=released&dir=desc")
    time.sleep(0.5)  # 検索の API は呼び出しの間隔を広めにとる
    cards = [c for c in (data or {}).get("data", [])
             if translated_name(c, base) or c.get("printed_name") or (c.get("card_faces") or [{}])[0].get("printed_name") or (token and images(c, base))]
    cards.sort(key=lambda c: (token and not single_face(c), not token and not translated_name(c, base), not plain(c)))
    for card in cards:
        face = match_face(card, base)
        img = images(card, None if " // " in base else base) or {}
        printed = translated_name(card, base)
        if " // " in base and not card.get("printed_text") and len(card.get("card_faces") or []) > 1:
            raw_text = "\n//\n".join(
                f.get("printed_text") or "" for f in card["card_faces"] if HAS_JA_RE.search(f.get("printed_text") or "")
            )
        else:
            raw_text = card.get("printed_text") or face.get("printed_text") or ""
        text = raw_text if HAS_JA_RE.search(raw_text) else None
        return {"name": printed, "normal": img.get("normal"),
                "small": img.get("small"), "artist": img.get("artist"),
                "text": text}
    return None


def main():
    names = card_names()
    tokens = token_names(names)
    out, full_names, missing = {}, {}, []
    for i in range(0, len(names), 75):
        chunk = names[i:i + 75]
        body = json.dumps({"identifiers": [{"name": n} for n in chunk]}).encode()
        data = get("https://api.scryfall.com/cards/collection", body)
        found = {}
        for card in data.get("data", []):
            img = images(card)
            if img:
                found[card["name"]] = (img, card["name"])
                # 両面・分割・出来事・前兆カードは "A // B" の名前で返る。各面の名前でも引けるようにする
                for part in card["name"].split(" // "):
                    found.setdefault(part, (images(card, part) or img, card["name"]))
        for n in chunk:
            hit = found.get(n) or found.get(n.split(" // ")[0])
            if hit:
                out[n], full_names[n] = dict(hit[0]), hit[1]
            else:
                tokens.append(n)
        time.sleep(0.1)
    for n in sorted(set(tokens)):
        img = token_image(n)
        if img:
            out[n] = img
        else:
            missing.append(n)
    ja = 0
    for n, img in out.items():
        j = japanese(n, token=is_token_name(n) or n in tokens, query_name=full_names.get(n))
        if j:
            img["ja"] = {k: v for k, v in j.items() if v}
            ja += 1
    print(f"japanese: {ja} / {len(out)}")
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(out)} cards -> {OUT}" + (f"; not found: {missing}" if missing else ""))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
