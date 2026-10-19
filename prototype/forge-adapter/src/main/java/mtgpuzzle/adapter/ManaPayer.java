package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.List;

import forge.card.ColorSet;
import forge.card.MagicColor;
import forge.card.mana.ManaAtom;
import forge.game.card.Card;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.player.PlaySpellAbility;
import forge.game.player.Player;
import forge.game.spellability.AbilityManaPart;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;

/**
 * forge-ai の ComputerUtilMana の代わりに使うマナ支払い。
 * forge-gui の InputPayMana（人間用の支払い画面）の処理から、GUI に依存しない部分を移した。
 *
 * 1. マナプールにあるマナで払える分を払う
 * 2. 残りは、使えるマナ能力の候補をコントローラーに選ばせて 1 つずつ起動する（外部コントローラーなら UI に問い合わせる）
 */
final class ManaPayer {
    private ManaPayer() { }

    /** マナ源の候補。label は UI 表示用 */
    record Source(SpellAbility ability, String label) { }

    static boolean pay(PlayerControllerSupport controller, Player player, SpellAbility saPaidFor, ManaCostBeingPaid cost, boolean effect) {
        for (int guard = 0; guard < 100; guard++) {
            if (cost.isPaid()) {
                return true;
            }
            player.getManaPool().payManaCostFromPool(cost, saPaidFor, false, saPaidFor.getPayingMana());
            if (cost.isPaid()) {
                return true;
            }

            byte colorCanUse = 0;
            byte colorNeeded = 0;
            for (byte color : ManaAtom.MANATYPES) {
                if (cost.isAnyPartPayableWith(color, player.getManaPool())) colorCanUse |= color;
                if (cost.needsColor(color, player.getManaPool())) colorNeeded |= color;
            }
            if (cost.isAnyPartPayableWith((byte) ManaAtom.GENERIC, player.getManaPool())) {
                colorCanUse |= (byte) ManaAtom.GENERIC;
            }
            if (colorCanUse == 0) {
                return false;
            }

            List<Source> sources = new ArrayList<>();
            for (Card c : player.getCardsIn(ZoneType.Battlefield)) {
                for (SpellAbility ma : c.getManaAbilities()) {
                    ma.setActivatingPlayer(player);
                    if (ma.isManaAbilityFor(saPaidFor, colorCanUse) && ma.canPlay()) {
                        sources.add(new Source(ma, c.getName() + " (" + c.getId() + "): " + ma));
                    }
                }
            }
            if (sources.isEmpty()) {
                return false; // 払えない。PlaySpellAbility が唱える前の状態に戻す
            }
            Source chosen = controller.chooseManaSource(saPaidFor, cost.toString(), sources);
            if (chosen == null) {
                return false; // 支払いを取りやめた
            }
            SpellAbility ma = chosen.ability();

            // 必要な色を優先して出す（InputPayMana の「エクスプレス選択」と同じ）
            ColorSet colors = ColorSet.fromMask(colorNeeded == 0 ? colorCanUse : colorNeeded);
            int producible = 0;
            for (byte color : ManaAtom.MANATYPES) {
                if (ma.canProduce(MagicColor.toShortString(color)) && colors.hasAnyColor(color)) {
                    producible |= color;
                }
            }
            ma.setManaExpressChoice(ColorSet.fromMask(producible));

            if (!PlaySpellAbility.playSpellAbility(controller, player, ma)) {
                return false;
            }
            boolean restrictionsMet = true;
            for (AbilityManaPart mp : ma.getAllManaParts()) {
                restrictionsMet &= mp.meetsManaRestrictions(saPaidFor);
            }
            if (restrictionsMet) {
                player.getManaPool().payManaFromAbility(saPaidFor, cost, ma);
            }
        }
        return cost.isPaid();
    }
}
