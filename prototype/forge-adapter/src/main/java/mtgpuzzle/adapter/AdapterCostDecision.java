package mtgpuzzle.adapter;

import java.util.List;

import forge.card.CardType;
import forge.card.ColorSet;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CardLists;
import forge.game.card.CardPredicates;
import forge.game.cost.*;
import forge.game.player.Player;
import forge.game.player.PlayerController;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;

/**
 * forge-ai の AiCostDecision の代わりに使う、コスト支払いの判断。
 * カードを選ぶ必要があるコストは、候補を集めて controller.chooseCardsForCost に任せる
 * （外部コントローラーなら UI に問い合わせ、既定の実装なら先頭から選ぶ）。
 * 対応していないコストは null（支払えない）を返し、FallbackLog に記録する。
 */
final class AdapterCostDecision extends CostDecisionMakerBase {
    private final PlayerControllerSupport controller;

    AdapterCostDecision(PlayerControllerSupport controller, Player player, SpellAbility sa, boolean effect) {
        super(player, effect, sa, sa.getHostCard());
        this.controller = controller;
    }

    @Override
    public boolean paysRightAfterDecision() {
        return true;
    }

    private PaymentDecision unsupported(CostPart cost) {
        controller.fallback("未対応のコスト: " + cost.getClass().getSimpleName() + " (" + cost + ")");
        return null;
    }

    /** 候補から amount 枚を選ぶ。候補が足りなければ支払えない */
    private PaymentDecision choose(CardCollectionView valid, CostPartWithList cost, int amount) {
        if (valid.size() < amount) {
            return null;
        }
        PlayerController pc = player.getController();
        CardCollectionView chosen = pc.chooseCardsForCost(valid, ability, cost, amount, false, cost.toString());
        return chosen == null || chosen.size() != amount ? null : PaymentDecision.card(chosen);
    }

    private CardCollection valid(Iterable<Card> cards, String type) {
        return CardLists.getValidCards(new CardCollection(cards), type.split(";"), player, source, ability);
    }

    // ---- 数値だけで決まるコスト ----

    @Override public PaymentDecision visit(CostPartMana cost) { return PaymentDecision.number(0); } // 支払いは applyManaToCost で行う
    @Override public PaymentDecision visit(CostTap cost) { return PaymentDecision.number(0); }
    @Override public PaymentDecision visit(CostUntap cost) { return PaymentDecision.number(0); }
    @Override public PaymentDecision visit(CostAddMana cost) { return PaymentDecision.number(cost.getAbilityAmount(ability)); }
    @Override public PaymentDecision visit(CostDamage cost) { return PaymentDecision.number(cost.getAbilityAmount(ability)); }
    @Override public PaymentDecision visit(CostFlipCoin cost) { return PaymentDecision.number(cost.getAbilityAmount(ability)); }
    @Override public PaymentDecision visit(CostRollDice cost) { return PaymentDecision.number(cost.getAbilityAmount(ability)); }
    @Override public PaymentDecision visit(CostPayShards cost) { return PaymentDecision.number(0); }
    @Override public PaymentDecision visit(CostRevealChosen cost) { return PaymentDecision.number(1); }
    @Override public PaymentDecision visit(CostPutCounterYou cost) { return PaymentDecision.number(cost.getAbilityAmount(ability)); }

    @Override
    public PaymentDecision visit(CostPayLife cost) {
        int c = cost.getAbilityAmount(ability);
        return player.canPayLife(c, isEffect(), ability) ? PaymentDecision.number(c) : null;
    }

    @Override
    public PaymentDecision visit(CostPayEnergy cost) {
        int c = cost.getAbilityAmount(ability);
        return player.canPayEnergy(c) ? PaymentDecision.number(c) : null;
    }

    @Override
    public PaymentDecision visit(CostMill cost) {
        int c = cost.getAbilityAmount(ability);
        return player.getCardsIn(ZoneType.Library).size() < c ? null : PaymentDecision.number(c);
    }

    @Override
    public PaymentDecision visit(CostDraw cost) {
        if (!cost.canPay(ability, player, isEffect())) {
            return null;
        }
        PaymentDecision d = PaymentDecision.players(cost.getPotentialPlayers(player, ability));
        d.c = cost.getAbilityAmount(ability);
        return d;
    }

    @Override
    public PaymentDecision visit(CostChooseColor cost) {
        int c = cost.getAbilityAmount(ability);
        return PaymentDecision.colors(player.getController().chooseColors("Color", ability, c, c, ColorSet.WUBRG));
    }

    @Override
    public PaymentDecision visit(CostChooseCreatureType cost) {
        return PaymentDecision.type(player.getController().chooseSomeType("Creature", ability, CardType.getAllCreatureTypes()));
    }

    // ---- カードを選ぶコスト ----

    @Override
    public PaymentDecision visit(CostSacrifice cost) {
        if (cost.payCostFromSource()) {
            return PaymentDecision.card(source);
        }
        if (cost.getAmount().equals("All")) {
            return PaymentDecision.card(valid(player.getCardsIn(ZoneType.Battlefield), cost.getType()));
        }
        CardCollection list = valid(player.getCardsIn(ZoneType.Battlefield), cost.getType());
        list = CardLists.filter(list, CardPredicates.canBeSacrificedBy(ability, isEffect()));
        return choose(list, cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostDiscard cost) {
        CardCollectionView hand = player.getCardsIn(ZoneType.Hand);
        String type = cost.getType();
        if (cost.payCostFromSource()) {
            return hand.contains(source) ? PaymentDecision.card(source) : null;
        }
        if (type.equals("Hand")) {
            return PaymentDecision.card(hand);
        }
        if (type.equals("LastDrawn")) {
            return hand.contains(player.getLastDrawnCard()) ? PaymentDecision.card(player.getLastDrawnCard()) : null;
        }
        if (type.equals("Random") || type.contains("WithSameName") || type.contains("+WithDifferentNames")) {
            return unsupported(cost);
        }
        return choose(valid(hand, type), cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostExile cost) {
        if (cost.payCostFromSource()) {
            return PaymentDecision.card(source);
        }
        String type = cost.getType();
        if (type.equals("All")) {
            return PaymentDecision.card(player.getCardsIn(cost.getFrom()));
        }
        if (type.contains("FromTopGrave") || type.contains("+withTotalCMCGE") || type.contains("SameName")) {
            return unsupported(cost);
        }
        List<ZoneType> from = cost.getFrom();
        CardCollection list = valid(player.getGame().getCardsIn(from), type);
        return choose(list, cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostTapType cost) {
        String type = cost.getType();
        if (type.contains("+withTotalPowerGE") || type.contains("sharesCreatureTypeWith")) {
            return unsupported(cost);
        }
        CardCollection list = CardLists.filter(valid(player.getCardsIn(ZoneType.Battlefield), type), CardPredicates.CAN_TAP);
        if (!cost.canTapSource) {
            list.remove(source);
        }
        return choose(list, cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostUntapType cost) {
        CardCollection list = CardLists.filter(valid(player.getGame().getCardsIn(ZoneType.Battlefield), cost.getType()), CardPredicates.TAPPED);
        if (!cost.canUntapSource) {
            list.remove(source);
        }
        return choose(list, cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostReturn cost) {
        if (cost.payCostFromSource()) {
            return PaymentDecision.card(source);
        }
        return choose(valid(player.getCardsIn(ZoneType.Battlefield), cost.getType()), cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostReveal cost) {
        CardCollectionView from = player.getCardsIn(cost.getRevealFrom());
        if (cost.payCostFromSource()) {
            return from.contains(source) ? PaymentDecision.card(source) : null;
        }
        if (cost.getType().equals("Hand")) {
            return PaymentDecision.card(player.getCardsIn(ZoneType.Hand));
        }
        return choose(valid(from, cost.getType()), cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostPutCounter cost) {
        if (cost.payCostFromSource()) {
            return PaymentDecision.card(source);
        }
        CardCollection list = CardLists.filter(valid(player.getGame().getCardsIn(ZoneType.Battlefield), cost.getType()),
                CardPredicates.canReceiveCounters(cost.getCounter()));
        return choose(list, cost, 1);
    }

    @Override
    public PaymentDecision visit(CostRemoveCounter cost) {
        if (cost.counter == null || !cost.payCostFromSource() || cost.getAmount().equals("All")) {
            return unsupported(cost);
        }
        int c = cost.getAbilityAmount(ability);
        return source.getCounters(cost.counter) >= c ? PaymentDecision.card(source, c) : null;
    }

    @Override
    public PaymentDecision visit(CostUnattach cost) {
        CardCollection list = cost.findCardToUnattach(source, player, ability);
        return list.isEmpty() ? null : PaymentDecision.card(list.getFirst());
    }

    @Override
    public PaymentDecision visit(CostExert cost) {
        if (cost.payCostFromSource()) {
            return PaymentDecision.card(source);
        }
        return unsupported(cost);
    }

    // ---- 未対応（PoC では扱わない） ----

    @Override public PaymentDecision visit(CostBehold cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostBeholdExile cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostBlight cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostCollectEvidence cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostEnlist cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostExileFromStack cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostExiledMoveToGrave cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostForage cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostGainControl cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostGainLife cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostPromiseGift cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostPutCardToLib cost) { return unsupported(cost); }
    @Override public PaymentDecision visit(CostRemoveAnyCounter cost) { return unsupported(cost); }
}
