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
     * 相手が生け贄にするパーマネントを選ぶ（「対象のプレイヤーはクリーチャーを 1 体生け贄に捧げる」など）。
     * 相手に有利なように、価値の低いものから選ぶ: トークン → マナ総量の小さいもの → パワーの小さいもの
     */
    @Override
    public forge.game.card.CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max,
            forge.game.card.CardCollectionView validTargets, String message) {
        java.util.List<forge.game.card.Card> list = new java.util.ArrayList<>();
        validTargets.forEach(list::add);
        list.sort(java.util.Comparator.comparing((forge.game.card.Card c) -> !c.isToken())
                .thenComparingInt(forge.game.card.Card::getCMC).thenComparingInt(forge.game.card.Card::getNetPower));
        return new forge.game.card.CardCollection(list.subList(0, Math.min(min, list.size())));
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
