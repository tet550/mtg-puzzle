"""PlayerController の抽象メソッドから、AI に依存しない既定実装 BaseAdapterController.java を生成する（C3）。

既定の方針: 「選択肢があれば先頭から最小数を選ぶ」「任意なら選ばない」「確認は No」。
呼ばれた事実は FallbackLog に残す。重要なメソッドは OVERRIDES で個別に実装する。

使い方: python gen_base_controller.py <forge root> <出力 .java>
"""
import re
import sys
from pathlib import Path

forge, out = Path(sys.argv[1]), Path(sys.argv[2])
src = (forge / "forge-game/src/main/java/forge/game/player/PlayerController.java").read_text(encoding="utf-8")
imports = sorted(set(re.findall(r"^import [\w.*]+;$", src, re.M)))

# 抽象メソッドを 1 行に正規化して抜き出す
body = re.sub(r"//[^\n]*", "", src)
body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
methods = []
for m in re.finditer(r"public abstract\s+(?!class\b)(.*?);", body, re.S):
    sig = " ".join(m.group(1).split())
    mm = re.match(r"(?:(<[^>]+>)\s+)?(.+?)\s+(\w+)\s*\((.*)\)$", sig)
    if mm is None:
        raise SystemExit("解析できないシグネチャ: " + sig[:120])
    generic, ret, name, params = mm.groups()
    methods.append((generic or "", ret, name, params))

# 個別実装（本体だけ書く）。キーは "名前/引数の数"
OVERRIDES = {
    # 選択肢から min 個（任意なら 0 個）を選ぶ系
    "chooseCardsForEffect/7": "return isOptional ? CardCollection.EMPTY : new CardCollection(firstN(sourceList, min));",
    "chooseEntitiesForEffect/8": "return firstN(optionList, min);",
    "chooseSingleEntityForEffect/7": "return isOptional || optionList.isEmpty() ? null : optionList.get(0);",
    "choosePermanentsToSacrifice/5": "return new CardCollection(firstN(validTargets, min));",
    "choosePermanentsToDestroy/5": "return new CardCollection(firstN(validTargets, min));",
    "chooseCardsToDiscardFrom/6": "return new CardCollection(firstN(validCards, min));",
    "chooseCardsToDiscardUnlessType/4": "return new CardCollection(firstN(hand, min));",
    "chooseCardsToDiscardToMaximumHandSize/1": "return new CardCollection(firstN(player.getCardsIn(ZoneType.Hand), numDiscard));",
    "chooseCardsForCost/6": "return isOptional ? CardCollection.EMPTY : new CardCollection(firstN(optionList, amount));",
    "chooseCardsForZoneChange/9": "return firstN(fetchList, min);",
    "chooseSingleCardForZoneChange/8": "return isOptional || fetchList.isEmpty() ? null : fetchList.get(0);",
    "chooseSpellAbilitiesForEffect/5": "return firstN(spells, num);",
    "chooseSingleSpellForEffect/4": "return spells.isEmpty() ? null : spells.get(0);",
    "chooseModeForAbility/5": "return firstN(possible, min);",
    "chooseSingleReplacementEffect/1": "return possibleReplacers.get(0);",
    "chooseSingleStaticAbility/1": "return possibleReplacers.get(0);",
    "chooseManaFromPool/1": "return manaChoices.get(0);",
    "chooseCounterType/4": "return options.get(0);",
    "chooseSomeType/4": "return isOptional || validTypes.isEmpty() ? null : validTypes.iterator().next();",
    "chooseColor/3": "return colors.isColorless() ? (byte) 0 : colors.iterator().next().getColorMask();",
    "chooseColorAllowColorless/3": "return colors.isColorless() ? (byte) 0 : colors.iterator().next().getColorMask();",
    "chooseColors/5": "return ColorSet.fromMask(0);",
    "chooseNumber/4": "return min;",
    "chooseNumber/4b": "return values.get(0);",
    "chooseNumberForCostReduction/3": "return min;",
    "chooseNumberForKeywordCost/5": "return 0;",
    "announceRequirements/4": "return min;",
    "chooseBinary/4": "return defaultChoice != null ? defaultChoice : true;",
    "chooseStartingPlayer/1": "return player;",
    "mulliganKeepHand/2": "return true;",
    "chooseSaToActivateFromOpeningHand/1": "return new ArrayList<>();",
    "orderSimultaneousSa/1": "return activePlayerSAs;",
    "orderBlockers/2": "return blockers;",
    "orderBlocker/3": "CardCollection r = new CardCollection(oldBlockers); r.add(blocker); return r;",
    "orderAttackers/2": "return attackers;",
    "orderMoveToZoneList/3": "return cards;",
    "orderCosts/1": "return costs;",
    "arrangeForScry/1": "return ImmutablePair.of(topN, new CardCollection());",
    "arrangeForSurveil/1": "return ImmutablePair.of(topN, new CardCollection());",
    "willPutCardOnTop/1": "return true;",
    "exertAttackers/1": "return new ArrayList<>();",
    "enlistAttackers/1": "return new ArrayList<>();",
    "chooseOptionalCosts/2": "return new ArrayList<>();",
    "chooseCardsForConvokeOrImprovise/6": "return new HashMap<>();",
    "chooseCardsForSplice/2": "return new ArrayList<>();",
    "chooseCardsToRevealFromHand/3": "return new CardCollection(firstN(valid, min));",
    "chooseCardsToDelve/2": "return CardCollection.EMPTY;",
    "chooseStartingHand/1": "return zones.get(0);",
    "sideboard/3": "return null;",
    "chooseCardsYouWonToAddToDeck/1": "return new ArrayList<>();",
    "chooseFlipResult/3": "return call;",
    "chooseCardsPile/4": "return true;",
    "chooseKeywordForPump/4": "return options.get(0);",
    "chooseProtectionType/2": "return choices.get(0);",
    "chooseSector/3": "return sectors.get(0);",
    "chooseSprocket/2": "return sprockets.get(0);",
    "chooseContraptionsToCrank/1": "return contraptions;",
    "choosePDRollToIgnore/1": "return rolls.get(0);",
    "chooseRollToIgnore/1": "return rolls.get(0);",
    "chooseDiceToReroll/1": "return new ArrayList<>();",
    "chooseRollToModify/1": "return null;",
    "chooseRollToSwap/1": "return null;",
    "chooseRollSwapValue/4": "return null;",
    "vote/6": "return options.get(0);",
    "tuckCardsViaMulligan/2": "return new CardCollection(firstN(hand, cardsToReturn));",
    "chooseSingleCardFace/4": "return null;",
    "chooseSingleCardFace/3": "return faces.get(0);",
    "chooseSingleCardState/4": "return states.get(0);",
    "chooseCardName/4": "return null;",
    "chooseCardName/3": "return faces.get(0).getName();",
    "chooseTarget/2": "return allTargets.get(0);",
    "choosePlayerToAssistPayment/4": "return null;",
    "helpPayForAssistSpell/4": "return false;",
    "chooseCardsForEffectMultiple/4": "return new CardCollection();",
    "divideShield/3": "return affected;",
    "specifyManaCombo/4": "return new HashMap<>();",
    "assignCombatDamage/6": "return defaultDamageAssignment(attacker, blockers, remaining, damageDealt, defender, overrideOrder);",
    "confirmTrigger/1": "return sa.isMandatory();",
    "confirmReplacementEffect/4": "return true;",
    "confirmStaticApplication/4": "return true;",
    "confirmPayment/3": "return true;",
    "confirmBidAction/5": "return false;",
    "payCostToPreventEffect/4": "return false;",
    "payCostDuringRoll/2": "return false;",
    "payCombatCost/4": "return false;",
    "chooseNewTargetsFor/3": "return null;",
    "chooseTargetsFor/1": "return currentAbility.isTargetNumberValid();",
    # 唱えるたびに追加コストの選び方の候補として呼ばれる。候補が複数あるときだけ記録する
    "getAbilityToPlay/3": "if (abilities.size() > 1) { fallback(\"getAbilityToPlay\"); } return abilities.isEmpty() ? null : abilities.get(0);",
    "playSpellAbilityNoStack/2": "PlaySpellAbility.playSpellAbilityNoStack(this, player, effectSA, !mayChoseNewTargets);",
    "playSaFromPlayEffect/1": "return PlaySpellAbility.playSpellAbility(this, player, tgtSA);",
    "playTrigger/3": "return PlaySpellAbility.playSpellAbilityNoStack(this, player, wrapperAbility, false);",
    "orderAndPlaySimultaneousSa/1": "for (SpellAbility sa : orderSimultaneousSa(activePlayerSAs)) { playSimultaneous(sa); }",
    "chooseSpellAbilityToPlay/0": "return null;",
    "playChosenSpellAbility/1": "return PlaySpellAbility.playSpellAbility(this, player, sa);",
    "declareAttackers/2": "",
    "declareBlockers/2": "",
    "getCostDecisionMaker/4": "return new AdapterCostDecision(this, player, ability, effect);",
    "payManaCost/6": "return PlaySpellAbility.payManaCost(this, toPay, costPartMana, sa, player, prompt, matrix, effect);",
    "applyManaToCost/5": "return ManaPayer.pay(this, player, ability, toPay, effect);",
}

# 戻り値の型から既定値を決める（OVERRIDES にないもの）
def default_for(ret, params):
    if ret == "void":
        return ""
    if ret == "boolean":
        return "return false;"
    if ret in ("int", "byte"):
        return "return 0;"
    return "return null;"

seen = {}
lines = []
for generic, ret, name, params in methods:
    # 引数の数（ジェネリクスの中のカンマは数えない）
    depth, nparams = 0, (1 if params.strip() else 0)
    for ch in params:
        depth += (ch == "<") - (ch == ">")
        nparams += (ch == "," and depth == 0)
    key = f"{name}/{nparams}"
    if key in seen:
        key += "b"
    seen[key] = True
    body = OVERRIDES.get(key)
    if body is None:
        body = default_for(ret, params)
    log = f'fallback("{name}");' if key not in ("chooseSpellAbilityToPlay/0", "playChosenSpellAbility/1",
        "getCostDecisionMaker/4", "payManaCost/6", "applyManaToCost/5", "declareAttackers/2", "declareBlockers/2",
        "orderAndPlaySimultaneousSa/1", "playTrigger/3", "playSpellAbilityNoStack/2", "playSaFromPlayEffect/1",
        "confirmTrigger/1", "chooseTargetsFor/1", "orderSimultaneousSa/1", "reveal/5", "reveal/5b", "notifyOfValue/3",
        "autoPassCancel/0", "awaitNextInput/0", "cancelAwaitNextInput/0", "revealAnte/2", "revealAISkipCards/2",
        "revealUnsupported/1", "getAbilityToPlay/3") else ""
    g = generic + " " if generic else ""
    lines.append(f"    @Override\n    public {g}{ret} {name}({params}) {{\n        {log}{(' ' if log and body else '')}{body}\n    }}\n")

java = f"""package mtgpuzzle.adapter;

// 自動生成: tools/gen_base_controller.py（Forge {forge.name} の PlayerController から）。手で編集しない。
{chr(10).join(imports)}
import java.util.ArrayList;
import java.util.HashMap;
import forge.game.player.*;
import forge.game.zone.ZoneType;
import forge.game.card.CardCollection;
import org.apache.commons.lang3.tuple.ImmutablePair;

/**
 * AI（forge-ai）に依存しない PlayerController の既定実装。
 * 既定の方針: 選択肢があれば先頭から最小数を選ぶ／任意なら選ばない／確認は No。
 * 呪文の唱え方・コスト・マナ支払いは forge-game の人間用の経路（PlaySpellAbility）を使う。
 */
abstract class BaseAdapterController extends PlayerControllerSupport {{

    BaseAdapterController(Game game, Player p, LobbyPlayer lp, FallbackLog fallbackLog) {{
        super(game, p, lp, fallbackLog);
    }}

{chr(10).join(lines)}}}
"""
out.write_text(java, encoding="utf-8")
print(f"{len(methods)} methods -> {out}")
