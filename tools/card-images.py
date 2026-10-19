#!/usr/bin/env python3
"""同梱の問題で使うカードの画像 URL を Scryfall から引き、app/public/cards.json にまとめる。

使い方: card-images.py
  app/public/puzzles/*.json（解答手順と一覧を除く）に出てくるカード名を集め、
  Scryfall の /cards/collection（1 回に 75 枚まで）で引く。
  ブラウザは cards.json の URL（cards.scryfall.io の画像 CDN）から直接読む。サイトにサーバーは無い。

Scryfall の API のお願い（https://scryfall.com/docs/api）に従い、User-Agent と Accept を付け、
呼び出しの間を 100 ms 空ける。画像の利用条件（Wizards of the Coast の Fan Content Policy）は design/ の V7 を参照。
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUZZLES = ROOT / "app" / "public" / "puzzles"
OUT = ROOT / "app" / "public" / "cards.json"
ZONES = ["hand", "battlefield", "graveyard", "exile", "library"]
HEADERS = {"User-Agent": "mtg-puzzle/0.1 (card image index for bundled puzzles)", "Accept": "application/json",
           "Content-Type": "application/json"}


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


def images(card):
    """表の面の画像（両面カードは 1 面目）"""
    uris = card.get("image_uris") or (card.get("card_faces") or [{}])[0].get("image_uris") or {}
    if not uris:
        return None
    return {"normal": uris.get("normal"), "small": uris.get("small"), "artist": card.get("artist")}


def main():
    names = card_names()
    out, missing = {}, []
    for i in range(0, len(names), 75):
        chunk = names[i:i + 75]
        body = json.dumps({"identifiers": [{"name": n} for n in chunk]}).encode()
        req = urllib.request.Request("https://api.scryfall.com/cards/collection", data=body, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.load(res)
        found = {}
        for card in data.get("data", []):
            img = images(card)
            if img:
                found[card["name"]] = img
                # 両面・分割カードは "A // B" の名前で返る。Forge の名前（1 面目）でも引けるようにする
                found.setdefault(card["name"].split(" // ")[0], img)
        for n in chunk:
            if n in found:
                out[n] = found[n]
            else:
                missing.append(n)
        time.sleep(0.1)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(out)} cards -> {OUT}" + (f"; not found: {missing}" if missing else ""))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
