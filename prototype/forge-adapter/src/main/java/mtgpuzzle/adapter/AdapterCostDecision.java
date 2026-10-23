package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.common.collect.Multiset;

import forge.card.CardType;
import forge.card.ColorSet;
import forge.game.GameEntityCounterTable;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CardLists;
import forge.game.card.CardPredicates;
import forge.game.card.CounterType;
import forge.game.cost.*;
import forge.game.player.Player;
import forge.game.player.PlayerCollection;
import forge.game.player.PlayerController;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.zone.ZoneType;

/**
 * forge-ai の AiCostDecision の代わりに使う、コスト支払いの判断。
 * カードを選ぶ必要があるコストは、候補を集めて controller.chooseCardsForCost に任せる
 * （外部コントローラーなら UI に問い合わせ、既定の実装なら先頭から選ぶ）。
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

    /** 候補から amount 枚を選ぶ。候補が足りなければ支払えない */
    private PaymentDecision choose(CardCollectionView valid, CostPartWithList cost, int amount) {
        if (valid.size() < amount) {
            return null;
        }
        PlayerController pc = player.getController();
        CardCollectionView chosen = pc.chooseCardsForCost(valid, ability, cost, amount, false, cost.toString());
        return chosen == null || chosen.size() != amount ? null : PaymentDecision.card(chosen);
    }

    /** 異なる名前のカードを amount 枚選ぶ */
    private PaymentDecision chooseDifferentNames(CardCollectionView valid, CostPartWithList cost, int amount) {
        Set<String> distinct = new HashSet<>();
        for (Card c : valid) {
            distinct.add(c.getName());
        }
        if (distinct.size() < amount) {
            return null;
        }
        PaymentDecision decision = choose(valid, cost, amount);
        if (decision == null) {
            return null;
        }
        Set<String> chosenNames = new HashSet<>();
        for (Card c : decision.cards) {
            if (!chosenNames.add(c.getName())) {
                return null;
            }
        }
        return decision;
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
        String type = cost.getType();
        if (cost.getAmount().equals("All")) {
            return PaymentDecision.card(valid(player.getCardsIn(ZoneType.Battlefield), type));
        }
        boolean diffNames = type.contains("+WithDifferentNames");
        if (diffNames) {
            type = type.replace("+WithDifferentNames", "");
        }
        CardCollection list = valid(player.getCardsIn(ZoneType.Battlefield), type);
        list = CardLists.filter(list, CardPredicates.canBeSacrificedBy(ability, isEffect()));
        int amount = cost.getAbilityAmount(ability);
        return diffNames ? chooseDifferentNames(list, cost, amount) : choose(list, cost, amount);
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
        int amount = cost.getAbilityAmount(ability);
        if (type.equals("Random")) {
            return hand.size() < amount ? null : PaymentDecision.card(new CardCollection(PlayerControllerSupport.firstN(hand, amount)));
        }
        if (type.contains("+WithDifferentNames")) {
            return chooseDifferentNames(valid(hand, type.replace("+WithDifferentNames", "")), cost, amount);
        }
        if (type.contains("+WithSameName")) {
            CardCollection list = valid(hand, type.replace("+WithSameName", ""));
            CardCollection sameName = CardLists.filter(list,
                    c -> CardLists.count(list, CardPredicates.nameEquals(c.getName())) >= amount);
            return choose(sameName, cost, amount);
        }
        return choose(valid(hand, type), cost, amount);
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
        int amount = cost.getAbilityAmount(ability);
        if (type.contains("FromTopGrave")) {
            CardCollection list = CardLists.filter(valid(player.getCardsIn(ZoneType.Graveyard), type.replace("FromTopGrave", "")),
                    CardPredicates.canExiledBy(ability, isEffect()));
            return list.size() < amount ? null : PaymentDecision.card(new CardCollection(list.subList(0, amount)));
        }
        boolean cmcGE = type.contains("+withTotalCMCGE");
        boolean cmcEQ = type.contains("+withTotalCMCEQ");
        if (cmcGE || cmcEQ) {
            String splitKey = cmcGE ? "withTotalCMCGE" : "withTotalCMCEQ";
            String raw = type.split(splitKey)[1];
            int need = AbilityUtils.calculateAmount(source, raw, ability);
            type = type.replace("+" + splitKey + raw, "");
            CardCollection list = CardLists.filter(valid(player.getCardsIn(cost.getFrom()), type),
                    CardPredicates.canExiledBy(ability, isEffect()));
            if (CardLists.getTotalCMC(list) < need) {
                return null;
            }
            CardCollectionView chosen = controller.chooseCardsForTotalCMC(list, ability, need, cmcEQ);
            if (chosen == null) {
                return null;
            }
            int sum = CardLists.getTotalCMC(chosen);
            return (cmcEQ ? sum == need : sum >= need) ? PaymentDecision.card(chosen) : null;
        }
        if (type.contains("+WithDifferentNames")) {
            CardCollection list = CardLists.filter(valid(player.getGame().getCardsIn(cost.getFrom()), type.replace("+WithDifferentNames", "")),
                    CardPredicates.canExiledBy(ability, isEffect()));
            return chooseDifferentNames(list, cost, amount);
        }
        List<ZoneType> from = cost.getFrom();
        CardCollection list = CardLists.filter(valid(player.getGame().getCardsIn(from), type),
                CardPredicates.canExiledBy(ability, isEffect()));
        return choose(list, cost, amount);
    }

    @Override
    public PaymentDecision visit(CostTapType cost) {
        String type = cost.getType();
        int amount = cost.getAbilityAmount(ability);
        if (type.contains(".sharesCreatureTypeWith")) {
            String baseType = type.split("\\.sharesCreatureTypeWith")[0];
            CardCollection tapList = CardLists.filter(valid(player.getCardsIn(ZoneType.Battlefield), baseType), CardPredicates.CAN_TAP);
            if (!cost.canTapSource) {
                tapList.remove(source);
            }
            CardCollection shared = CardLists.filter(tapList, c -> CardLists.count(tapList, CardPredicates.sharesCreatureTypeWith(c)) >= amount);
            return choose(shared, cost, amount);
        }
        // 搭乗など「パワーの合計が N 以上になるようにタップする」（forge-gui の HumanCostDecision と同じ手順）
        int totalPower = -1;
        if (type.contains("+withTotalPowerGE")) {
            String n = type.split("withTotalPowerGE")[1];
            totalPower = AbilityUtils.calculateAmount(source, n, ability);
            type = type.replace("+withTotalPowerGE" + n, "");
        }
        CardCollection list = CardLists.filter(valid(player.getCardsIn(ZoneType.Battlefield), type),
                ability.isCrew() ? CardPredicates.CAN_CREW : CardPredicates.CAN_TAP);
        if (!cost.canTapSource) {
            list.remove(source);
        }
        if (totalPower >= 0) {
            if (CardLists.getTotalPower(list, ability) < totalPower) {
                return null; // 足りるだけのクリーチャーがいない
            }
            CardCollectionView chosen = controller.chooseCardsForTotalPower(list, ability, cost, totalPower);
            return chosen == null || CardLists.getTotalPower(chosen, ability) < totalPower ? null : PaymentDecision.card(chosen);
        }
        return choose(list, cost, amount);
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
        int amount = cost.getAbilityAmount(ability);
        if (cost.getType().contains("+WithSameName")) {
            CardCollection list = valid(from, cost.getType().replace("+WithSameName", ""));
            CardCollection sameName = CardLists.filter(list,
                    c -> CardLists.count(list, CardPredicates.nameEquals(c.getName())) >= amount);
            return choose(sameName, cost, amount);
        }
        return choose(valid(from, cost.getType()), cost, amount);
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
    public PaymentDecision visit(CostBlight cost) {
        return visit((CostPutCounter) cost);
    }

    @Override
    public PaymentDecision visit(CostRemoveCounter cost) {
        // forge-gui の HumanCostDecision と同じく、取り除くカウンターの表（counterTable）で返す。
        // カードだけで返すと、支払いのときに表が無くて止まる（プレインズウォーカーのマイナス能力など）
        if (cost.counter == null) {
            return removeAnyCounters(cost, cost.getType(), cost.zone);
        }
        boolean all = cost.getAmount().equals("All");
        int n = all ? 0 : cost.getAbilityAmount(ability);
        Card from;
        if (cost.payCostFromSource()) {
            from = source;
        } else if (cost.getType().equals("OriginalHost")) {
            from = ability.getOriginalHost();
        } else {
            // 他のカードから取り除く: カウンターが足りるカードを 1 枚選ぶ
            CardCollection valid = CardLists.filter(valid(player.getCardsIn(cost.zone), cost.getType()),
                    CardPredicates.hasCounter(cost.counter, Math.max(1, n)));
            if (valid.isEmpty()) {
                return null;
            }
            from = player.getController().chooseSingleEntityForEffect(valid, null, ability, "Remove counters from: " + cost, false, null, null);
            if (from == null) {
                return null;
            }
        }
        int have = from.getCounters(cost.counter);
        if (all) {
            n = have;
        }
        if (have < n) {
            return null;
        }
        GameEntityCounterTable table = new GameEntityCounterTable();
        table.put(null, from, cost.counter, n);
        return PaymentDecision.counters(table);
    }

    @Override
    public PaymentDecision visit(CostRemoveAnyCounter cost) {
        return removeAnyCounters(cost, cost.getType(), List.of(ZoneType.Battlefield));
    }

    private PaymentDecision removeAnyCounters(CostPart cost, String type, List<ZoneType> zone) {
        int needed = cost.getAbilityAmount(ability);
        CardCollection valid;
        if (cost.payCostFromSource()) {
            valid = new CardCollection(source);
        } else {
            valid = CardLists.filter(valid(player.getCardsIn(zone), type), CardPredicates.hasCounters());
        }
        int totalCounters = 0;
        for (Card c : valid) {
            totalCounters += c.getCounters().size();
        }
        if (totalCounters < needed) {
            return null;
        }
        GameEntityCounterTable table = new GameEntityCounterTable();
        PlayerController pc = player.getController();
        int left = needed;
        while (left > 0) {
            CardCollection avail = CardLists.filter(valid, c -> !table.filterToRemove(c).isEmpty());
            if (avail.isEmpty()) {
                return null;
            }
            Card card = avail.size() == 1 ? avail.getFirst()
                    : pc.chooseSingleEntityForEffect(avail, null, ability, "Select a card to remove counters from", false, null, null);
            if (card == null) {
                return null;
            }
            Multiset<CounterType> counters = table.filterToRemove(card);
            List<CounterType> types = new ArrayList<>(counters.elementSet());
            CounterType ct = types.size() == 1 ? types.get(0)
                    : pc.chooseCounterType(types, ability, "Select counter type to remove", Map.of());
            if (ct == null) {
                return null;
            }
            int maxFromType = Math.min(left, counters.count(ct));
            int amount = avail.size() == 1 && types.size() == 1 ? maxFromType
                    : (maxFromType == 1 ? 1 : pc.chooseNumber(ability, "How many " + ct.getName() + " counters to remove?", 1, maxFromType));
            table.put(null, card, ct, amount);
            left -= amount;
        }
        return PaymentDecision.counters(table);
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
        return choose(valid(player.getCardsIn(ZoneType.Battlefield), cost.getType()), cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostBehold cost) {
        CardCollection list = valid(player.getCardsIn(cost.getRevealFrom()), cost.getType());
        return choose(list, cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostBeholdExile cost) {
        CardCollection list = CardLists.filter(valid(player.getCardsIn(cost.getRevealFrom()), cost.getType()),
                CardPredicates.canExiledBy(ability, isEffect()));
        return choose(list, cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostCollectEvidence cost) {
        CardCollection list = CardLists.filter(player.getCardsIn(ZoneType.Graveyard), CardPredicates.canExiledBy(ability, isEffect()));
        int total = AbilityUtils.calculateAmount(source, cost.getAmount(), ability);
        if (CardLists.getTotalCMC(list) < total) {
            return null;
        }
        CardCollectionView chosen = controller.chooseCardsForTotalCMC(list, ability, total, false);
        return chosen == null || CardLists.getTotalCMC(chosen) < total ? null : PaymentDecision.card(chosen);
    }

    @Override
    public PaymentDecision visit(CostEnlist cost) {
        CardCollectionView list = CostEnlist.getCardsForEnlisting(player);
        return choose(list, cost, 1);
    }

    @Override
    public PaymentDecision visit(CostExileFromStack cost) {
        List<SpellAbility> saList = new ArrayList<>();
        for (SpellAbilityStackInstance si : player.getGame().getStack()) {
            SpellAbility sp = si.getSpellAbility().getRootAbility();
            if (si.getSpellAbility().isValid(cost.getType().split(";"), player, source, ability) && !saList.contains(sp)) {
                saList.add(sp);
            }
        }
        if (cost.getAmount().equals("All")) {
            return PaymentDecision.spellabilities(saList);
        }
        int c = cost.getAbilityAmount(ability);
        if (saList.size() < c) {
            return null;
        }
        List<SpellAbility> chosen = player.getController().chooseSpellAbilitiesForEffect(saList, ability, "Select to exile", c, Map.of());
        return chosen.size() == c ? PaymentDecision.spellabilities(chosen) : null;
    }

    @Override
    public PaymentDecision visit(CostExiledMoveToGrave cost) {
        CardCollection list = valid(player.getGame().getCardsIn(ZoneType.Exile), cost.getType());
        return choose(list, cost, cost.getAbilityAmount(ability));
    }

    /** Forage: 食物を 1 つ生け贄にするか、墓地のカードを 3 枚追放する（forge-gui の HumanCostDecision と同じ手順） */
    @Override
    public PaymentDecision visit(CostForage cost) {
        CardCollection food = CardLists.filter(player.getCardsIn(ZoneType.Battlefield), CardPredicates.isType("Food"),
                CardPredicates.canBeSacrificedBy(ability, isEffect()));
        CardCollection exile = CardLists.filter(player.getCardsIn(ZoneType.Graveyard), CardPredicates.canExiledBy(ability, isEffect()));
        boolean sacrifice = !food.isEmpty() && (exile.size() < 3
                || player.getController().confirmAction(ability, null, "Forage: sacrifice a Food? (No: exile three cards from your graveyard)", null, null, null));
        if (sacrifice) {
            return choose(food, cost, 1);
        }
        return exile.size() >= 3 ? choose(exile, cost, 3) : null;
    }

    @Override
    public PaymentDecision visit(CostGainControl cost) {
        CardCollection list = CardLists.filter(valid(player.getGame().getCardsIn(ZoneType.Battlefield), cost.getType()),
                c -> c.canBeControlledBy(player));
        return choose(list, cost, cost.getAbilityAmount(ability));
    }

    @Override
    public PaymentDecision visit(CostGainLife cost) {
        List<Player> opps = new ArrayList<>();
        for (Player p : cost.getPotentialTargets(player, ability)) {
            if (p.canGainLife()) {
                opps.add(p);
            }
        }
        if (opps.isEmpty()) {
            return null;
        }
        if (cost.getCntPlayers() == Integer.MAX_VALUE || opps.size() == 1) {
            return PaymentDecision.players(opps);
        }
        Player chosen = player.getController().chooseSingleEntityForEffect(
                new PlayerCollection(opps), null, ability, "Choose a player to gain life: " + cost, false, null, null);
        return chosen == null ? null : PaymentDecision.players(List.of(chosen));
    }

    @Override
    public PaymentDecision visit(CostPromiseGift cost) {
        PlayerCollection opps = cost.getPotentialPlayers(player, ability);
        if (opps.isEmpty()) {
            return null;
        }
        Player giftee = opps.size() == 1 ? opps.getFirst()
                : player.getController().chooseSingleEntityForEffect(opps, null, ability, "Choose an opponent to promise a gift", false, null, null);
        return giftee == null ? null : PaymentDecision.players(List.of(giftee));
    }

    @Override
    public PaymentDecision visit(CostPutCardToLib cost) {
        if (cost.payCostFromSource()) {
            return PaymentDecision.card(source);
        }
        CardCollectionView zoneCards = cost.isSameZone()
                ? player.getGame().getCardsIn(cost.getFrom())
                : player.getCardsIn(cost.getFrom());
        CardCollection list = valid(zoneCards, cost.getType());
        return choose(list, cost, cost.getAbilityAmount(ability));
    }
}
