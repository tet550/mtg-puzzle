#!/usr/bin/env python3
"""Forge の .pzl（res/puzzle）を、本プロジェクトの問題データ（schemaVersion 1）に変換する（Phase 1 M2）。

使い方: pzl2json.py <res/puzzle のディレクトリ> <出力先> [--report]

変換するのは、問題データの形で表せるものだけ:
- Goal が Win、Turns が 1（このターン中に勝利）
- p1（human）のターンの MAIN1 から始まる
- 先に唱えた呪文（precast）、持ち越すマナ、統率領域、プレイヤーのカウンターを使わない
- カードの指定が、タップ・召喚酔い・カウンター（と、無視してよいセット・絵柄・NoETBTrigs）だけ

変換できなかったものは、理由ごとの件数を --report で出す。
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

# Id は他のカードから参照するための番号（参照する側の指定は変換しないので、Id だけなら無視してよい）
ALLOWED_MODS = {"Set", "Art", "Id", "Tapped", "SummonSick", "Counters", "NoETBTrigs"}
ZONES = ["hand", "battlefield", "graveyard", "exile", "library"]
# precast などは使えない。life と各領域、turn / activeplayer / activephase 以外のキーがあれば変換しない
KNOWN_KEYS = {"turn", "activeplayer", "activephase", "removesummoningsickness"} | {
    f"{p}{k}" for p in ("human", "ai") for k in ["life", *ZONES]}
# 空なら問題ないキー
EMPTY_OK = {f"{p}command" for p in ("human", "ai")}


def parse(text):
    """[metadata] と [state] を辞書にする。キーは小文字に、p0 / p1 は human / ai にそろえる"""
    meta_part, _, state_part = text.partition("[state]")
    meta = dict(re.findall(r"^(\w+):(.*)$", meta_part, re.M))
    state = {}
    for k, v in re.findall(r"^(\w+)=(.*)$", state_part, re.M):
        k = k.lower()
        k = re.sub(r"^p0", "human", k)
        k = re.sub(r"^p1", "ai", k)
        state[k] = v.strip()
    active = state.get("activeplayer", "").lower()
    state["activeplayer"] = {"p0": "human", "p1": "ai"}.get(active, active)
    return meta, state


def convert_card(spec, ident):
    parts = [p.strip() for p in spec.split("|")]
    card = {"id": ident, "cardId": parts[0]}
    for m in parts[1:]:
        key, _, value = m.partition(":")
        if key not in ALLOWED_MODS:
            raise Unsupported(f"card modifier {key}")
        if key == "Tapped":
            card["tapped"] = True
        elif key == "SummonSick":
            card["summoningSick"] = True
        elif key == "Counters":
            counters = {}
            for c in value.split(","):
                name, _, n = c.partition("=")
                counters[name.strip()] = int(n or 1)
            card["counters"] = counters
    return card


class Unsupported(Exception):
    pass


def convert(name, text):
    meta, st = parse(text)
    if meta.get("Goal", "").strip() != "Win" or meta.get("Turns", "").strip() != "1":
        raise Unsupported(f"goal {meta.get('Goal', '').strip()} / turns {meta.get('Turns', '').strip()}")
    if st.get("activeplayer") != "human":
        raise Unsupported(f"active player {st.get('activeplayer')}")
    if st.get("activephase", "").upper() != "MAIN1":
        raise Unsupported(f"phase {st.get('activephase')}")
    for k, v in st.items():
        if k in EMPTY_OK and not v:
            continue
        if k not in KNOWN_KEYS:
            raise Unsupported(f"state key {re.sub(r'^(human|ai)', '', k)}")
    players = []
    for pid, key in (("p1", "human"), ("p2", "ai")):
        p = {"id": pid, "life": int(st.get(f"{key}life", 20))}
        for zone in ZONES:
            specs = [s for s in st.get(f"{key}{zone}", "").split(";") if s.strip()]
            prefix = f"{pid}{zone[0].upper()}"
            p[zone] = [convert_card(s, f"{prefix}{i}") for i, s in enumerate(specs)]
        players.append(p)
    description = meta.get("Description", "").strip().replace("\\n", "\n")
    return {
        "schemaVersion": 1,
        "title": meta.get("Name", name).strip(),
        "description": description,
        "source": {"type": "forge-pzl", "file": name, "url": meta.get("URL", "").strip() or None,
                   "difficulty": meta.get("Difficulty", "").strip() or None},
        "engine": {"type": "forge", "version": "2.0.15"},
        "game": {"activePlayer": "p1", "phase": "main1", "turn": int(st.get("turn", 1) or 1), "players": players},
        "goal": {"type": "win", "player": "p1", "deadline": "current_turn"},
        "opponent": {"policy": "pass"},
    }


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    reasons = Counter()
    ok = 0
    for f in sorted(src.glob("*.pzl")):
        try:
            puzzle = convert(f.name, f.read_text(encoding="utf-8", errors="replace"))
        except Unsupported as e:
            reasons[str(e)] += 1
            continue
        (out / (f.stem + ".json")).write_text(json.dumps(puzzle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        ok += 1
    print(f"converted {ok} / skipped {sum(reasons.values())}")
    if "--report" in sys.argv:
        for r, n in reasons.most_common():
            print(f"  {n:4d}  {r}")


if __name__ == "__main__":
    main()
