#!/usr/bin/env python3
"""同梱するサンプル問題を app/public/puzzles/ にまとめ、一覧（index.json）を作る（Phase 1 M2）。

使い方: make-catalog.py <問題と解答のディレクトリ> [...]
  各ディレクトリの <名前>.json と <名前>.solution.json の組（Solver で解けたもの）を集める。
  CATALOG に名前があるものだけを、その順で同梱する。

解答手順（*.solution.json）も一緒に置く。E2E テストが使う（画面には出さない）。
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "puzzles"

# 同梱する問題（易しい順）。名前は .pzl のファイル名か、prototype/puzzles の名前
CATALOG = [
    "s1-bolt", "s2-attack", "s6-activated", "s9-x-spell", "s10-modal",
]


def main():
    dirs = [Path(d) for d in sys.argv[1:]]
    names = sys.argv[sys.argv.index("--only") + 1:] if "--only" in sys.argv else CATALOG
    if "--only" in sys.argv:
        dirs = [Path(d) for d in sys.argv[1:sys.argv.index("--only")]]
    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("*.json"):
        f.unlink()
    index = []
    for name in names:
        src = next((d for d in dirs if (d / f"{name}.json").exists() and (d / f"{name}.solution.json").exists()), None)
        if src is None:
            sys.exit(f"{name}: 問題か解答が見つかりません（{', '.join(map(str, dirs))}）")
        puzzle = json.loads((src / f"{name}.json").read_text(encoding="utf-8"))
        shutil.copy(src / f"{name}.json", OUT / f"{name}.json")
        shutil.copy(src / f"{name}.solution.json", OUT / f"{name}.solution.json")
        source = puzzle.get("source") or {}
        index.append({
            "id": name,
            "title": puzzle.get("title", name),
            "description": puzzle.get("description", ""),
            # 画面では「Forge のパズル（ファイル名）」と出す（文は画面の言語で app 側が作る）
            "sourceFile": source["file"] if source.get("type") == "forge-pzl" else None,
        })
    (OUT / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(index)} puzzles -> {OUT}")


if __name__ == "__main__":
    main()
