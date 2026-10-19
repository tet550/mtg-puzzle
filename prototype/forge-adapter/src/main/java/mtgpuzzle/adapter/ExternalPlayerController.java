package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import forge.LobbyPlayer;
import forge.card.ColorSet;
import forge.card.MagicColor;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CounterType;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.cost.CostPart;
import forge.game.cost.CostPartWithList;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.player.Player;
import forge.game.replacement.ReplacementEffect;
import forge.game.staticability.StaticAbility;
import forge.game.spellability.AbilitySub;
import forge.game.spellability.SpellAbility;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.ZoneType;
import forge.util.collect.FCollectionView;

/**
 * p1（パズルを解く人）のコントローラー。forge-ai には依存しない。
 * 優先権・対象・攻撃宣言・任意の誘発・マナ源・コストに使うカード・効果の選択・モード・数を外部（UI）に問い合わせる。
 * それ以外の選択は BaseAdapterController の既定の答えを返し、FallbackLog に記録する。
 */
class ExternalPlayerController extends BaseAdapterController {
    /**
     * スタックが空のとき、優先権を問い合わせるステップ（自分のターンだけ）。ほかのステップでは自動でパスする。
     * スタックが空でなければ、どのステップでも問い合わせる（解決を 1 つずつ見せるため）。
     */
    static final Set<PhaseType> STOPS = EnumSet.of(PhaseType.MAIN1, PhaseType.COMBAT_DECLARE_ATTACKERS,
            PhaseType.COMBAT_DECLARE_BLOCKERS, PhaseType.MAIN2, PhaseType.END_OF_TURN);
    /** 数の選択で出す選択肢の数の上限（X の値など、上限の無い選択を区切る） */
    private static final int MAX_NUMBER_OPTIONS = 21;
    /** これ以上の max は「上限なし」とみなす（X の値は Integer.MAX_VALUE で来る） */
    private static final int UNBOUNDED = 1000;

    private final DecisionChannel channel;
    /** 「自動で支払う」が選ばれた支払い（支払い対象の SpellAbility ごと） */
    private final Map<SpellAbility, Boolean> autoPay = new IdentityHashMap<>();
    /** 最初の優先権は、どのステップでも問い合わせる（問題の開始時点） */
    private boolean askedPriority;

    ExternalPlayerController(Game game, Player p, LobbyPlayer lp, DecisionChannel channel, FallbackLog fallbackLog) {
        super(game, p, lp, fallbackLog);
        this.channel = channel;
    }

    private static int indexOf(List<Decision.Option> options, String id) {
        for (int i = 0; i < options.size(); i++) {
            if (options.get(i).id().equals(id)) {
                return i;
            }
        }
        throw new IllegalArgumentException("不明な選択肢: " + id);
    }

    private static String label(GameObject o) {
        if (o instanceof Player p) {
            return "player:" + p.getName();
        }
        Card c = (Card) o;
        return c.getName() + " (" + c.getZone().getZoneType() + ", " + c.getController().getName() + ")";
    }

    private static String id(GameObject o) {
        return o instanceof Player p ? "p" + p.getId() : "c" + ((Card) o).getId();
    }

    private static Decision.Ref ref(GameObject o) {
        return o instanceof Player p ? Decision.Ref.player(p.getName()) : Decision.Ref.card(((Card) o).getId());
    }

    private static Decision.Option option(GameObject o) {
        return new Decision.Option(id(o), label(o), ref(o));
    }

    private static Decision.Option special(String id, String label) {
        return new Decision.Option(id, label, Decision.Ref.special(id));
    }

    private static String abilityKind(SpellAbility sa) {
        if (sa.isLandAbility()) {
            return "land";
        }
        return sa.isSpell() ? "spell" : "activated";
    }

    /** 候補（カード・プレイヤー）から選ばせ、選ばれた候補を返す */
    private <T extends GameObject> List<T> chooseObjects(Decision.Kind kind, String prompt, List<T> candidates, int min, int max) {
        return chooseObjects(kind, prompt, candidates, min, max, false);
    }

    /** cancellable なら「取りやめ」も出し、選ばれたら null を返す（コストの支払いを取りやめ、唱える前に戻す） */
    private <T extends GameObject> List<T> chooseObjects(Decision.Kind kind, String prompt, List<T> candidates, int min, int max,
            boolean cancellable) {
        List<Decision.Option> options = new ArrayList<>();
        for (T o : candidates) {
            options.add(option(o));
        }
        if (cancellable) {
            options.add(special("cancel", "Cancel"));
        }
        // 「取りやめ」は選択数に数えない（ForgeSession が「取りやめ」だけの回答を範囲外でも受け付ける）
        List<String> answer = channel.ask(kind, prompt, options, min, Math.min(max, candidates.size()));
        if (answer.contains("cancel")) {
            return null;
        }
        List<T> out = new ArrayList<>();
        for (String id : answer) {
            out.add(candidates.get(indexOf(options, id)));
        }
        return out;
    }

    // ---------- 優先権 ----------

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        channel.checkHalt();
        List<SpellAbility> playable = new ArrayList<>();
        List<Decision.Option> options = new ArrayList<>();
        options.add(special("pass", "Pass priority"));
        for (Card c : getGame().getCardsInGame()) {
            for (SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
                if (sa.isManaAbility()) {
                    continue; // マナ能力は支払いのときに起動する
                }
                playable.add(sa);
                options.add(new Decision.Option("a" + (playable.size() - 1), c.getName() + " | " + sa,
                        Decision.Ref.ability(c.getId(), abilityKind(sa))));
            }
        }
        if (askedPriority && getGame().getStack().isEmpty() && !isStop()) {
            return null;
        }
        askedPriority = true;
        List<String> answer = channel.ask(Decision.Kind.PRIORITY,
                getGame().getPhaseHandler().debugPrintState(true), options, 1, 1);
        String id = answer.get(0);
        return id.equals("pass") ? null : List.of(playable.get(Integer.parseInt(id.substring(1))));
    }

    private boolean isStop() {
        return getGame().getPhaseHandler().isPlayerTurn(player) && STOPS.contains(getGame().getPhaseHandler().getPhase());
    }

    // ---------- 対象（SpellAbility.setupTargets から、対象を取る能力 1 つごとに呼ばれる） ----------

    @Override
    public boolean chooseTargetsFor(SpellAbility sa) {
        List<GameObject> candidates = targetCandidates(sa);
        if (candidates.isEmpty()) {
            return sa.isTargetNumberValid();
        }
        List<GameObject> chosen = chooseObjects(Decision.Kind.TARGETS,
                "Choose targets for " + sa.getHostCard().getName() + ": " + sa.getDescription(),
                candidates, sa.getMinTargets(), sa.getMaxTargets());
        for (GameObject o : chosen) {
            sa.getTargets().add(o);
        }
        return sa.isTargetNumberValid();
    }

    // ---------- 誘発・確認 ----------

    @Override
    public boolean confirmTrigger(WrappedAbility wrapper) {
        if (wrapper.isMandatory()) {
            return true;
        }
        return confirm("Use optional trigger? " + wrapper);
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options,
            Card cardToShow, Map<String, Object> params) {
        return confirm(message);
    }

    private boolean confirm(String prompt) {
        List<String> answer = channel.ask(Decision.Kind.CONFIRM, prompt,
                List.of(special("yes", "Yes"), special("no", "No")), 1, 1);
        return answer.get(0).equals("yes");
    }

    // ---------- 効果での選択 ----------

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title, int min,
            int max, boolean isOptional, Map<String, Object> params) {
        if (sourceList.isEmpty()) {
            return CardCollection.EMPTY;
        }
        List<Card> candidates = new ArrayList<>();
        sourceList.forEach(candidates::add);
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_ENTITY, title, candidates, isOptional ? 0 : min, max));
    }

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal,
            SpellAbility sa, String title, boolean isOptional, Player relatedPlayer, Map<String, Object> params) {
        if (optionList.isEmpty()) {
            return null;
        }
        if (optionList.size() == 1 && !isOptional) {
            return optionList.get(0);
        }
        List<T> candidates = new ArrayList<>();
        optionList.forEach(candidates::add);
        List<T> chosen = chooseObjects(Decision.Kind.CHOOSE_ENTITY, title, candidates, isOptional ? 0 : 1, 1);
        return chosen.isEmpty() ? null : chosen.get(0);
    }

    @Override
    public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> optionList, int min, int max,
            DelayedReveal delayedReveal, SpellAbility sa, String title, Player relatedPlayer, Map<String, Object> params) {
        if (optionList.isEmpty()) {
            return new ArrayList<>();
        }
        List<T> candidates = new ArrayList<>();
        optionList.forEach(candidates::add);
        return chooseObjects(Decision.Kind.CHOOSE_ENTITY, title, candidates, min, max);
    }

    @Override
    public List<AbilitySub> chooseModeForAbility(SpellAbility sa, List<AbilitySub> possible, int min, int num, boolean allowRepeat) {
        if (allowRepeat) {
            fallback("chooseModeForAbility(allowRepeat)"); // 同じモードを複数回選ぶ形には未対応
        }
        List<Decision.Option> options = new ArrayList<>();
        for (int i = 0; i < possible.size(); i++) {
            options.add(new Decision.Option("m" + i,
                    possible.get(i).getDescription().replace("CARDNAME", sa.getHostCard().getName())));
        }
        List<String> answer = channel.ask(Decision.Kind.CHOOSE_MODE, "Choose mode for " + sa.getHostCard().getName(),
                options, min, Math.min(num, possible.size()));
        List<AbilitySub> out = new ArrayList<>();
        for (Decision.Option o : options) {
            if (answer.contains(o.id())) {
                out.add(possible.get(indexOf(options, o.id())));
            }
        }
        return out;
    }

    // ---------- 色・コストの順 ----------

    /**
     * 色を選ぶ。マナ能力から呼ばれたとき（2 色以上を出せる土地など）は、ManaPayer が候補を「支払いに使える色」に
     * 絞ってから呼ばれるので、どれを出しても支払える。先頭を返し、未対応の選択として記録しない。
     * それ以外（「色を 1 つ選ぶ」効果）はプレイヤーに問い合わせる
     */
    @Override
    public byte chooseColor(String message, SpellAbility sa, ColorSet colors) {
        if (colors.isColorless()) {
            return 0;
        }
        List<Byte> options = new ArrayList<>();
        colors.iterator().forEachRemaining(c -> options.add(c.getColorMask()));
        if (options.size() == 1 || (sa != null && sa.isManaAbility())) {
            return options.get(0);
        }
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < options.size(); i++) {
            opts.add(new Decision.Option("k" + i, MagicColor.toLongString(options.get(i))));
        }
        String id = channel.ask(Decision.Kind.CHOOSE_MODE, message, opts, 1, 1).get(0);
        return options.get(Integer.parseInt(id.substring(1)));
    }

    /** 同時に当てはまる置換効果・常在型能力のうち、どれを先に適用するか */
    @Override
    public ReplacementEffect chooseSingleReplacementEffect(List<ReplacementEffect> possible) {
        return possible.size() == 1 ? possible.get(0) : possible.get(chooseIndex("Choose which replacement effect applies first", possible));
    }

    @Override
    public StaticAbility chooseSingleStaticAbility(List<StaticAbility> possible) {
        return possible.size() == 1 ? possible.get(0) : possible.get(chooseIndex("Choose which effect applies first", possible));
    }

    private int chooseIndex(String prompt, List<?> items) {
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < items.size(); i++) {
            Object it = items.get(i);
            String host = it instanceof forge.game.CardTraitBase t && t.getHostCard() != null ? t.getHostCard().getName() + ": " : "";
            opts.add(new Decision.Option("k" + i, host + it));
        }
        return Integer.parseInt(channel.ask(Decision.Kind.CHOOSE_MODE, prompt, opts, 1, 1).get(0).substring(1));
    }

    /**
     * 戦闘ダメージの割り振り。選ぶ余地が無いとき（ブロッカーが 1 体以下でトランプルでない）はそのまま。
     * トランプルでブロッカーが 1 体なら、致死量をブロッカーに、残りを防御側に割り振る（パズルではふつう最善）。
     * ブロッカーが 2 体以上のときは、決まった順に致死量を割り振り、未対応の選択として記録する
     */
    @Override
    public Map<Card, Integer> assignCombatDamage(Card attacker, CardCollectionView blockers, CardCollectionView remaining,
            int damageDealt, GameEntity defender, boolean overrideOrder) {
        if (!damageAssignmentIsChoice(attacker, blockers, defender)) {
            return trivialDamageAssignment(blockers, damageDealt);
        }
        if (blockers.size() == 1) {
            return defaultDamageAssignment(attacker, blockers, remaining, damageDealt, defender, overrideOrder);
        }
        // ブロッカーが 2 体以上: ブロッカーごとに何点与えるかを順に聞く。トランプルなら、各ブロッカーに致死ダメージを
        // 与えた残りを防御側に通せる（致死ダメージ未満しか与えないなら、残りは最後のブロッカーへ）
        boolean trample = attacker.hasKeyword(forge.game.keyword.Keyword.TRAMPLE) && defender != null;
        Map<Card, Integer> map = new java.util.HashMap<>();
        int left = damageDealt;
        List<Card> list = new ArrayList<>();
        blockers.forEach(list::add);
        boolean allLethal = true;
        for (int i = 0; i < list.size(); i++) {
            Card b = list.get(i);
            boolean last = i == list.size() - 1;
            int lethal = Math.max(0, b.getLethalDamage());
            if (left == 0) {
                break;
            }
            if (last && !trample) {
                map.merge(b, left, Integer::sum);
                left = 0;
                break;
            }
            int v = chooseNumberIn("Assign combat damage from " + attacker.getName() + " to " + b.getName()
                    + " (lethal " + lethal + ", " + left + " left)", 0, left);
            if (v > 0) {
                map.put(b, v);
            }
            allLethal &= v >= lethal;
            left -= v;
        }
        if (left > 0) {
            if (trample && allLethal) {
                map.put(null, left); // 防御側のプレイヤー／プレインズウォーカーへ
            } else {
                map.merge(list.get(list.size() - 1), left, Integer::sum);
            }
        }
        return map;
    }

    /** 同時に同じ領域へ移るカードの順（墓地に置く順など）。並びのままでよい */
    @Override
    public CardCollectionView orderMoveToZoneList(CardCollectionView cards, ZoneType destinationZone, SpellAbility source) {
        return cards;
    }

    /** 効果で領域を移すカードを 1 枚選ぶ（墓地・追放・ライブラリーから手札へ、など） */
    @Override
    public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList,
            DelayedReveal delayedReveal, String selectPrompt, boolean isOptional, Player decider) {
        if (fetchList.isEmpty()) {
            return null;
        }
        if (fetchList.size() == 1 && !isOptional) {
            return fetchList.getFirst();
        }
        List<Card> candidates = new ArrayList<>();
        fetchList.forEach(candidates::add);
        List<Card> chosen = chooseObjects(Decision.Kind.CHOOSE_ENTITY,
                selectPrompt == null || selectPrompt.isBlank() ? "Choose a card to move to " + destination : selectPrompt,
                candidates, isOptional ? 0 : 1, 1);
        return chosen.isEmpty() ? null : chosen.get(0);
    }

    // ---------- 効果での選択（生け贄・捨てる・二択・カウンターの種類・プロテクション） ----------

    @Override
    public CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        List<Card> candidates = new ArrayList<>();
        validTargets.forEach(candidates::add);
        if (candidates.size() <= min) {
            return new CardCollection(candidates); // 選ぶ余地が無い
        }
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_ENTITY,
                message == null || message.isBlank() ? "Choose permanents to sacrifice" : message, candidates, min, max));
    }

    /** クリンナップで手札の上限まで捨てる */
    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        List<Card> hand = new ArrayList<>();
        player.getCardsIn(ZoneType.Hand).forEach(hand::add);
        if (hand.size() <= numDiscard) {
            return new CardCollection(hand);
        }
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_ENTITY, "Discard " + numDiscard + " card(s) to your maximum hand size",
                hand, numDiscard, numDiscard));
    }

    /** 二択（表か裏か、タップかアンタップか、など） */
    @Override
    public boolean chooseBinary(SpellAbility sa, String question, BinaryChoiceType kindOfChoice, Boolean defaultChoice) {
        String[] labels = switch (kindOfChoice) {
            case HeadsOrTails -> new String[]{"Heads", "Tails"};
            case TapOrUntap -> new String[]{"Tap", "Untap"};
            case PlayOrDraw -> new String[]{"Play", "Draw"};
            case OddsOrEvens -> new String[]{"Odds", "Evens"};
            case UntapOrLeaveTapped -> new String[]{"Untap", "Leave tapped"};
            case LeftOrRight -> new String[]{"Left", "Right"};
            case AddOrRemove -> new String[]{"Add", "Remove"};
            case IncreaseOrDecrease -> new String[]{"Increase", "Decrease"};
        };
        String id = channel.ask(Decision.Kind.CHOOSE_MODE, question,
                List.of(new Decision.Option("k0", labels[0]), new Decision.Option("k1", labels[1])), 1, 1).get(0);
        return id.equals("k0");
    }

    @Override
    public CounterType chooseCounterType(List<CounterType> options, SpellAbility sa, String prompt, Map<String, Object> params) {
        if (options.size() == 1) {
            return options.get(0);
        }
        return options.get(chooseIndex(prompt == null || prompt.isBlank() ? "Choose a counter type" : prompt, options));
    }

    @Override
    public String chooseProtectionType(SpellAbility sa, List<String> choices) {
        if (choices.size() == 1) {
            return choices.get(0);
        }
        return choices.get(chooseIndex("Choose a protection", choices));
    }

    /** コストを払う順（マナと、タップ・生け贄などの順）。並びのままでよい（人間用の画面でも既定の順で払う） */
    @Override
    public List<CostPart> orderCosts(List<CostPart> costs) {
        return costs;
    }

    // ---------- 数 ----------

    @Override
    public Integer announceRequirements(SpellAbility ability, int min, int max, String announce) {
        return chooseNumberIn("Announce " + announce + " for " + ability.getHostCard().getName(), min, max);
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, int min, int max) {
        return chooseNumberIn(title, min, max);
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, List<Integer> values, Player relatedPlayer) {
        List<Decision.Option> options = new ArrayList<>();
        for (Integer v : values) {
            options.add(new Decision.Option("n" + v, String.valueOf(v)));
        }
        return Integer.parseInt(channel.ask(Decision.Kind.CHOOSE_NUMBER, title, options, 1, 1).get(0).substring(1));
    }

    private int chooseNumberIn(String title, int min, int max) {
        int hi = max;
        if ((long) max - min + 1 > MAX_NUMBER_OPTIONS) {
            hi = min + MAX_NUMBER_OPTIONS - 1;
            if (max < UNBOUNDED) {
                fallback("chooseNumber(range " + min + ".." + max + " truncated to " + hi + ")");
            }
        }
        List<Decision.Option> options = new ArrayList<>();
        for (int v = min; v <= hi; v++) {
            options.add(new Decision.Option("n" + v, String.valueOf(v)));
        }
        return Integer.parseInt(channel.ask(Decision.Kind.CHOOSE_NUMBER, title, options, 1, 1).get(0).substring(1));
    }

    // ---------- 戦闘 ----------

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        GameEntity defender = combat.getDefenders().stream().filter(d -> d instanceof Player).findFirst()
                .orElse(combat.getDefenders().getFirst());
        List<Card> able = new ArrayList<>();
        for (Card c : attacker.getCreaturesInPlay()) {
            if (CombatUtil.canAttack(c, defender)) {
                able.add(c);
            }
        }
        if (able.isEmpty()) {
            return;
        }
        List<Decision.Option> options = new ArrayList<>();
        for (Card c : able) {
            options.add(new Decision.Option("c" + c.getId(), c.getName(), Decision.Ref.card(c.getId())));
        }
        List<String> answer = channel.ask(Decision.Kind.ATTACKERS, "Declare attackers (defender: " + defender + ")",
                options, 0, able.size());
        for (String id : answer) {
            combat.addAttacker(able.get(indexOf(options, id)), defender);
        }
    }

    // ---------- 支払い ----------

    @Override
    protected ManaPayer.Source chooseManaSource(SpellAbility saPaidFor, String remaining, List<ManaPayer.Source> sources) {
        if (autoPay.containsKey(saPaidFor)) {
            return sources.get(0);
        }
        List<Decision.Option> options = new ArrayList<>();
        options.add(special("auto", "Auto pay"));
        for (int i = 0; i < sources.size(); i++) {
            options.add(new Decision.Option("m" + i, sources.get(i).label(), Decision.Ref.card(sources.get(i).ability().getHostCard().getId())));
        }
        options.add(special("cancel", "Cancel"));
        String id = channel.ask(Decision.Kind.PAY_MANA, "Pay " + remaining + " for " + saPaidFor.getHostCard().getName(),
                options, 1, 1).get(0);
        if (id.equals("cancel")) {
            return null;
        }
        if (id.equals("auto")) {
            autoPay.put(saPaidFor, Boolean.TRUE);
            return sources.get(0);
        }
        return sources.get(Integer.parseInt(id.substring(1)));
    }

    /** 搭乗など: 候補から 1 体以上を選ばせる。パワーの合計が足りなければ支払いを取りやめる（呼び出し側が確かめる） */
    @Override
    protected CardCollectionView chooseCardsForTotalPower(CardCollectionView candidates, SpellAbility sa, CostPartWithList cost, int need) {
        List<Card> list = new ArrayList<>();
        candidates.forEach(list::add);
        List<Card> chosen = chooseObjects(Decision.Kind.CHOOSE_CARDS,
                "Tap creatures with total power " + need + " or greater (" + sa.getHostCard().getName() + ")", list, 1, list.size(), true);
        return chosen == null ? null : new CardCollection(chosen);
    }

    @Override
    public CardCollectionView chooseCardsForCost(CardCollectionView optionList, SpellAbility sa, CostPartWithList cpl,
            int amount, boolean isOptional, String prompt) {
        List<Card> candidates = new ArrayList<>();
        optionList.forEach(candidates::add);
        List<Card> chosen = chooseObjects(Decision.Kind.CHOOSE_CARDS, "Pay cost: " + prompt, candidates, isOptional ? 0 : amount, amount, true);
        return chosen == null ? null : new CardCollection(chosen);
    }
}
