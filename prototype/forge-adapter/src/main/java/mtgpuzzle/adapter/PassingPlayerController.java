package mtgpuzzle.adapter;

import java.util.List;
import java.util.Map;

import forge.LobbyPlayer;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.card.CardCollectionView;
import forge.game.combat.Combat;
import forge.game.player.DelayedReveal;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.spellability.SpellAbility;
import forge.util.collect.FCollectionView;

/**
 * 相手（p2）のコントローラー。要件 4.3: 任意の呪文・能力は使わず、常に優先権をパスする。
 * 攻撃・ブロックもしない。強制選択は PoC では AI に任せ、呼ばれた事実を記録する
 * （本番では「問題で定めた方針」で答え、対応できない選択は作成時の検証で弾く）。
 */
class PassingPlayerController extends PlayerControllerAi {
    private final FallbackLog fallbackLog;

    PassingPlayerController(Game game, Player p, LobbyPlayer lp, FallbackLog fallbackLog) {
        super(game, p, lp);
        this.fallbackLog = fallbackLog;
    }

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        return null;
    }

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        // 攻撃しない
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        // ブロックしない
    }

    @Override
    public void orderAndPlaySimultaneousSa(List<SpellAbility> activePlayerSAs) {
        fallbackLog.add(player, "orderAndPlaySimultaneousSa(" + activePlayerSAs.size() + ")");
        super.orderAndPlaySimultaneousSa(activePlayerSAs);
    }

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal,
            SpellAbility sa, String title, boolean isOptional, Player targetedPlayer, Map<String, Object> params) {
        fallbackLog.add(player, "chooseSingleEntityForEffect: " + title);
        return super.chooseSingleEntityForEffect(optionList, delayedReveal, sa, title, isOptional, targetedPlayer, params);
    }

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title,
            int min, int max, boolean isOptional, Map<String, Object> params) {
        fallbackLog.add(player, "chooseCardsForEffect: " + title);
        return super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params);
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options,
            Card cardToShow, Map<String, Object> params) {
        fallbackLog.add(player, "confirmAction: " + message);
        return super.confirmAction(sa, mode, message, options, cardToShow, params);
    }

    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        fallbackLog.add(player, "chooseCardsToDiscardToMaximumHandSize");
        return super.chooseCardsToDiscardToMaximumHandSize(numDiscard);
    }
}
