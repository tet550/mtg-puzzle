package mtgpuzzle.adapter;

// 自動生成: tools/gen_base_controller.py（Forge forge の PlayerController から）。手で編集しない。
import com.google.common.collect.ListMultimap;
import com.google.common.collect.Lists;
import com.google.common.collect.Multimap;
import forge.LobbyPlayer;
import forge.card.ColorSet;
import forge.card.ICardFace;
import forge.card.mana.ManaCost;
import forge.card.mana.ManaCostShard;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.game.*;
import forge.game.GameOutcome.AnteResult;
import forge.game.ability.AbilityUtils;
import forge.game.ability.effects.RollDiceEffect;
import forge.game.card.*;
import forge.game.combat.Combat;
import forge.game.cost.*;
import forge.game.keyword.KeywordInterface;
import forge.game.mana.Mana;
import forge.game.mana.ManaConversionMatrix;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.replacement.ReplacementEffect;
import forge.game.spellability.*;
import forge.game.staticability.StaticAbility;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.PlayerZone;
import forge.game.zone.ZoneType;
import forge.item.PaperCard;
import forge.util.ITriggerEvent;
import forge.util.collect.FCollectionView;
import java.util.Arrays;
import java.util.Collection;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.stream.Collectors;
import org.apache.commons.lang3.tuple.ImmutablePair;
import org.apache.commons.lang3.tuple.Pair;
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
abstract class BaseAdapterController extends PlayerControllerSupport {

    BaseAdapterController(Game game, Player p, LobbyPlayer lp, FallbackLog fallbackLog) {
        super(game, p, lp, fallbackLog);
    }

    @Override
    public SpellAbility getAbilityToPlay(Card hostCard, List<SpellAbility> abilities, ITriggerEvent triggerEvent) {
        if (abilities.size() > 1) { fallback("getAbilityToPlay"); } return abilities.isEmpty() ? null : abilities.get(0);
    }

    @Override
    public void playSpellAbilityNoStack(SpellAbility effectSA, boolean mayChoseNewTargets) {
        PlaySpellAbility.playSpellAbilityNoStack(this, player, effectSA, !mayChoseNewTargets);
    }

    @Override
    public List<SpellAbility> orderSimultaneousSa(List<SpellAbility> activePlayerSAs) {
        return activePlayerSAs;
    }

    @Override
    public void orderAndPlaySimultaneousSa(List<SpellAbility> activePlayerSAs) {
        for (SpellAbility sa : orderSimultaneousSa(activePlayerSAs)) { playSimultaneous(sa); }
    }

    @Override
    public boolean playTrigger(Card host, WrappedAbility wrapperAbility, boolean isMandatory) {
        return PlaySpellAbility.playSpellAbilityNoStack(this, player, wrapperAbility, false);
    }

    @Override
    public boolean playSaFromPlayEffect(SpellAbility tgtSA) {
        return PlaySpellAbility.playSpellAbility(this, player, tgtSA);
    }

    @Override
    public List<PaperCard> sideboard(final Deck deck, GameType gameType, String message) {
        fallback("sideboard"); return null;
    }

    @Override
    public List<PaperCard> chooseCardsYouWonToAddToDeck(List<PaperCard> losses) {
        fallback("chooseCardsYouWonToAddToDeck"); return new ArrayList<>();
    }

    @Override
    public Map<Card, Integer> assignCombatDamage(Card attacker, CardCollectionView blockers, CardCollectionView remaining, int damageDealt, GameEntity defender, boolean overrideOrder) {
        fallback("assignCombatDamage"); return defaultDamageAssignment(attacker, blockers, remaining, damageDealt, defender, overrideOrder);
    }

    @Override
    public Map<GameEntity, Integer> divideShield(Card effectSource, Map<GameEntity, Integer> affected, int shieldAmount) {
        fallback("divideShield"); return affected;
    }

    @Override
    public Map<Byte, Integer> specifyManaCombo(SpellAbility sa, ColorSet colorSet, int manaAmount, boolean different) {
        fallback("specifyManaCombo"); return new HashMap<>();
    }

    @Override
    public CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        fallback("choosePermanentsToSacrifice"); return new CardCollection(firstN(validTargets, min));
    }

    @Override
    public CardCollectionView choosePermanentsToDestroy(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        fallback("choosePermanentsToDestroy"); return new CardCollection(firstN(validTargets, min));
    }

    @Override
    public Integer announceRequirements(SpellAbility ability, int min, int max, String announce) {
        fallback("announceRequirements"); return min;
    }

    @Override
    public TargetChoices chooseNewTargetsFor(SpellAbility ability, Predicate<GameObject> filter, boolean optional) {
        fallback("chooseNewTargetsFor"); return null;
    }

    @Override
    public boolean chooseTargetsFor(SpellAbility currentAbility) {
        return currentAbility.isTargetNumberValid();
    }

    @Override
    public Pair<SpellAbilityStackInstance, GameObject> chooseTarget(SpellAbility sa, List<Pair<SpellAbilityStackInstance, GameObject>> allTargets) {
        fallback("chooseTarget"); return allTargets.get(0);
    }

    @Override
    public boolean helpPayForAssistSpell(ManaCostBeingPaid cost, SpellAbility sa, int max, int requested) {
        fallback("helpPayForAssistSpell"); return false;
    }

    @Override
    public Player choosePlayerToAssistPayment(FCollectionView<Player> optionList, SpellAbility sa, String title, int max) {
        fallback("choosePlayerToAssistPayment"); return null;
    }

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title, int min, int max, boolean isOptional, Map<String, Object> params) {
        fallback("chooseCardsForEffect"); return isOptional ? CardCollection.EMPTY : new CardCollection(firstN(sourceList, min));
    }

    @Override
    public CardCollection chooseCardsForEffectMultiple(Map<String, CardCollection> validMap, SpellAbility sa, String title, boolean isOptional) {
        fallback("chooseCardsForEffectMultiple"); return new CardCollection();
    }

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal, SpellAbility sa, String title, boolean isOptional, Player relatedPlayer, Map<String, Object> params) {
        fallback("chooseSingleEntityForEffect"); return isOptional || optionList.isEmpty() ? null : optionList.get(0);
    }

    @Override
    public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> optionList, int min, int max, DelayedReveal delayedReveal, SpellAbility sa, String title, Player relatedPlayer, Map<String, Object> params) {
        fallback("chooseEntitiesForEffect"); return firstN(optionList, min);
    }

    @Override
    public List<SpellAbility> chooseSpellAbilitiesForEffect(List<SpellAbility> spells, SpellAbility sa, String title, int num, Map<String, Object> params) {
        fallback("chooseSpellAbilitiesForEffect"); return firstN(spells, num);
    }

    @Override
    public SpellAbility chooseSingleSpellForEffect(List<SpellAbility> spells, SpellAbility sa, String title, Map<String, Object> params) {
        fallback("chooseSingleSpellForEffect"); return spells.isEmpty() ? null : spells.get(0);
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options, Card cardToShow, Map<String, Object> params) {
        fallback("confirmAction"); return false;
    }

    @Override
    public boolean confirmBidAction(SpellAbility sa, PlayerActionConfirmMode bidlife, String string, int bid, Player winner) {
        fallback("confirmBidAction"); return false;
    }

    @Override
    public boolean confirmReplacementEffect(ReplacementEffect replacementEffect, SpellAbility effectSA, GameEntity affected, String question) {
        fallback("confirmReplacementEffect"); return true;
    }

    @Override
    public boolean confirmStaticApplication(Card hostCard, PlayerActionConfirmMode mode, String message, String logic) {
        fallback("confirmStaticApplication"); return true;
    }

    @Override
    public boolean confirmTrigger(WrappedAbility sa) {
        return sa.isMandatory();
    }

    @Override
    public List<Card> exertAttackers(List<Card> attackers) {
        fallback("exertAttackers"); return new ArrayList<>();
    }

    @Override
    public List<Card> enlistAttackers(List<Card> attackers) {
        fallback("enlistAttackers"); return new ArrayList<>();
    }

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        
    }

    @Override
    public CardCollection orderBlockers(Card attacker, CardCollection blockers) {
        fallback("orderBlockers"); return blockers;
    }

    @Override
    public CardCollection orderBlocker(final Card attacker, final Card blocker, final CardCollection oldBlockers) {
        fallback("orderBlocker"); CardCollection r = new CardCollection(oldBlockers); r.add(blocker); return r;
    }

    @Override
    public CardCollection orderAttackers(Card blocker, CardCollection attackers) {
        fallback("orderAttackers"); return attackers;
    }

    @Override
    public void reveal(CardCollectionView cards, ZoneType zone, Player owner, String messagePrefix, boolean addMsgSuffix) {
        
    }

    @Override
    public void reveal(List<CardView> cards, ZoneType zone, PlayerView owner, String messagePrefix, boolean addMsgSuffix) {
        
    }

    @Override
    public void notifyOfValue(SpellAbility saSource, GameObject realtedTarget, String value) {
        
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection topN) {
        fallback("arrangeForScry"); return ImmutablePair.of(topN, new CardCollection());
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection topN) {
        fallback("arrangeForSurveil"); return ImmutablePair.of(topN, new CardCollection());
    }

    @Override
    public boolean willPutCardOnTop(Card c) {
        fallback("willPutCardOnTop"); return true;
    }

    @Override
    public CardCollectionView orderMoveToZoneList(CardCollectionView cards, ZoneType destinationZone, SpellAbility source) {
        fallback("orderMoveToZoneList"); return cards;
    }

    @Override
    public CardCollectionView chooseCardsToDiscardFrom(Player playerDiscard, SpellAbility sa, CardCollection validCards, int min, int max, CardCollectionView visibleToChooser) {
        fallback("chooseCardsToDiscardFrom"); return new CardCollection(firstN(validCards, min));
    }

    @Override
    public CardCollectionView chooseCardsToDiscardUnlessType(int min, CardCollectionView hand, String[] unlessTypes, SpellAbility sa) {
        fallback("chooseCardsToDiscardUnlessType"); return new CardCollection(firstN(hand, min));
    }

    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        fallback("chooseCardsToDiscardToMaximumHandSize"); return new CardCollection(firstN(player.getCardsIn(ZoneType.Hand), numDiscard));
    }

    @Override
    public CardCollectionView chooseCardsToDelve(int genericAmount, CardCollection grave) {
        fallback("chooseCardsToDelve"); return CardCollection.EMPTY;
    }

    @Override
    public Map<Card, ManaCostShard> chooseCardsForConvokeOrImprovise(SpellAbility sa, ManaCost manaCost, CardCollectionView untappedCards, boolean artifacts, boolean creatures, Integer maxReduction) {
        fallback("chooseCardsForConvokeOrImprovise"); return new HashMap<>();
    }

    @Override
    public List<Card> chooseCardsForSplice(SpellAbility sa, List<Card> cards) {
        fallback("chooseCardsForSplice"); return new ArrayList<>();
    }

    @Override
    public CardCollectionView chooseCardsToRevealFromHand(int min, int max, CardCollectionView valid) {
        fallback("chooseCardsToRevealFromHand"); return new CardCollection(firstN(valid, min));
    }

    @Override
    public List<SpellAbility> chooseSaToActivateFromOpeningHand(List<SpellAbility> usableFromOpeningHand) {
        fallback("chooseSaToActivateFromOpeningHand"); return new ArrayList<>();
    }

    @Override
    public Player chooseStartingPlayer(boolean isFirstGame) {
        fallback("chooseStartingPlayer"); return player;
    }

    @Override
    public PlayerZone chooseStartingHand(List<PlayerZone> zones) {
        fallback("chooseStartingHand"); return zones.get(0);
    }

    @Override
    public Mana chooseManaFromPool(List<Mana> manaChoices) {
        fallback("chooseManaFromPool"); return manaChoices.get(0);
    }

    @Override
    public String chooseSomeType(String kindOfType, SpellAbility sa, Collection<String> validTypes, boolean isOptional) {
        fallback("chooseSomeType"); return isOptional || validTypes.isEmpty() ? null : validTypes.iterator().next();
    }

    @Override
    public String chooseSector(Card assignee, String ai, List<String> sectors) {
        fallback("chooseSector"); return sectors.get(0);
    }

    @Override
    public List<Card> chooseContraptionsToCrank(List<Card> contraptions) {
        fallback("chooseContraptionsToCrank"); return contraptions;
    }

    @Override
    public int chooseSprocket(Card assignee, List<Integer> sprockets) {
        fallback("chooseSprocket"); return sprockets.get(0);
    }

    @Override
    public PlanarDice choosePDRollToIgnore(List<PlanarDice> rolls) {
        fallback("choosePDRollToIgnore"); return rolls.get(0);
    }

    @Override
    public Integer chooseRollToIgnore(List<Integer> rolls) {
        fallback("chooseRollToIgnore"); return rolls.get(0);
    }

    @Override
    public List<Integer> chooseDiceToReroll(List<Integer> rolls) {
        fallback("chooseDiceToReroll"); return new ArrayList<>();
    }

    @Override
    public Integer chooseRollToModify(List<Integer> rolls) {
        fallback("chooseRollToModify"); return null;
    }

    @Override
    public RollDiceEffect.DieRollResult chooseRollToSwap(List<RollDiceEffect.DieRollResult> rolls) {
        fallback("chooseRollToSwap"); return null;
    }

    @Override
    public String chooseRollSwapValue(List<String> swapChoices, Integer currentResult, int power, int toughness) {
        fallback("chooseRollSwapValue"); return null;
    }

    @Override
    public Object vote(SpellAbility sa, String prompt, List<Object> options, ListMultimap<Object, Player> votes, Player forPlayer, boolean optional) {
        fallback("vote"); return options.get(0);
    }

    @Override
    public boolean mulliganKeepHand(Player player, int cardsToReturn) {
        fallback("mulliganKeepHand"); return true;
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
        fallback("tuckCardsViaMulligan"); return new CardCollection(firstN(hand, cardsToReturn));
    }

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        return null;
    }

    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        return PlaySpellAbility.playSpellAbility(this, player, sa);
    }

    @Override
    public List<AbilitySub> chooseModeForAbility(SpellAbility sa, List<AbilitySub> possible, int min, int num, boolean allowRepeat) {
        fallback("chooseModeForAbility"); return firstN(possible, min);
    }

    @Override
    public int chooseNumberForCostReduction(final SpellAbility sa, final int min, final int max) {
        fallback("chooseNumberForCostReduction"); return min;
    }

    @Override
    public int chooseNumberForKeywordCost(SpellAbility sa, Cost cost, KeywordInterface keyword, String prompt, int max) {
        fallback("chooseNumberForKeywordCost"); return 0;
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, int min, int max) {
        fallback("chooseNumber"); return min;
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, List<Integer> values, Player relatedPlayer) {
        fallback("chooseNumber"); return values.get(0);
    }

    @Override
    public boolean chooseBinary(SpellAbility sa, String question, BinaryChoiceType kindOfChoice, Boolean defaultChoice) {
        fallback("chooseBinary"); return defaultChoice != null ? defaultChoice : true;
    }

    @Override
    public boolean chooseFlipResult(SpellAbility sa, Player flipper, boolean call) {
        fallback("chooseFlipResult"); return call;
    }

    @Override
    public byte chooseColor(String message, SpellAbility sa, ColorSet colors) {
        fallback("chooseColor"); return colors.isColorless() ? (byte) 0 : colors.iterator().next().getColorMask();
    }

    @Override
    public byte chooseColorAllowColorless(String message, Card c, ColorSet colors) {
        fallback("chooseColorAllowColorless"); return colors.isColorless() ? (byte) 0 : colors.iterator().next().getColorMask();
    }

    @Override
    public ColorSet chooseColors(String message, SpellAbility sa, int min, int max, ColorSet options) {
        fallback("chooseColors"); return ColorSet.fromMask(0);
    }

    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, String message, Predicate<ICardFace> cpp, String name) {
        fallback("chooseSingleCardFace"); return null;
    }

    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, List<ICardFace> faces, String message) {
        fallback("chooseSingleCardFace"); return faces.get(0);
    }

    @Override
    public CardState chooseSingleCardState(SpellAbility sa, List<CardState> states, String message, Map<String, Object> params) {
        fallback("chooseSingleCardState"); return states.get(0);
    }

    @Override
    public boolean chooseCardsPile(SpellAbility sa, CardCollectionView pile1, CardCollectionView pile2, String faceUp) {
        fallback("chooseCardsPile"); return true;
    }

    @Override
    public CounterType chooseCounterType(List<CounterType> options, SpellAbility sa, String prompt, Map<String, Object> params) {
        fallback("chooseCounterType"); return options.get(0);
    }

    @Override
    public String chooseKeywordForPump(List<String> options, SpellAbility sa, String prompt, Card tgtCard) {
        fallback("chooseKeywordForPump"); return options.get(0);
    }

    @Override
    public boolean confirmPayment(CostPart costPart, String string, SpellAbility sa) {
        fallback("confirmPayment"); return true;
    }

    @Override
    public ReplacementEffect chooseSingleReplacementEffect(List<ReplacementEffect> possibleReplacers) {
        fallback("chooseSingleReplacementEffect"); return possibleReplacers.get(0);
    }

    @Override
    public StaticAbility chooseSingleStaticAbility(List<StaticAbility> possibleReplacers) {
        fallback("chooseSingleStaticAbility"); return possibleReplacers.get(0);
    }

    @Override
    public String chooseProtectionType(SpellAbility sa, List<String> choices) {
        fallback("chooseProtectionType"); return choices.get(0);
    }

    @Override
    public void revealAnte(String message, Multimap<Player, PaperCard> removedAnteCards) {
        
    }

    @Override
    public void revealAISkipCards(String message, Map<Player, Map<DeckSection, List<? extends PaperCard>>> deckCards) {
        
    }

    @Override
    public void revealUnsupported(Map<Player, List<PaperCard>> unsupported) {
        
    }

    @Override
    public List<OptionalCostValue> chooseOptionalCosts(SpellAbility choosen, List<OptionalCostValue> optionalCostValues) {
        fallback("chooseOptionalCosts"); return new ArrayList<>();
    }

    @Override
    public List<CostPart> orderCosts(List<CostPart> costs) {
        fallback("orderCosts"); return costs;
    }

    @Override
    public boolean payCostToPreventEffect(Cost cost, SpellAbility sa, boolean alreadyPaid, FCollectionView<Player> allPayers) {
        fallback("payCostToPreventEffect"); return false;
    }

    @Override
    public boolean payCostDuringRoll(Cost cost, SpellAbility sa) {
        fallback("payCostDuringRoll"); return false;
    }

    @Override
    public boolean payCombatCost(Card card, Cost cost, SpellAbility sa, String prompt) {
        fallback("payCombatCost"); return false;
    }

    @Override
    public boolean payManaCost(ManaCost toPay, CostPartMana costPartMana, SpellAbility sa, String prompt, ManaConversionMatrix matrix, boolean effect) {
        return PlaySpellAbility.payManaCost(this, toPay, costPartMana, sa, player, prompt, matrix, effect);
    }

    @Override
    public boolean applyManaToCost(ManaCostBeingPaid toPay, SpellAbility ability, String prompt, ManaConversionMatrix matrix, boolean effect) {
        return ManaPayer.pay(this, player, ability, toPay, effect);
    }

    @Override
    public CardCollectionView chooseCardsForCost(CardCollectionView optionList, SpellAbility sa, CostPartWithList cpl, int amount, boolean isOptional, String prompt) {
        fallback("chooseCardsForCost"); return isOptional ? CardCollection.EMPTY : new CardCollection(firstN(optionList, amount));
    }

    @Override
    public CostDecisionMakerBase getCostDecisionMaker(Player player, SpellAbility ability, boolean effect, String prompt) {
        return new AdapterCostDecision(this, player, ability, effect);
    }

    @Override
    public String chooseCardName(SpellAbility sa, Predicate<ICardFace> cpp, String valid, String message) {
        fallback("chooseCardName"); return null;
    }

    @Override
    public String chooseCardName(SpellAbility sa, List<ICardFace> faces, String message) {
        fallback("chooseCardName"); return faces.get(0).getName();
    }

    @Override
    public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList, DelayedReveal delayedReveal, String selectPrompt, boolean isOptional, Player decider) {
        fallback("chooseSingleCardForZoneChange"); return isOptional || fetchList.isEmpty() ? null : fetchList.get(0);
    }

    @Override
    public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList, int min, int max, DelayedReveal delayedReveal, String selectPrompt, Player decider) {
        fallback("chooseCardsForZoneChange"); return firstN(fetchList, min);
    }

    @Override
    public void autoPassCancel() {
        
    }

    @Override
    public void awaitNextInput() {
        
    }

    @Override
    public void cancelAwaitNextInput() {
        
    }
}
