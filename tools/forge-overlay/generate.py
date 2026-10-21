"""Forge のクラスを、ブラウザ（CheerpJ）で止まらない形に書き換えて、forge-adapter のソースとして出力する。

forge-adapter の Maven ビルド（generate-sources）から呼ばれる。出力先は target/ の下で、リポジトリには入れない。
出力したクラスは forge-adapter の jar に入り、forge-game の同じ名前のクラスを上書きする。
なぜ必要か・Forge を更新するときの手順は design/forge-overlay.md。

使い方: python3 generate.py --forge <prototype/forge> --version <forge.version> --out <出力先> [--overlay on|off]

書き換え（いまは 1 つ）:
  forge.game.card.Card#keywordsToText
    CheerpJ 4.3 は、このメソッドを一定回数呼んだあとに止まる（JIT の不具合とみられる）。
    ループの中身を keywordToText に移し、さらに else-if の連なりを keywordToTextPart0〜3 に分ける。
    動きは変えない（作る文は同じ）。

Forge の形が想定と違うときは、何が違うかを出して止まる（黙って元のクラスのままにはしない）。
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

DOC = "design/forge-overlay.md"


class ShapeError(Exception):
    """Forge のソースが、書き換えが想定している形と違う"""


def fail(msg: str, shape: bool = True):
    print(f"[forge-overlay] エラー: {msg}", file=sys.stderr)
    if shape:
        print(f"[forge-overlay] Forge のソースの形が変わった可能性があります。{DOC} の「生成が止まったとき」を見てください。", file=sys.stderr)
    else:
        print(f"[forge-overlay] {DOC} の「Forge を更新する手順」を見てください。", file=sys.stderr)
    sys.exit(1)


def code_of(line: str) -> str:
    """括弧を数えるための、文字列・文字・行コメントを除いた部分"""
    s = re.sub(r'"(\\.|[^"\\])*"', '""', line)
    s = re.sub(r"'(\\.|[^'\\])*'", "''", s)
    return s.split("//")[0]


def block_end(lines: list[str], start: int) -> int:
    """
    start 行で開いた { に対応する } だけの行。
    `} else if (a ||` のように条件が次の行に続くと、途中で深さが 0 になるので、} だけの行で 0 になった所を終わりとする
    """
    depth = 0
    for i in range(start, len(lines)):
        c = code_of(lines[i])
        depth += c.count("{") - c.count("}")
        if depth == 0 and i > start and c.strip() == "}":
            return i
    raise ShapeError(f"{start + 1} 行目からのブロックの終わりが見つからない")


def check_jumps(body: list[str], allowed: str, where: str):
    """body の直下（内側のループ・switch の外）にある continue / break を調べる。allowed 以外があれば止まる"""
    stack: list[bool] = []  # 開いているブロックが、ループ・switch か
    for n, line in enumerate(body):
        c = code_of(line).strip()
        inner = any(stack)
        if re.fullmatch(r"(continue|break);", c) and not inner and c != allowed:
            raise ShapeError(f"{where} の {n + 1} 行目に、外側のループに効く `{c}` がある（想定していない）")
        for ch in code_of(line):
            if ch == "{":
                stack.append(bool(re.match(r"(\}\s*)?(for|while|do|switch)\b", c)))
            elif ch == "}" and stack:
                stack.pop()


def split_keywords_to_text(src: str) -> str:
    lines = src.split("\n")
    sig = "    private String keywordsToText(final Collection<KeywordInterface> keywords) {"
    if sig not in lines:
        raise ShapeError("Card.keywordsToText が見つからない（名前か引数が変わった）")
    start = lines.index(sig)
    end = block_end(lines, start)

    loop_line = "        for (KeywordInterface inst : keywords) {"
    loops = [i for i in range(start, end) if lines[i] == loop_line]
    if len(loops) != 1:
        raise ShapeError(f"keywordsToText にキーワードのループ（`{loop_line.strip()}`）が {len(loops)} 個ある（1 個を想定）")
    loop = loops[0]
    loop_end = block_end(lines, loop)
    body = lines[loop + 1:loop_end]
    if body[0].strip() != "String keyword = inst.getOriginal();":
        raise ShapeError(f"ループの最初の文が想定と違う: {body[0].strip()}")
    for n, l in enumerate(lines[start:loop]):
        if re.search(r"\binst\b|\bkeyword\b", code_of(l)):
            raise ShapeError(f"ループの前で inst / keyword を使っている（{start + n + 1} 行目）")
    check_jumps(body, "continue;", "keywordsToText のループ")

    # ループの中身を 1 段浅くして keywordToText に移す（continue → return i）
    moved = [(l[4:] if l.startswith("    ") else l) for l in body]
    moved = [l.replace("continue;", "return i;") if code_of(l).strip() == "continue;" else l for l in moved]

    # moved の中の else-if の連なり（try の直下）を 4 つに分ける
    try_at = [n for n, l in enumerate(moved) if l == "        try {"]
    if len(try_at) != 1:
        raise ShapeError("ループの中身に try が 1 つだけある形を想定")
    chain = try_at[0] + 1
    if not re.match(r"^            if \(keyword\.", moved[chain]):
        raise ShapeError(f"try の最初が `if (keyword...` でない: {moved[chain].strip()}")
    chain_end = block_end(moved, chain)  # 連なりの最後の } の行
    seg = moved[chain:chain_end + 1]
    for n, l in enumerate(seg):
        c = code_of(l)
        if re.search(r"(?<![\w.])i\s*(=[^=]|\+\+|--|\+=|-=)", c):
            raise ShapeError(f"連なりの中で i を書き換えている（keywordToText の {chain + n + 1} 行目）")
    assigns = [l.strip() for l in seg if re.search(r"(?<![\w.])keyword\s*=[^=]", code_of(l))]
    if assigns != ['keyword = keyword.replace("Strike", "strike");']:
        raise ShapeError(f"連なりの中の keyword への代入が想定と違う: {assigns}")

    cuts = [n for n in range(1, len(seg)) if re.match(r"^            \} else if \(", seg[n])]
    parts = 4
    if len(cuts) < parts * 3:
        raise ShapeError(f"else-if の枝が少ない（{len(cuts) + 1} 個）。分け方を見直す")
    chosen = [cuts[round(len(cuts) / parts * k)] for k in range(1, parts)]
    bounds = [0] + chosen + [len(seg)]
    # 最後の枝（else）で keyword を書き換えるのは最後の部分だけ
    for k in range(parts - 1):
        if any(re.search(r"(?<![\w.])keyword\s*=[^=]", code_of(l)) for l in seg[bounds[k]:bounds[k + 1]]):
            raise ShapeError("keyword を書き換える枝が最後の部分以外にある")

    params = ("final KeywordInterface inst, String keyword, final Collection<KeywordInterface> keywords, "
              "final StringBuilder sb, final StringBuilder sbLong, final List<String> printedKW, final int i")
    args = "inst, keyword, keywords, sb, sbLong, printedKW, i"
    call = []
    for k in range(parts):
        if k == 0:
            call.append(f"            Boolean r = keywordToTextPart{k}({args});")
        else:
            call += ["            if (r == null) {", f"                r = keywordToTextPart{k}({args});", "            }"]
    call += ["            if (Boolean.FALSE.equals(r)) {", "                return i; // 元の continue", "            }"]

    part_methods = []
    for k in range(parts):
        s = seg[bounds[k]:bounds[k + 1]]
        if k > 0:
            s = [s[0].replace("            } else if (", "            if (", 1)] + s[1:]
        s = [l.replace("return i;", "return Boolean.FALSE;") if code_of(l).strip() == "return i;" else l for l in s]
        part_methods += ["",
                         f"    /** keywordsToText の else-if の連なりの {k + 1}/{parts}。当てはまる枝が無ければ null、元の continue なら FALSE */",
                         f"    private Boolean keywordToTextPart{k}({params}) {{"]
        part_methods += s
        if k < parts - 1:
            part_methods += ["            } else {", "                return null;", "            }"]
        part_methods += ["        return Boolean.TRUE;", "    }"]

    new_moved = moved[:chain] + call + moved[chain_end + 1:]
    out = lines[:loop + 1]
    out.append("            i = keywordToText(inst, keywords, sb, sbLong, printedKW, i);")
    out += lines[loop_end:end + 1]
    out += ["",
            "    /** keywordsToText のキーワード 1 つ分（CheerpJ で止まらないように分けた）。次の i を返す */",
            "    private int keywordToText(final KeywordInterface inst, final Collection<KeywordInterface> keywords, final StringBuilder sb,",
            "            final StringBuilder sbLong, final List<String> printedKW, int i) {"]
    out += new_moved
    out += ["        return i;", "    }"]
    out += part_methods
    out += lines[end + 1:]
    return "\n".join(out)


OVERLAYS = [
    # (Forge のソース（forge-game からの相対）, 書き換え)
    ("src/main/java/forge/game/card/Card.java", split_keywords_to_text),
]


def forge_version(forge: Path) -> str:
    m = re.search(r"<version>([^<]+)</version>", (forge / "pom.xml").read_text(encoding="utf-8"))
    if not m:
        fail(f"{forge / 'pom.xml'} から Forge の版が読めない", shape=False)
    return m.group(1)


def main():
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")  # Windows でも、Maven のログに日本語をそのまま出す
    ap = argparse.ArgumentParser()
    ap.add_argument("--forge", required=True, help="Forge のソース（prototype/forge）")
    ap.add_argument("--version", required=True, help="forge-adapter が依存する forge-game の版（pom.xml の forge.version）")
    ap.add_argument("--out", required=True, help="出力先（生成したソースのルート）")
    ap.add_argument("--overlay", default="on", choices=["on", "off"],
                    help="off なら何も作らず、前に作ったものも消す（上書きなしで CheerpJ の不具合が直ったかを確かめるとき）")
    a = ap.parse_args()
    forge, out = Path(a.forge), Path(a.out)

    if a.overlay == "off":
        if out.exists():
            shutil.rmtree(out)
        print("[forge-overlay] off: Forge のクラスを上書きしない")
        return

    # ソース（サブモジュール）と、依存する jar（~/.m2 の forge-game）の版が違うと、上書きしたクラスだけ別の版になる
    v = forge_version(forge)
    if v != a.version:
        fail(f"サブモジュールの Forge は {v}、forge-adapter の forge.version は {a.version}。そろえてから forge-game を mvn install する", shape=False)

    for rel, transform in OVERLAYS:
        src_file = forge / "forge-game" / rel
        try:
            text = transform(src_file.read_text(encoding="utf-8"))
        except ShapeError as e:
            fail(f"{rel}: {e}")
        dst = out / rel.removeprefix("src/main/java/")
        dst.parent.mkdir(parents=True, exist_ok=True)
        header = (f"// 生成ファイル（編集しない）: tools/forge-overlay/generate.py が Forge {v} の {rel} から作った。\n"
                  f"// forge-game の同じクラスを上書きする。理由は {DOC}。\n")
        dst.write_text(header + text, encoding="utf-8", newline="\n")
        print(f"[forge-overlay] {rel} -> {dst}")


if __name__ == "__main__":
    main()
