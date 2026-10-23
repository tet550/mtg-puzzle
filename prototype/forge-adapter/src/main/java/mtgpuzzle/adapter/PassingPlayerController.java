package mtgpuzzle.adapter;

import java.util.List;

import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.GameObject;
import forge.game.combat.Combat;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;

/**
 * 相手（p2）のコントローラー。要件 4.3: 任意の呪文・能力は使わず、常に優先権をパスする。攻撃しない。
 * ブロックは、受けるダメージが最も少なくなるように決める（BlockPlanner。パズルは「どうブロックされても勝てる」ことを求めるため）。
 * 強制選択には BaseAdapterController の既定の答え（先頭から最小数を選ぶ）を返し、FallbackLog に記録する。
 * これが「問題で定めた方針」の既定値になる。forge-ai には依存しない。
 */
class PassingPlayerController extends BaseAdapterController {

    private final DecisionChannel channel;
    /** ブロックの方針（PuzzleDefinition.Opponent.block） */
    private final String blockPolicy;

    PassingPlayerController(Game game, Player p, LobbyPlayer lp, DecisionChannel channel, FallbackLog fallbackLog, String blockPolicy) {
        super(game, p, lp, fallbackLog);
        this.channel = channel;
        this.blockPolicy = blockPolicy;
    }

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        channel.checkHalt();
        return null;
    }

    /** マナ能力の色（2 色以上を出せる土地など）は、どれを出しても同じなので記録しない */
    @Override
    public byte chooseColor(String message, SpellAbility sa, forge.card.ColorSet colors) {
        if (sa != null && sa.isManaAbility() && !colors.isColorless()) {
            return colors.iterator().next().getColorMask();
        }
        return super.chooseColor(message, sa, colors);
    }

    /** マナプールから取り出すマナ（PlayerControllerHuman と同じく先頭を返し、未対応として記録しない） */
    @Override
    public forge.game.mana.Mana chooseManaFromPool(List<forge.game.mana.Mana> manaChoices) {
        return manaChoices.get(0);
    }

    /** 相手の戦闘ダメージの割り振り: 選ぶ余地が無ければそのまま、あれば致死量を順に（どちらも記録しない） */
    @Override
    public java.util.Map<forge.game.card.Card, Integer> assignCombatDamage(forge.game.card.Card attacker, forge.game.card.CardCollectionView blockers,
            forge.game.card.CardCollectionView remaining, int damageDealt, forge.game.GameEntity defender, boolean overrideOrder) {
        if (!damageAssignmentIsChoice(attacker, blockers, defender)) {
            return trivialDamageAssignment(blockers, damageDealt);
        }
        return defaultDamageAssignment(attacker, blockers, remaining, damageDealt, defender, overrideOrder);
    }

    /**
     * 相手が生け贄にする・破壊されるパーマネントを選ぶ（「対象のプレイヤーはクリーチャーを 1 体生け贄に捧げる」など）。
     * 相手に有利なように、価値の低いものから選ぶ: トークン → マナ総量の小さいもの → パワーの小さいもの
     */
    @Override
    public forge.game.card.CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max,
            forge.game.card.CardCollectionView validTargets, String message) {
        return chooseLowestValueCards(validTargets, min);
    }

    @Override
    public forge.game.card.CardCollectionView choosePermanentsToDestroy(SpellAbility sa, int min, int max,
            forge.game.card.CardCollectionView validTargets, String message) {
        return chooseLowestValueCards(validTargets, min);
    }

    /** 相手が捨てるカードを選ぶ（「対象のプレイヤーはカードを 1 枚捨てる」など）。価値の低いものから選ぶ */
    @Override
    public forge.game.card.CardCollectionView chooseCardsToDiscardFrom(Player playerDiscard, SpellAbility sa,
            forge.game.card.CardCollection validCards, int min, int max) {
        return chooseLowestValueCards(validCards, min);
    }

    @Override
    public forge.game.card.CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        return chooseLowestValueCards(getPlayer().getCardsIn(forge.game.zone.ZoneType.Hand), numDiscard);
    }

    @Override
    public forge.game.card.Card chooseSingleCardForZoneChange(forge.game.zone.ZoneType destination,
            java.util.List<forge.game.zone.ZoneType> origin, SpellAbility sa, forge.game.card.CardCollection fetchList,
             forge.game.player.DelayedReveal delayedReveal, String selectPrompt, boolean isOptional, Player decider) {
        if (isOptional || fetchList.isEmpty()) return null;
        return chooseLowestValueCards(fetchList, 1).getFirst();
    }

    @Override
    public java.util.List<forge.game.card.Card> chooseCardsForZoneChange(forge.game.zone.ZoneType destination,
            java.util.List<forge.game.zone.ZoneType> origin, SpellAbility sa, forge.game.card.CardCollection fetchList,
            int min, int max, forge.game.player.DelayedReveal delayedReveal, String selectPrompt, Player decider) {
        java.util.List<forge.game.card.Card> res = new java.util.ArrayList<>();
        chooseLowestValueCards(fetchList, min).forEach(res::add);
        return res;
    }

    @Override
    public forge.game.card.CardCollectionView chooseCardsForEffect(forge.game.card.CardCollectionView sourceList,
            SpellAbility sa, String title, int min, int max, boolean isOptional, java.util.Map<String, Object> params) {
        if (isOptional && min == 0) return forge.game.card.CardCollection.EMPTY;
        return chooseLowestValueCards(sourceList, min);
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T extends forge.game.GameEntity> T chooseSingleEntityForEffect(forge.util.collect.FCollectionView<T> optionList,
            forge.game.player.DelayedReveal delayedReveal, SpellAbility sa, String title, boolean isOptional,
            Player relatedPlayer, java.util.Map<String, Object> params) {
        if (isOptional || optionList.isEmpty()) return null;
        java.util.List<forge.game.card.Card> cards = new java.util.ArrayList<>();
        for (T e : optionList) {
            if (e instanceof forge.game.card.Card c) cards.add(c);
        }
        if (cards.size() == optionList.size()) {
            return (T) chooseLowestValueCards(new forge.game.card.CardCollection(cards), 1).getFirst();
        }
        return optionList.getFirst();
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T extends forge.game.GameEntity> java.util.List<T> chooseEntitiesForEffect(
            forge.util.collect.FCollectionView<T> optionList, int min, int max,
            forge.game.player.DelayedReveal delayedReveal, SpellAbility sa, String title, Player relatedPlayer,
            java.util.Map<String, Object> params) {
        if (min <= 0 || optionList.isEmpty()) return java.util.List.of();
        java.util.List<forge.game.card.Card> cards = new java.util.ArrayList<>();
        for (T e : optionList) {
            if (e instanceof forge.game.card.Card c) cards.add(c);
        }
        if (cards.size() == optionList.size()) {
            java.util.List<T> res = new java.util.ArrayList<>();
            for (forge.game.card.Card c : chooseLowestValueCards(new forge.game.card.CardCollection(cards), min)) {
                res.add((T) c);
            }
            return res;
        }
        return firstN(optionList, min);
    }

    private static forge.game.card.CardCollectionView chooseLowestValueCards(forge.game.card.CardCollectionView cards, int count) {
        java.util.List<forge.game.card.Card> list = new java.util.ArrayList<>();
        cards.forEach(list::add);
        list.sort(java.util.Comparator.comparing((forge.game.card.Card c) -> !c.isToken())
                .thenComparingInt(forge.game.card.Card::getCMC).thenComparingInt(forge.game.card.Card::getNetPower));
        return new forge.game.card.CardCollection(list.subList(0, Math.min(count, list.size())));
    }

    /** 同時に同じ領域へ移るカードの順。並びのままでよい */
    @Override
    public forge.game.card.CardCollectionView orderMoveToZoneList(forge.game.card.CardCollectionView cards, forge.game.zone.ZoneType destinationZone,
            SpellAbility source) {
        return cards;
    }

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        // 攻撃しない
    }

    /** 受けるダメージが最も少なくなるようにブロックする（問題で block: "none" ならブロックしない） */
    @Override
    public void declareBlockers(Player defender, Combat combat) {
        if (!"none".equals(blockPolicy)) {
            BlockPlanner.declare(defender, combat);
        }
    }

    /** 相手の強制的な対象選択（例: 相手がコントロールする誘発能力）は、候補の先頭から必要数を選ぶ */
    @Override
    public boolean chooseTargetsFor(SpellAbility sa) {
        List<GameObject> candidates = targetCandidates(sa);
        fallback("chooseTargetsFor: " + sa);
        for (GameObject o : firstN(candidates, sa.getMinTargets())) {
            sa.getTargets().add(o);
        }
        return sa.isTargetNumberValid();
    }
}
