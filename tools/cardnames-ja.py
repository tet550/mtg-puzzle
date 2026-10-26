#!/usr/bin/env python3
"""Forge の cardnames-ja-JP.txt（2022年4月 SNC 以降未更新）に不足している日本語カード名・タイプ行・ルール文章、
およびトークン（tokenscripts）の日本語訳を取得し、tools/cardnames-ja-extra.txt を更新する。

特徴:
- Forge サブモジュール（prototype/forge）のファイルは一切変更しない。
- Forge 公式の JapaneseTranslations.py と同じ変換規則で Wisdom Guild（http://whisper.wisdom-guild.net/cardlist/{SET}.txt）から取得する
  （分割・出来事・前兆・両面カードの2面目以降にも対応）。
- Wisdom Guild に無いセット（統率者・ユニバースビヨンド等）は Scryfall API（lang:ja）から補完する。
- Forge の tokenscripts/*.txt にあるトークン名（"<Name> Token"）の日本語訳も自動生成する。

使い方:
  python tools/cardnames-ja.py            # 未収録の2022年以降セット＋同梱パズル＋トークンを更新
  python tools/cardnames-ja.py DSK FDN    # 指定したセットコードだけを追加取得して更新
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "prototype" / "forge" / "forge-gui" / "res"
BASE_JA = RES / "languages" / "cardnames-ja-JP.txt"
EXTRA_JA = ROOT / "tools" / "cardnames-ja-extra.txt"
PUZZLES = ROOT / "app" / "public" / "puzzles"

HEADERS = {
    "User-Agent": "mtg-puzzle/0.1 (Japanese card name supplement tool)",
    "Accept": "application/json",
}
HAS_JA_RE = re.compile(r"[ぁ-んァ-ヶー一-龠々]")
RUBY_RE = re.compile(r"（[ぁ-ゖァ-ヺー]+）")
EN_PAREN_RE = re.compile(r"\([A-Za-z0-9 '’,/-]+\)")

# Forge 公式の JapaneseTranslations.py と同じコスト記号変換表（＋新セットの記号）
COSTMAP = [
    ("(白)", "{W}"), ("(青)", "{U}"), ("(黒)", "{B}"), ("(赤)", "{R}"), ("(緑)", "{G}"),
    ("(◇)", "{C}"), ("(０)", "{0}"), ("(１)", "{1}"), ("(２)", "{2}"), ("(３)", "{3}"),
    ("(４)", "{4}"), ("(５)", "{5}"), ("(６)", "{6}"), ("(７)", "{7}"), ("(８)", "{8}"),
    ("(９)", "{9}"), ("(１０)", "{10}"), ("(１１)", "{11}"), ("(１２)", "{12}"),
    ("(１３)", "{13}"), ("(１４)", "{14}"), ("(１５)", "{15}"), ("(１６)", "{16}"),
    ("(１００)", "{100}"), ("(Ｘ)", "{X}"), ("(∞)", "{∞}"),
    ("(白/青)", "{W/U}"), ("(白/黒)", "{W/B}"), ("(青/黒)", "{U/B}"), ("(青/赤)", "{U/R}"),
    ("(黒/赤)", "{B/R}"), ("(黒/緑)", "{B/G}"), ("(赤/緑)", "{R/G}"), ("(赤/白)", "{R/W}"),
    ("(緑/白)", "{G/W}"), ("(緑/青)", "{G/U}"),
    ("(２/白)", "{2/W}"), ("(２/青)", "{2/U}"), ("(２/黒)", "{2/B}"), ("(２/赤)", "{2/R}"), ("(２/緑)", "{2/G}"),
    ("(Φ)", "{H}"), ("(白/Φ)", "{W/P}"), ("(青/Φ)", "{U/P}"), ("(黒/Φ)", "{B/P}"), ("(赤/Φ)", "{R/P}"), ("(緑/Φ)", "{G/P}"),
    ("(氷)", "{S}"), ("(Ｔ)", "{T}"), ("(Ｑ)", "{Q}"), ("(Ｅ)", "{E}"), ("[chaos]", "{CHAOS}"),
]

# 2022年後半以降にリリースされた主要セット（Wisdom Guild 収録対象 + Scryfall 補完対象）
RECENT_SETS = [
    # 2022後半〜2023
    "CLB", "40K", "DMU", "DMC", "BRO", "BRC", "J22", "ONE", "ONC", "MOM", "MOC", "MAT",
    "LTR", "LTC", "CMM", "WOE", "WOT", "WOC", "WHO", "LCI", "LCC", "REX",
    # 2024
    "RVR", "MKM", "MKC", "CLU", "PIP", "OTJ", "OTP", "OTC", "BIG",
    "MH3", "M3C", "ACR", "BLB", "BLC", "DSK", "DSC", "FDN", "FDC", "J25",
    # 2025〜2026
    "INR", "DFT", "DRC", "TDM", "TDC", "FIN", "FIC", "EOE", "EOS", "EOC",
    "SPM", "TLA", "ECL", "TMT", "SOS", "SOC", "SOA",
]

# トークン用の基本サブタイプ辞書（cardnames-ja-JP.txt から自動抽出した辞書にマージされる）
TOKEN_SUBTYPE_SEED = {
    "Treasure": "宝物", "Food": "食物", "Clue": "手がかり", "Blood": "血",
    "Map": "地図", "Powerstone": "パワーストーン", "Junk": "ガラクタ",
    "Gold": "金", "Shard": "破片", "Lander": "着陸船", "Walker": "ウォーカー",
    "Pest": "邪魔者", "Squirrel": "リス", "Inkling": "インクリング", "Fractal": "フラクタル",
    "Spirit": "スピリット", "Angel": "天使", "Soldier": "兵士", "Warrior": "戦士",
    "Knight": "騎士", "Human": "人間", "Goblin": "ゴブリン", "Elf": "エルフ",
    "Zombie": "ゾンビ", "Vampire": "吸血鬼", "Beast": "ビースト", "Bird": "鳥",
    "Cat": "猫", "Dog": "犬", "Rat": "ネズミ", "Spider": "蜘蛛", "Insect": "昆虫",
    "Snake": "蛇", "Saproling": "苗木", "Plant": "植物", "Elemental": "エレメンタル",
    "Dragon": "ドラゴン", "Demon": "デーモン", "Devil": "デビル", "Imp": "インプ",
    "Thopter": "ソプター", "Construct": "構築物", "Golem": "ゴーレム", "Servo": "霊気装置",
    "Myr": "マイア", "Drone": "ドローン", "Eldrazi": "エルドラージ", "Spawn": "落とし子",
    "Scion": "末裔", "Germ": "細菌", "Illusion": "イリュージョン", "Faerie": "フェアリー",
    "Rogue": "ならず者", "Wizard": "ウィザード", "Cleric": "クレリック", "Shaman": "シャーマン",
    "Druid": "ドルイド", "Monk": "モンク", "Samurai": "侍", "Ninja": "忍者",
    "Pirate": "海賊", "Dinosaur": "恐竜", "Merfolk": "マーフォーク", "Frog": "カエル",
    "Otter": "カワウソ", "Rabbit": "兎", "Mouse": "ハツカネズミ", "Bat": "コウモリ",
    "Fish": "魚", "Shark": "サメ", "Kraken": "クラーケン", "Octopus": "タコ",
    "Wurm": "ワーム", "Hydra": "ハイドラ", "Wolf": "狼", "Bear": "熊",
    "Boar": "猪", "Ox": "雄牛", "Horse": "馬", "Pegasus": "ペガサス",
    "Unicorn": "ユニコーン", "Griffin": "グリフィン", "Rhino": "サイ", "Elephant": "象",
    "Ape": "類人猿", "Monkey": "猿", "Treefolk": "ツリーフォーク", "Fungus": "ファンガス",
    "Ooze": "ウーズ", "Horror": "ホラー", "Nightmare": "ナイトメア", "Shade": "シェイド",
    "Skeleton": "スケルトン", "Wraith": "レイス", "Avatar": "アバター", "God": "神",
    "Phyrexian": "ファイレクシアン", "Sliver": "スリヴァー", "Ally": "同盟者",
    "Rebel": "レベル", "Mercenary": "傭兵", "Citizen": "市民", "Peasant": "農民",
    "Noble": "貴族", "Advisor": "アドバイザー", "Detective": "探偵", "Pilot": "操縦士",
    "Scout": "スカウト", "Berserker": "バーサーカー", "Barbarian": "野蛮人", "Archer": "射手",
    "Artificer": "工匠", "Warlock": "ウォーロック", "Assassin": "暗殺者",
    "Robot": "ロボット", "Hero": "ヒーロー", "Mutant": "ミュータント", "Alien": "エイリアン",
    "Toy": "玩具", "Glimmer": "グリマー", "Balloon": "風船", "Copy": "コピー",
}

TOKEN_ORACLE_MAP = {
    "{T}, Sacrifice this token: Add one mana of any color.":
        "{T}, このトークンを生け贄に捧げる：好きな色１色のマナ１点を加える。",
    "{T}, Sacrifice this artifact: Add one mana of any color.":
        "{T}, このアーティファクトを生け贄に捧げる：好きな色１色のマナ１点を加える。",
    "Sacrifice this token: Add one mana of any color.":
        "このトークンを生け贄に捧げる：好きな色１色のマナ１点を加える。",
    "Sacrifice this artifact: Add one mana of any color.":
        "このアーティファクトを生け贄に捧げる：好きな色１色のマナ１点を加える。",
    "{2}, {T}, Sacrifice this token: You gain 3 life.":
        "{2}, {T}, このトークンを生け贄に捧げる：あなたは３点のライフを得る。",
    "{2}, {T}, Sacrifice this artifact: You gain 3 life.":
        "{2}, {T}, このアーティファクトを生け贄に捧げる：あなたは３点のライフを得る。",
    "{2}, Sacrifice this token: Draw a card.":
        "{2}, このトークンを生け贄に捧げる：カード１枚を引く。",
    "{2}, Sacrifice this artifact: Draw a card.":
        "{2}, このアーティファクトを生け贄に捧げる：カード１枚を引く。",
    "{1}, {T}, Discard a card, Sacrifice this token: Draw a card.":
        "{1}, {T}, カード１枚を捨てる, このトークンを生け贄に捧げる：カード１枚を引く。",
    "{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.":
        "{1}, {T}, カード１枚を捨てる, このアーティファクトを生け贄に捧げる：カード１枚を引く。",
    "{1}, {T}, Sacrifice this token: Target creature you control explores. Activate only as a sorcery.":
        "{1}, {T}, このトークンを生け贄に捧げる：あなたがコントロールしているクリーチャー１体を対象とする。それは探検を行う。起動はソーサリーとしてのみ行う。",
    "{T}, Sacrifice this token: Exile the top card of your library. You may play that card this turn. Activate only as a sorcery.":
        "{T}, このトークンを生け贄に捧げる：あなたのライブラリーの一番上にあるカード１枚を追放する。このターン、あなたはそのカードをプレイしてもよい。起動はソーサリーとしてのみ行う。",
    "{T}: Add {C}. This mana can't be spent to cast a nonartifact spell.":
        "{T}：{C}を加える。このマナは、アーティファクトでない呪文を唱えるためには支払えない。",
    "Sacrifice this token: Add {C}.":
        "このトークンを生け贄に捧げる：{C}を加える。",
    "Sacrifice this creature: Add {C}.":
        "このクリーチャーを生け贄に捧げる：{C}を加える。",
    "Whenever this token attacks, you gain 1 life.":
        "このトークンが攻撃するたび、あなたは１点のライフを得る。",
    "Whenever this creature dies, you gain 1 life.":
        "このクリーチャーが死亡するたび、あなたは１点のライフを得る。",
    "This creature can't block.":
        "このクリーチャーはブロックできない。",
    "This token can't block.":
        "このトークンはブロックできない。",
}

KEYWORD_ORACLE_MAP = {
    "Flying": "飛行",
    "First strike": "先制攻撃",
    "Double strike": "二段攻撃",
    "Deathtouch": "接死",
    "Haste": "速攻",
    "Hexproof": "呪禁",
    "Indestructible": "破壊不能",
    "Lifelink": "絆魂",
    "Menace": "威迫",
    "Prowess": "果敢",
    "Reach": "到達",
    "Trample": "トランプル",
    "Vigilance": "警戒",
    "Defender": "防衛",
    "Decayed": "腐乱",
    "Toxic 1": "毒性１",
}


def remove_engtype(text: str) -> str:
    text = text.replace("(Urza’s)", "ウルザの").replace("(Urza's)", "ウルザの")
    text = text.replace("’", "'")
    return EN_PAREN_RE.sub("", text)


def replace_reminder_text_parentheses(text: str) -> str:
    start = 0
    while True:
        index = text.find("（", start)
        if index == -1:
            break
        if text.find("エンチャント（", start) == index - 6 or text.find("プロテクション（", start) == index - 7:
            start = index + 1
            continue
        if index == 0 or text[index - 1] == "\n":
            text = text[:index] + "(" + text[index + 1:]
        else:
            text = text[:index] + " (" + text[index + 1:]
        r_index = text.find("）", index)
        if r_index != -1:
            text = text[:r_index] + ")" + text[r_index + 1:]
        else:
            break
    return text


def replace_cost(text: str) -> str:
    for src, dst in COSTMAP:
        text = text.replace(src, dst)
    return text


def format_wg_entry(cardname: str, jap_name: str, jap_type: str, jap_text: str):
    cardname = cardname.strip().replace("AEther", "Aether")
    jap_name = jap_name.strip()
    if "（" in jap_name:
        jap_name = jap_name[:jap_name.rindex("（")].strip()
    if not cardname or not jap_name or jap_name.lower() == cardname.lower():
        return None
    jap_type = remove_engtype(jap_type.strip().replace(" --- ", " — "))
    jap_text = replace_cost(jap_text.strip())
    jap_text = remove_engtype(jap_text)
    jap_text = replace_reminder_text_parentheses(jap_text)
    jap_text = jap_text.replace("\r\n", "\n").replace("\n", "\\n")
    return cardname, f"{cardname}|{jap_name}|{jap_type}|{jap_text}"


def load_ja_map(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "|" not in line:
            continue
        key = line.split("|", 1)[0].split("$", 1)[0].strip().lower()
        if key:
            out[key] = line
    return out


def fetch_wisdom_guild_set(set_code: str) -> dict[str, str]:
    url = f"http://whisper.wisdom-guild.net/cardlist/{set_code}.txt"
    req = urllib.request.Request(url, headers={"User-Agent": HEADERS["User-Agent"]})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read().decode("cp932", errors="replace")
    except Exception:
        return {}
    if "英語名：" not in raw:
        return {}

    entries: dict[str, str] = {}
    cardname = ""
    jap_name = ""
    jap_types: list[str] = []
    jap_texts: list[str] = []
    text_mode = False

    def flush():
        nonlocal cardname, jap_name, jap_types, jap_texts, text_mode
        if cardname and jap_name and jap_types:
            if "/" in cardname and "/" in jap_name and len(jap_types) > 1:
                en_parts = [p.strip() for p in cardname.split("/")]
                ja_parts = [p.strip() for p in jap_name.split("/")]
                if len(en_parts) == len(ja_parts) == len(jap_types):
                    for ep, jp, tp, tx in zip(en_parts, ja_parts, jap_types, jap_texts):
                        item = format_wg_entry(ep, jp, tp, tx.rstrip("\n"))
                        if item:
                            entries.setdefault(item[0].lower(), item[1])
            else:
                item = format_wg_entry(cardname, jap_name, jap_types[0], jap_texts[0].rstrip("\n"))
                if item:
                    entries.setdefault(item[0].lower(), item[1])
        jap_name = ""
        jap_types = []
        jap_texts = []
        text_mode = False

    for line in raw.splitlines(keepends=True):
        if line.startswith("　英語名："):
            if text_mode:
                flush()
            cardname = line[len("　英語名："):].strip()
        elif line.startswith("日本語名："):
            jap_name = line[len("日本語名："):].strip()
        elif line.startswith("　タイプ："):
            jap_types.append(line[len("　タイプ："):].strip())
            jap_texts.append("")
            text_mode = True
        elif line.startswith("イラスト："):
            flush()
            cardname = ""
        elif line.startswith(("　Ｐ／Ｔ：", "　忠誠度：", "　守備値：", "　コスト：")):
            continue
        elif text_mode and not line.isspace() and jap_texts:
            jap_texts[-1] += line

    if text_mode:
        flush()
    return entries


def scryfall_get(url: str):
    for attempt in range(5):
        req = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:
                time.sleep(float(e.headers.get("Retry-After") or 2 * (attempt + 1)))
                continue
            return None
        except Exception:
            return None
    return None


def extract_scryfall_entries(card: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    faces = card.get("card_faces")
    targets = faces if faces else [card]
    for face in targets:
        en_name = (face.get("name") or card.get("name") or "").strip()
        if not en_name or " // " in en_name:
            continue
        ja_name = RUBY_RE.sub("", (face.get("printed_name") or card.get("printed_name") or "").strip())
        if not ja_name or ja_name.lower() == en_name.lower() or not HAS_JA_RE.search(ja_name):
            continue
        ja_type = remove_engtype((face.get("printed_type_line") or card.get("printed_type_line") or "").strip().replace(" --- ", " — "))
        raw_text = (face.get("printed_text") or card.get("printed_text") or "").strip()
        ja_text = raw_text.replace("\r\n", "\n").replace("\n", "\\n") if HAS_JA_RE.search(raw_text) else ""
        out[en_name.lower()] = f"{en_name}|{ja_name}|{ja_type}|{ja_text}"
    return out


def fetch_scryfall_set(set_code: str) -> dict[str, str]:
    entries: dict[str, str] = {}
    q = urllib.parse.quote(f"e:{set_code.lower()} lang:ja")
    url = f"https://api.scryfall.com/cards/search?q={q}&unique=cards"
    while url:
        data = scryfall_get(url)
        time.sleep(0.15)
        if not data:
            break
        for card in data.get("data", []):
            for k, line in extract_scryfall_entries(card).items():
                entries.setdefault(k, line)
        url = data.get("next_page") if data.get("has_more") else None
    return entries


def fetch_scryfall_card(name: str) -> dict[str, str]:
    q_en = urllib.parse.quote(f'!"{name}"')
    en_data = scryfall_get(f"https://api.scryfall.com/cards/search?q={q_en}")
    time.sleep(0.15)
    full_name = name
    if en_data and en_data.get("data"):
        full_name = en_data["data"][0].get("name") or name
    q_ja = urllib.parse.quote(f'!"{full_name}" lang:ja')
    ja_data = scryfall_get(f"https://api.scryfall.com/cards/search?q={q_ja}&unique=prints&order=released&dir=desc")
    time.sleep(0.15)
    entries: dict[str, str] = {}
    for card in (ja_data or {}).get("data", []):
        for k, line in extract_scryfall_entries(card).items():
            entries.setdefault(k, line)
    return entries


def build_subtype_dict(base_ja: dict[str, str], extra_ja: dict[str, str]) -> dict[str, str]:
    sub_map = dict(TOKEN_SUBTYPE_SEED)
    combined = {**base_ja, **extra_ja}
    super_and_main = {
        "Basic", "Legendary", "Snow", "World", "Ongoing",
        "Land", "Creature", "Artifact", "Enchantment", "Planeswalker",
        "Battle", "Instant", "Sorcery", "Tribal", "Kindred", "Dungeon",
    }
    for f in (RES / "cardsfolder").rglob("*.txt"):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        en_name = ""
        en_types = ""
        for line in text.splitlines():
            if line.startswith("Name:") and not en_name:
                en_name = line[5:].strip()
            elif line.startswith("Types:") and not en_types:
                en_types = line[6:].strip()
            elif line == "ALTERNATE":
                break
        if not en_name or not en_types:
            continue
        ja_line = combined.get(en_name.lower())
        if not ja_line:
            continue
        parts = ja_line.split("|")
        if len(parts) < 3 or " — " not in parts[2]:
            continue
        ja_subs = parts[2].split(" — ", 1)[1].strip().split("・")
        en_subs = [t for t in en_types.split() if t not in super_and_main]
        if len(en_subs) == len(ja_subs):
            for es, js in zip(en_subs, ja_subs):
                if es not in sub_map and js:
                    sub_map[es] = js
    return sub_map


def translate_token_oracle(oracle: str) -> str:
    if not oracle:
        return ""
    lines = [l.strip() for l in oracle.replace("\\n", "\n").splitlines() if l.strip()]
    ja_lines = []
    for line in lines:
        if line in TOKEN_ORACLE_MAP:
            ja_lines.append(TOKEN_ORACLE_MAP[line])
            continue
        parts = [p.strip() for p in line.split(",")]
        if all(p.capitalize() in KEYWORD_ORACLE_MAP or p in KEYWORD_ORACLE_MAP for p in parts):
            ja_lines.append("、".join(KEYWORD_ORACLE_MAP.get(p) or KEYWORD_ORACLE_MAP[p.capitalize()] for p in parts))
            continue
        return ""
    return "\\n".join(ja_lines)


def generate_token_entries(base_ja: dict[str, str], extra_ja: dict[str, str], sub_map: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    main_type_ja = {
        "Legendary": "伝説の",
        "Snow": "氷雪",
        "Artifact": "アーティファクト",
        "Enchantment": "エンチャント",
        "Land": "土地",
        "Creature": "クリーチャー",
    }
    for f in sorted((RES / "tokenscripts").glob("*.txt")):
        text = f.read_text(encoding="utf-8", errors="ignore")
        t_name = ""
        t_types = ""
        t_oracle = ""
        for line in text.splitlines():
            if line.startswith("Name:") and not t_name:
                t_name = line[5:].strip()
            elif line.startswith("Types:") and not t_types:
                t_types = line[6:].strip()
            elif line.startswith("Oracle:") and not t_oracle:
                t_oracle = line[7:].strip()
        if not t_name or not t_name.endswith(" Token"):
            continue
        key = t_name.lower()
        if key in base_ja or key in extra_ja or key in out:
            continue
        base_en = t_name[:-6].strip()
        words = base_en.split()
        if not words or not all(w in sub_map for w in words):
            continue
        ja_base = "・".join(sub_map[w] for w in words)
        ja_name = f"{ja_base}・トークン"

        type_tokens = t_types.split()
        prefix = []
        main_parts = []
        sub_parts = []
        for tok in type_tokens:
            if tok in ("Legendary", "Snow"):
                prefix.append(main_type_ja[tok])
            elif tok in ("Artifact", "Enchantment", "Land", "Creature"):
                main_parts.append(main_type_ja[tok])
            elif tok in sub_map:
                sub_parts.append(sub_map[tok])
        ja_type = "".join(prefix) + "トークン" + ("・" + "・".join(main_parts) if main_parts else "")
        if sub_parts:
            ja_type += " — " + "・".join(sub_parts)
        ja_oracle = translate_token_oracle(t_oracle)
        out[key] = f"{t_name}|{ja_name}|{ja_type}|{ja_oracle}"
    return out


def puzzle_card_names() -> list[str]:
    names = set()
    for f in PUZZLES.glob("*.json"):
        if f.name.endswith(".solution.json") or f.name == "index.json":
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        for p in d["game"]["players"]:
            for z in ("hand", "battlefield", "graveyard", "exile", "library"):
                for c in p.get(z, []):
                    if c.get("cardId"):
                        names.add(c["cardId"])
    return sorted(names)


def main():
    base_ja = load_ja_map(BASE_JA)
    extra_ja = load_ja_map(EXTRA_JA)
    print(f"Base cardnames-ja-JP.txt: {len(base_ja)} entries")
    print(f"Existing cardnames-ja-extra.txt: {len(extra_ja)} entries")

    forge_names: set[str] = set()
    name_re = re.compile(r"^Name:(.*)$", re.MULTILINE)
    for f in (RES / "cardsfolder").rglob("*.txt"):
        try:
            s = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for m in name_re.finditer(s):
            forge_names.add(m.group(1).strip().lower())

    target_sets = sys.argv[1:] if len(sys.argv) > 1 else RECENT_SETS
    added_wg = 0
    added_sf = 0

    for set_code in target_sets:
        ed_files = [p for p in (RES / "editions").glob("*.txt")
                    if f"Code={set_code}\n" in p.read_text(encoding="utf-8", errors="ignore")]
        ed_cards: set[str] = set()
        for ef in ed_files:
            in_cards = False
            for line in ef.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("["):
                    in_cards = (line.strip() == "[cards]")
                elif in_cards and line.strip():
                    parts = line.split(" ", 2)
                    if len(parts) >= 3:
                        cname = parts[2].split(" @")[0].strip().lower()
                        if cname in forge_names:
                            ed_cards.add(cname)
        missing_in_set = [c for c in ed_cards if c not in base_ja and c not in extra_ja]
        if not missing_in_set and len(sys.argv) <= 1:
            continue

        wg_entries = fetch_wisdom_guild_set(set_code)
        if wg_entries:
            cnt = 0
            for k, line in wg_entries.items():
                if k in forge_names and k not in base_ja and k not in extra_ja:
                    extra_ja[k] = line
                    cnt += 1
                    added_wg += 1
            print(f"[WisdomGuild] {set_code}: +{cnt} cards (fetched {len(wg_entries)})")
            time.sleep(0.2)

        still_missing = [c for c in ed_cards if c not in base_ja and c not in extra_ja]
        if (not wg_entries or len(still_missing) >= 10) and still_missing:
            sf_entries = fetch_scryfall_set(set_code)
            cnt = 0
            for k, line in sf_entries.items():
                if k in forge_names and k not in base_ja and k not in extra_ja:
                    extra_ja[k] = line
                    cnt += 1
                    added_sf += 1
            if cnt or sf_entries:
                print(f"[Scryfall]    {set_code}: +{cnt} cards (fetched {len(sf_entries)})")

    for pcard in puzzle_card_names():
        key = pcard.split(" // ")[0].strip().lower()
        if key not in base_ja and key not in extra_ja:
            sf_entries = fetch_scryfall_card(pcard)
            for k, line in sf_entries.items():
                if k not in base_ja and k not in extra_ja:
                    extra_ja[k] = line
                    added_sf += 1
                    print(f"[PuzzleCard]  {pcard} -> {line.split('|')[1]}")

    sub_map = build_subtype_dict(base_ja, extra_ja)
    token_entries = generate_token_entries(base_ja, extra_ja, sub_map)
    for k, line in token_entries.items():
        extra_ja[k] = line
    print(f"[Tokens]      +{len(token_entries)} tokens")

    sorted_lines = [extra_ja[k] for k in sorted(extra_ja.keys())]
    EXTRA_JA.write_text("\n".join(sorted_lines) + "\n", encoding="utf-8")
    print(f"Done: {len(sorted_lines)} total extra entries written to {EXTRA_JA} (WG: +{added_wg}, Scryfall: +{added_sf}, Tokens: +{len(token_entries)})")


if __name__ == "__main__":
    main()
