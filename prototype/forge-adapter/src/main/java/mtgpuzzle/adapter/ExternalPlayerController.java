package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

import com.google.common.collect.ListMultimap;
import org.apache.commons.lang3.tuple.ImmutablePair;
import org.apache.commons.lang3.tuple.Pair;

import forge.LobbyPlayer;
import forge.StaticData;
import forge.card.ColorSet;
import forge.card.ICardFace;
import forge.card.MagicColor;
import forge.card.mana.ManaCost;
import forge.card.mana.ManaCostShard;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CardState;
import forge.game.card.CounterType;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.cost.Cost;
import forge.game.cost.CostPart;
import forge.game.cost.CostPartWithList;
import forge.game.keyword.KeywordInterface;
import forge.game.mana.Mana;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.PlaySpellAbility;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.replacement.ReplacementEffect;
import forge.game.spellability.AbilityManaPart;
import forge.game.spellability.AbilitySub;
import forge.game.spellability.OptionalCostValue;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.spellability.TargetChoices;
import forge.game.staticability.StaticAbility;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.ZoneType;
import forge.util.ITriggerEvent;
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
    /** カード名・サブタイプの選択で出す候補の上限 */
    private static final int MAX_TYPE_OPTIONS = 30;

    private final DecisionChannel channel;
    /** 「自動で支払う」が選ばれた支払い（支払い対象の SpellAbility ごと） */
    private final Map<SpellAbility, Boolean> autoPay = new IdentityHashMap<>();
    /** 最初の優先権は、どのステップでも問い合わせる（問題の開始時点） */
    private boolean askedPriority;
    /** 優先権でマナ能力を起動した。マナ能力はスタックを使わず優先権が戻るので、次も問い合わせる */
    private boolean keepPriority;
    /** 優先権で起動したマナ能力。これが出すマナの色はプレイヤーに問い合わせる（支払いのときは ManaPayer が色を絞る） */
    private SpellAbility manaFromPriority;
    /** 優先権の選択肢で先に選んだマナの色（色ごとの選択肢。無ければ 0）。playChosenSpellAbility で使う */
    private byte presetColor;

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
        if (o instanceof SpellAbility sa) {
            return sa.getHostCard().getName() + " (" + sa.getStackDescription() + ")";
        }
        Card c = (Card) o;
        return c.getName() + " (" + c.getZone().getZoneType() + ", " + c.getController().getName() + ")";
    }

    private static String id(GameObject o) {
        if (o instanceof Player p) {
            return "p" + p.getId();
        }
        if (o instanceof SpellAbility sa) {
            return "s" + sa.getId();
        }
        return "c" + ((Card) o).getId();
    }

    private static Decision.Ref ref(GameObject o) {
        if (o instanceof Player p) {
            return Decision.Ref.player(p.getName());
        }
        if (o instanceof SpellAbility sa) {
            return Decision.Ref.card(sa.getHostCard().getId());
        }
        return Decision.Ref.card(((Card) o).getId());
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
        if (sa.isManaAbility()) {
            return "mana";
        }
        return sa.isSpell() ? "spell" : "activated";
    }

    /** 候補（カード・プレイヤー・スタック上の呪文や能力）から選ばせ、選ばれた候補を返す */
    private <T extends GameObject> List<T> chooseObjects(Decision.Kind kind, String prompt, List<T> candidates, int min, int max) {
        return chooseObjects(kind, Decision.Prompt.text(prompt), candidates, min, max, false);
    }

    private <T extends GameObject> List<T> chooseObjects(Decision.Kind kind, Decision.Prompt prompt, List<T> candidates, int min, int max) {
        return chooseObjects(kind, prompt, candidates, min, max, false);
    }

    /** cancellable なら「取りやめ」も出し、選ばれたら null を返す（コストの支払いを取りやめ、唱える前に戻す） */
    private <T extends GameObject> List<T> chooseObjects(Decision.Kind kind, Decision.Prompt prompt, List<T> candidates, int min, int max,
            boolean cancellable) {
        List<Decision.Option> options = new ArrayList<>();
        for (T o : candidates) {
            options.add(option(o));
        }
        if (cancellable) {
            options.add(special("cancel", "Cancel"));
        }
        // 「取りやめ」は選択数に数えない（ForgeSession が「取りやめ」だけの回答を範囲外でも受け付ける）
        int effectiveMax = Math.min(max, candidates.size());
        int effectiveMin = Math.min(min, effectiveMax);
        List<String> answer = channel.ask(kind, prompt, options, effectiveMin, effectiveMax);
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
        List<Byte> presets = new ArrayList<>(); // playable と同じ並び。マナ能力で先に選んだ色（無ければ 0）
        List<Decision.Option> options = new ArrayList<>();
        options.add(special("pass", "Pass priority"));
        for (Card c : getGame().getCardsInGame()) {
            // マナ能力も選べる（先にマナを出しておく・生け贄などの副作用を使う）。支払いのときにも PAY_MANA で起動できる
            for (SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
                String ja = Ja.with(sa::toString);
                // 1 色を選んで出すマナ能力は、色ごとの選択肢にする（画面はメニューで色を選んでから起動する。選ぶまでは取りやめられる）
                List<Byte> colors = sa.isManaAbility() ? presetColors(sa) : List.of();
                for (byte color : colors.isEmpty() ? List.of((byte) 0) : colors) {
                    playable.add(sa);
                    presets.add(color);
                    String suffix = color == 0 ? "" : " [" + MagicColor.toShortString(color) + "]";
                    options.add(new Decision.Option("a" + (playable.size() - 1), c.getName() + " | " + sa + suffix,
                            color == 0 ? Decision.Ref.ability(c.getId(), abilityKind(sa)) : Decision.Ref.mana(c.getId(), MagicColor.toShortString(color)),
                            ja == null ? null : Ja.name(c.getName()) + " | " + ja + suffix));
                }
            }
        }
        if (askedPriority && !keepPriority && getGame().getStack().isEmpty() && !isStop()) {
            return null;
        }
        askedPriority = true;
        List<String> answer = channel.ask(Decision.Kind.PRIORITY,
                Decision.Prompt.of(getGame().getPhaseHandler().debugPrintState(true), "priority"), options, 1, 1);
        String id = answer.get(0);
        int index = id.equals("pass") ? -1 : Integer.parseInt(id.substring(1));
        SpellAbility chosen = index < 0 ? null : playable.get(index);
        keepPriority = chosen != null && chosen.isManaAbility();
        presetColor = index < 0 ? 0 : presets.get(index);
        return chosen == null ? null : List.of(chosen);
    }

    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        manaFromPriority = sa.isManaAbility() ? sa : null;
        if (sa.isManaAbility()) {
            // 前に支払いで使ったときの色が残っていると、聞かずにその色を出してしまう
            sa.getAllManaParts().forEach(AbilityManaPart::clearExpressChoice);
            if (presetColor != 0) {
                sa.setManaExpressChoice(ColorSet.fromMask(presetColor)); // 色の候補が 1 つになり、chooseColor は聞かずに返す
            }
        }
        presetColor = 0;
        try {
            return super.playChosenSpellAbility(sa);
        } finally {
            manaFromPriority = null;
        }
    }

    /**
     * 先に色を選べるマナ能力なら、出せる色（2 色以上）。そうでなければ空。
     * 1 回の選択で 1 色に決まるもの（好きな色 1 色・{U} か {B}・好きな色 1 色の X 点）に限る。
     * 色の組み合わせ・違う色・特殊なマナ・ほかのプレイヤーが選ぶものは、起動のあとに問い合わせる
     */
    private static List<Byte> presetColors(SpellAbility sa) {
        if (sa.getAllManaParts().size() != 1 || sa.hasParam("Chooser")) {
            return List.of();
        }
        AbilityManaPart mp = sa.getManaPart();
        // ManaEffect と同じ順に見る（"Combo AnyDifferent" は isAnyMana でもあるが、組み合わせとして扱われる）
        boolean single = mp.isComboMana()
                ? !mp.getOrigProduced().contains("Different") && (!sa.hasParam("Amount") || sa.getParam("Amount").equals("1")) && !sa.hasParam("Each")
                : mp.isAnyMana();
        if (mp.isSpecialMana() || !single) {
            return List.of();
        }
        List<Byte> out = new ArrayList<>();
        for (byte color : MagicColor.WUBRG) {
            if (sa.canProduce(MagicColor.toShortString(color))) {
                out.add(color);
            }
        }
        return out.size() >= 2 ? out : List.of();
    }

    /** 優先権で起動したマナ能力から呼ばれたとき（支払いの外）は、色を問い合わせる */
    private boolean asksManaColor(SpellAbility sa) {
        return sa == null || !sa.isManaAbility() || (manaFromPriority != null && sa.getRootAbility() == manaFromPriority);
    }

    private boolean isStop() {
        return getGame().getPhaseHandler().isPlayerTurn(player) && STOPS.contains(getGame().getPhaseHandler().getPhase());
    }

    @Override
    public SpellAbility getAbilityToPlay(Card hostCard, List<SpellAbility> abilities, ITriggerEvent triggerEvent) {
        if (abilities.isEmpty()) {
            return null;
        }
        if (abilities.size() == 1) {
            return abilities.get(0);
        }
        return abilities.get(chooseIndex(Decision.Prompt.text(hostCard.getName()), abilities));
    }

    // ---------- 対象（SpellAbility.setupTargets から、対象を取る能力 1 つごとに呼ばれる） ----------

    @Override
    public boolean chooseTargetsFor(SpellAbility sa) {
        List<GameObject> candidates = targetCandidates(sa);
        if (candidates.isEmpty()) {
            return sa.isTargetNumberValid();
        }
        boolean divided = sa.isDividedAsYouChoose();
        int max = divided ? Math.min(sa.getMaxTargets(), sa.getStillToDivide()) : sa.getMaxTargets();
        List<GameObject> chosen = chooseObjects(Decision.Kind.TARGETS,
                Decision.Prompt.of("Choose targets for " + sa.getHostCard().getName() + ": " + sa.getDescription(), "targets",
                        "card", sa.getHostCard().getName(), "desc", sa.getDescription(),
                        "descJa", Ja.description(sa.getDescription(), sa.getHostCard())).withSource(sa.getHostCard().getId()),
                candidates, sa.getMinTargets(), max);
        for (GameObject o : chosen) {
            sa.getTargets().add(o);
        }
        if (divided && !chosen.isEmpty() && sa.getStillToDivide() > 0) {
            int left = sa.getStillToDivide();
            if (sa.hasParam("DividedUpTo") && chosen.size() < left) {
                left = chooseNumberIn(Decision.Prompt.text("How many to divide?"), chosen.size(), left);
            }
            for (int i = 0; i < chosen.size(); i++) {
                GameObject t = chosen.get(i);
                int rem = chosen.size() - 1 - i;
                int v;
                if (rem == 0) {
                    v = left;
                } else if (left - rem <= 1) {
                    v = 1;
                } else {
                    String to = t instanceof Card c ? c.getName() : label(t);
                    v = chooseNumberIn(Decision.Prompt.of(
                            "Divide for " + sa.getHostCard().getName() + " to " + to + " (" + left + " left)",
                            "divide", "card", sa.getHostCard().getName(), "to", to, "left", String.valueOf(left)), 1, left - rem);
                }
                sa.addDividedAllocation(t, v);
                left -= v;
            }
        }
        return sa.isTargetNumberValid();
    }

    @Override
    public TargetChoices chooseNewTargetsFor(SpellAbility ability, Predicate<GameObject> filter, boolean optional) {
        TargetChoices old = ability.getTargets();
        TargetChoices next = new TargetChoices();
        ability.setTargets(next);
        List<GameObject> candidates = new ArrayList<>();
        for (GameObject o : targetCandidates(ability)) {
            if (filter == null || filter.test(o)) {
                candidates.add(o);
            }
        }
        if (candidates.isEmpty()) {
            ability.setTargets(old);
            return null;
        }
        int min = optional ? 0 : Math.min(ability.getMinTargets(), candidates.size());
        int max = Math.min(ability.getMaxTargets(), candidates.size());
        List<GameObject> chosen = chooseObjects(Decision.Kind.TARGETS,
                Decision.Prompt.of("Choose new targets for " + ability.getHostCard().getName() + ": " + ability.getDescription(), "targets",
                        "card", ability.getHostCard().getName(), "desc", ability.getDescription(),
                        "descJa", Ja.description(ability.getDescription(), ability.getHostCard())).withSource(ability.getHostCard().getId()),
                candidates, min, max);
        if (chosen.isEmpty()) {
            ability.setTargets(old);
            return null;
        }
        for (GameObject o : chosen) {
            next.add(o);
        }
        return next;
    }

    @Override
    public Pair<SpellAbilityStackInstance, GameObject> chooseTarget(SpellAbility sa,
            List<Pair<SpellAbilityStackInstance, GameObject>> allTargets) {
        if (allTargets.size() <= 1) {
            return allTargets.get(0);
        }
        List<String> labels = new ArrayList<>();
        for (Pair<SpellAbilityStackInstance, GameObject> pair : allTargets) {
            labels.add(pair.getRight().toString() + " - " + pair.getLeft().getStackDescription());
        }
        return allTargets.get(chooseIndex(Decision.Prompt.text(sa.getHostCard().getName()), labels));
    }

    // ---------- 誘発・確認 ----------

    @Override
    public boolean confirmTrigger(WrappedAbility wrapper) {
        if (wrapper.isMandatory()) {
            return true;
        }
        String desc = wrapper.toString();
        return confirm(Decision.Prompt.of("Use optional trigger? " + desc, "optionalTrigger", "desc", desc,
                "descJa", Ja.with(wrapper::toString)));
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options,
            Card cardToShow, Map<String, Object> params) {
        return confirm(Decision.Prompt.text(message));
    }

    @Override
    public boolean confirmPayment(CostPart costPart, String message, SpellAbility sa) {
        return confirm(Decision.Prompt.text(message == null || message.isBlank() ? costPart.toString() : message));
    }

    @Override
    public boolean confirmReplacementEffect(ReplacementEffect replacementEffect, SpellAbility effectSA, GameEntity affected, String question) {
        return confirm(Decision.Prompt.text(question == null || question.isBlank() ? replacementEffect.toString() : question));
    }

    @Override
    public boolean confirmStaticApplication(Card hostCard, PlayerActionConfirmMode mode, String message, String logic) {
        return confirm(Decision.Prompt.text(message == null || message.isBlank() ? hostCard.getName() : message));
    }

    @Override
    public boolean confirmBidAction(SpellAbility sa, PlayerActionConfirmMode bidlife, String message, int bid, Player winner) {
        return confirm(Decision.Prompt.text(message));
    }

    private boolean confirm(Decision.Prompt prompt) {
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
    public CardCollection chooseCardsForEffectMultiple(Map<String, CardCollection> validMap, SpellAbility sa, String title, boolean isOptional) {
        CardCollection chosen = new CardCollection();
        for (Map.Entry<String, CardCollection> entry : validMap.entrySet()) {
            CardCollection list = entry.getValue();
            if (list.isEmpty()) {
                continue;
            }
            CardCollectionView picked = chooseCardsForEffect(list, sa, title + " (" + entry.getKey() + ")", 1, 1, isOptional, null);
            chosen.addAll(picked);
        }
        return chosen;
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
    public SpellAbility chooseSingleSpellForEffect(List<SpellAbility> spells, SpellAbility sa, String title, Map<String, Object> params) {
        if (spells.isEmpty()) {
            return null;
        }
        if (spells.size() == 1) {
            return spells.get(0);
        }
        return spells.get(chooseIndex(Decision.Prompt.text(title), spells));
    }

    @Override
    public List<SpellAbility> chooseSpellAbilitiesForEffect(List<SpellAbility> spells, SpellAbility sa, String title, int num,
            Map<String, Object> params) {
        if (spells.isEmpty() || num <= 0) {
            return List.of();
        }
        if (spells.size() <= num) {
            return new ArrayList<>(spells);
        }
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < spells.size(); i++) {
            SpellAbility sp = spells.get(i);
            Card host = sp.getHostCard();
            String label = (host != null ? host.getName() + ": " : "") + sp;
            String ja = host != null && Ja.available() ? Ja.name(host.getName()) + ": " + Ja.description(sp.toString(), host) : null;
            opts.add(new Decision.Option("k" + i, label, host != null ? Decision.Ref.card(host.getId()) : null, ja));
        }
        List<String> ans = channel.ask(Decision.Kind.CHOOSE_MODE, Decision.Prompt.text(title), opts, num, num);
        List<SpellAbility> out = new ArrayList<>();
        for (String id : ans) {
            out.add(spells.get(Integer.parseInt(id.substring(1))));
        }
        return out;
    }

    private static List<Decision.Option> modeOptions(SpellAbility sa, List<AbilitySub> possible) {
        List<Decision.Option> options = new ArrayList<>();
        for (int i = 0; i < possible.size(); i++) {
            AbilitySub sub = possible.get(i);
            String desc = sub.getDescription();
            String prefix = "";
            if (sub.hasParam("Pawprint")) {
                int paw = AbilityUtils.calculateAmount(sub.getHostCard(), sub.getParam("Pawprint"), sub);
                if (paw > 0) {
                    prefix = "{P}".repeat(paw) + " \u2014 ";
                }
            }
            String fullDesc = prefix + desc;
            String ja = null;
            if (Ja.available()) {
                ja = Ja.description(fullDesc, sa.getHostCard()).replaceFirst("^[・•]\\s*", "");
                if (ja.equals(fullDesc.replace("CARDNAME", Ja.name(sa.getHostCard().getName()))) && !prefix.isEmpty()) {
                    String subJa = Ja.description(desc, sa.getHostCard()).replaceFirst("^[・•]\\s*", "");
                    ja = subJa.startsWith("{P}") ? subJa : prefix + subJa;
                } else if (!prefix.isEmpty() && !ja.startsWith("{P}")) {
                    ja = prefix + ja;
                }
            }
            options.add(new Decision.Option("m" + i, fullDesc.replace("CARDNAME", sa.getHostCard().getName()), null, ja)); // 訳の箇条書きの「・」は外す
        }
        return options;
    }

    @Override
    public List<AbilitySub> chooseModeForAbility(SpellAbility sa, List<AbilitySub> possible, int min, int num, boolean allowRepeat) {
        boolean pawprint = sa.hasParam("Pawprint");
        Decision.Prompt prompt = Decision.Prompt.of("Choose mode for " + sa.getHostCard().getName(), "mode", "card", sa.getHostCard().getName())
                .withSource(sa.getHostCard().getId());
        if (!allowRepeat && !pawprint) {
            List<Decision.Option> options = modeOptions(sa, possible);
            List<String> answer = channel.ask(Decision.Kind.CHOOSE_MODE,
                    prompt,
                    options, min, Math.min(num, possible.size()));
            List<AbilitySub> out = new ArrayList<>();
            for (Decision.Option o : options) {
                if (answer.contains(o.id())) {
                    out.add(possible.get(indexOf(options, o.id())));
                }
            }
            return out;
        }
        List<AbilitySub> out = new ArrayList<>();
        List<AbilitySub> rem = new ArrayList<>(possible);
        int chosenPawprint = 0;
        for (int i = 0; i < num; i++) {
            if (pawprint) {
                int budget = num - chosenPawprint;
                rem.removeIf(ab -> AbilityUtils.calculateAmount(ab.getHostCard(), ab.getParam("Pawprint"), ab) > budget);
            }
            if (rem.isEmpty()) {
                break;
            }
            List<Decision.Option> options = modeOptions(sa, rem);
            int reqMin = i < min ? 1 : 0;
            List<String> answer = channel.ask(Decision.Kind.CHOOSE_MODE,
                    prompt,
                    options, reqMin, 1);
            if (answer.isEmpty()) {
                break;
            }
            AbilitySub picked = rem.get(indexOf(options, answer.get(0)));
            out.add(picked);
            if (!allowRepeat) {
                rem.remove(picked);
            }
            if (pawprint) {
                chosenPawprint += AbilityUtils.calculateAmount(picked.getHostCard(), picked.getParam("Pawprint"), picked);
            }
        }
        return out;
    }

    // ---------- 色・コストの順 ----------

    /** マナプールから取り出すマナ（PlayerControllerHuman と同じく先頭を返し、未対応として記録しない） */
    @Override
    public Mana chooseManaFromPool(List<Mana> manaChoices) {
        return manaChoices.get(0);
    }

    /**
     * 色を選ぶ。支払いの中でマナ能力から呼ばれたとき（2 色以上を出せる土地など）は、ManaPayer が候補を「支払いに使える色」に
     * 絞ってから呼ばれるので、どれを出しても支払える。先頭を返し、未対応の選択として記録しない。
     * それ以外（「色を 1 つ選ぶ」効果、優先権で起動したマナ能力）はプレイヤーに問い合わせる
     */
    @Override
    public byte chooseColor(String message, SpellAbility sa, ColorSet colors) {
        if (colors.isColorless()) {
            return 0;
        }
        List<Byte> options = new ArrayList<>();
        colors.iterator().forEachRemaining(c -> options.add(c.getColorMask()));
        if (options.size() == 1 || !asksManaColor(sa)) {
            return options.get(0);
        }
        return askColor(message, sa, options, 0, 0);
    }

    @Override
    public byte chooseColorAllowColorless(String message, Card c, ColorSet colors) {
        List<Byte> options = new ArrayList<>();
        options.add(MagicColor.COLORLESS);
        for (byte col : MagicColor.WUBRG) {
            if (colors.hasAnyColor(col)) {
                options.add(col);
            }
        }
        if (options.size() <= 1) {
            return options.get(0);
        }
        int hostId = c == null ? -1 : c.getId();
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < options.size(); i++) {
            byte col = options.get(i);
            String name = MagicColor.toLongString(col);
            opts.add(new Decision.Option("k" + i, name, Decision.Ref.color(hostId, MagicColor.toShortString(col)), COLOR_JA.get(name)));
        }
        Decision.Prompt prompt = Decision.Prompt.of(message, "color", "card", c == null ? null : c.getName());
        String id = channel.ask(Decision.Kind.CHOOSE_MODE, prompt, opts, 1, 1).get(0);
        return options.get(Integer.parseInt(id.substring(1)));
    }

    @Override
    public ColorSet chooseColors(String message, SpellAbility sa, int min, int max, ColorSet options) {
        List<Byte> colors = new ArrayList<>();
        for (byte c : MagicColor.WUBRG) {
            if (options.hasAnyColor(c)) {
                colors.add(c);
            }
        }
        if (colors.isEmpty()) {
            return ColorSet.fromMask(0);
        }
        Card host = sa == null ? null : sa.getHostCard();
        int hostId = host == null ? -1 : host.getId();
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < colors.size(); i++) {
            String name = MagicColor.toLongString(colors.get(i));
            opts.add(new Decision.Option("k" + i, name, Decision.Ref.color(hostId, MagicColor.toShortString(colors.get(i))), COLOR_JA.get(name)));
        }
        Decision.Prompt prompt = Decision.Prompt.of(message, "color", "card", host == null ? null : host.getName());
        List<String> answer = channel.ask(Decision.Kind.CHOOSE_MODE, prompt, opts,
                Math.min(min, opts.size()), Math.min(max, opts.size()));
        byte mask = 0;
        for (String id : answer) {
            mask |= colors.get(Integer.parseInt(id.substring(1)));
        }
        return ColorSet.fromMask(mask);
    }

    /**
     * 色を問い合わせる。選択肢の ref は色と、能力の持ち主のカード（画面はそのカードの上で色を選ばせる）。
     * 取りやめはできない（コストは払い済み、または効果の解決中）。n / of は何点目か（マナの組み合わせ。0 なら出さない）
     */
    private byte askColor(String message, SpellAbility sa, List<Byte> unordered, int n, int of) {
        List<Byte> colors = new ArrayList<>(); // いつも W U B R G の順に出す（ColorSet の並びは色を除いたあとで変わる）
        for (byte c : MagicColor.WUBRG) {
            if (unordered.contains(c)) {
                colors.add(c);
            }
        }
        Card host = sa == null ? null : sa.getHostCard();
        int hostId = host == null ? -1 : host.getId();
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < colors.size(); i++) {
            String name = MagicColor.toLongString(colors.get(i));
            opts.add(new Decision.Option("k" + i, name, Decision.Ref.color(hostId, MagicColor.toShortString(colors.get(i))), COLOR_JA.get(name)));
        }
        Decision.Prompt prompt = Decision.Prompt.of(message, "color", "card", host == null ? null : host.getName(),
                "n", n == 0 ? null : String.valueOf(n), "of", of == 0 ? null : String.valueOf(of));
        String id = channel.ask(Decision.Kind.CHOOSE_MODE, prompt, opts, 1, 1).get(0);
        return colors.get(Integer.parseInt(id.substring(1)));
    }

    /**
     * 2 つ以上のマナの色の組み合わせ（「好きな色の組み合わせのマナ 2 点」など）。支払いでは ManaPayer が色を決めるので、
     * 呼ばれるのは優先権で起動したときだけ。1 点ずつ色を問い合わせる（different なら選んだ色は候補から外す）
     */
    @Override
    public Map<Byte, Integer> specifyManaCombo(SpellAbility sa, ColorSet colorSet, int manaAmount, boolean different) {
        Map<Byte, Integer> out = new LinkedHashMap<>();
        ColorSet left = colorSet;
        for (int i = 0; i < manaAmount && !left.isColorless(); i++) {
            List<Byte> colors = new ArrayList<>();
            left.iterator().forEachRemaining(col -> colors.add(col.getColorMask()));
            byte c = colors.size() == 1 ? colors.get(0)
                    : askColor("Choose a color (" + (i + 1) + "/" + manaAmount + ")", sa, colors, i + 1, manaAmount);
            out.merge(c, 1, Integer::sum);
            if (different) {
                left = ColorSet.fromMask(left.getColor() & ~c);
            }
        }
        return out;
    }

    private static final Map<String, String> COLOR_JA = Map.of(
            "white", "白", "blue", "青", "black", "黒", "red", "赤", "green", "緑", "colorless", "無色");

    /** 同時に当てはまる置換効果・常在型能力・誘発能力のうち、どれを先に適用／スタックに置くか */
    @Override
    public ReplacementEffect chooseSingleReplacementEffect(List<ReplacementEffect> possible) {
        return possible.size() == 1 ? possible.get(0)
                : possible.get(chooseIndex(Decision.Prompt.of("Choose which replacement effect applies first", "replacementOrder"), possible));
    }

    @Override
    public StaticAbility chooseSingleStaticAbility(List<StaticAbility> possible) {
        return possible.size() == 1 ? possible.get(0)
                : possible.get(chooseIndex(Decision.Prompt.of("Choose which effect applies first", "staticOrder"), possible));
    }

    @Override
    public List<SpellAbility> orderSimultaneousSa(List<SpellAbility> activePlayerSAs) {
        if (activePlayerSAs.size() <= 1) {
            return activePlayerSAs;
        }
        List<SpellAbility> ordered = new ArrayList<>();
        List<SpellAbility> rem = new ArrayList<>(activePlayerSAs);
        while (rem.size() > 1) {
            int idx = chooseIndex(Decision.Prompt.of("Choose next ability to put on the stack", "orderSimultaneous"), rem);
            ordered.add(rem.remove(idx));
        }
        ordered.addAll(rem);
        return ordered;
    }

    private int chooseIndex(Decision.Prompt prompt, List<?> items) {
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < items.size(); i++) {
            Object it = items.get(i);
            Card hostCard = it instanceof forge.game.CardTraitBase t ? t.getHostCard() : null;
            String host = hostCard != null ? hostCard.getName() + ": " : "";
            String ja = hostCard != null ? Ja.name(hostCard.getName()) + ": " + Ja.description(String.valueOf(it), hostCard) : null;
            opts.add(new Decision.Option("k" + i, host + it,
                    hostCard != null ? Decision.Ref.card(hostCard.getId()) : null, Ja.available() ? ja : null));
        }
        return Integer.parseInt(channel.ask(Decision.Kind.CHOOSE_MODE, prompt, opts, 1, 1).get(0).substring(1));
    }

    /**
     * 戦闘ダメージの割り振り。選ぶ余地が無いとき（ブロッカーが 1 体以下でトランプルでない）はそのまま。
     * トランプルでブロッカーが 1 体なら、致死量をブロッカーに、残りを防御側に割り振る（パズルではふつう最善）。
     * ブロッカーが 2 体以上のときは、ブロッカーごとに何点与えるかを順に聞く
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
        Map<Card, Integer> map = new HashMap<>();
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
            int v = chooseNumberIn(Decision.Prompt.of("Assign combat damage from " + attacker.getName() + " to " + b.getName()
                    + " (lethal " + lethal + ", " + left + " left)", "assignDamage", "from", attacker.getName(), "to", b.getName(),
                    "lethal", String.valueOf(lethal), "left", String.valueOf(left)), 0, left);
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

    @Override
    public Map<GameEntity, Integer> divideShield(Card effectSource, Map<GameEntity, Integer> affected, int shieldAmount) {
        if (affected.size() <= 1 || shieldAmount <= 0) {
            if (affected.size() == 1) {
                GameEntity only = affected.keySet().iterator().next();
                affected.put(only, shieldAmount);
            }
            return affected;
        }
        List<GameEntity> entities = new ArrayList<>(affected.keySet());
        int left = shieldAmount;
        for (int i = 0; i < entities.size(); i++) {
            GameEntity e = entities.get(i);
            if (i == entities.size() - 1) {
                affected.put(e, left);
            } else {
                int v = left == 0 ? 0 : chooseNumberIn(Decision.Prompt.of(
                        "Divide shield from " + effectSource.getName() + " to " + e + " (" + left + " left)",
                        "divide", "card", effectSource.getName(), "to", e.toString(), "left", String.valueOf(left)), 0, left);
                affected.put(e, v);
                left -= v;
            }
        }
        return affected;
    }

    // ---------- ライブラリー操作・領域移動 ----------

    private CardCollection orderCardList(List<Card> cards, Decision.Prompt prompt) {
        if (cards.size() <= 1) {
            return new CardCollection(cards);
        }
        CardCollection ordered = new CardCollection();
        List<Card> rem = new ArrayList<>(cards);
        while (rem.size() > 1) {
            List<Card> picked = chooseObjects(Decision.Kind.CHOOSE_CARDS, prompt, rem, 1, 1);
            Card c = picked.get(0);
            ordered.add(c);
            rem.remove(c);
        }
        ordered.addAll(rem);
        return ordered;
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection topN) {
        if (topN.isEmpty()) {
            return ImmutablePair.of(new CardCollection(), new CardCollection());
        }
        List<Card> list = new ArrayList<>();
        topN.forEach(list::add);
        List<Card> bottomChosen = chooseObjects(Decision.Kind.CHOOSE_CARDS,
                Decision.Prompt.of("Scry: choose cards to put on the bottom of your library", "scryBottom"),
                list, 0, list.size());
        CardCollection toBottom = orderCardList(bottomChosen,
                Decision.Prompt.of("Choose next card to put on the bottom of your library", "scryBottom"));
        List<Card> topRem = new ArrayList<>(list);
        topRem.removeAll(bottomChosen);
        CardCollection toTop = orderCardList(topRem,
                Decision.Prompt.of("Choose next card to put on top of your library", "putOnTop"));
        return ImmutablePair.of(toTop, toBottom);
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection topN) {
        if (topN.isEmpty()) {
            return ImmutablePair.of(new CardCollection(), new CardCollection());
        }
        List<Card> list = new ArrayList<>();
        topN.forEach(list::add);
        List<Card> graveChosen = chooseObjects(Decision.Kind.CHOOSE_CARDS,
                Decision.Prompt.of("Surveil: choose cards to put into your graveyard", "surveilGrave"),
                list, 0, list.size());
        CardCollection toGrave = new CardCollection(graveChosen);
        List<Card> topRem = new ArrayList<>(list);
        topRem.removeAll(graveChosen);
        CardCollection toTop = orderCardList(topRem,
                Decision.Prompt.of("Choose next card to put on top of your library", "putOnTop"));
        return ImmutablePair.of(toTop, toGrave);
    }

    @Override
    public boolean willPutCardOnTop(Card c) {
        return confirm(Decision.Prompt.of("Put " + c.getName() + " on top of your library? (No: bottom)",
                "putOnTop", "card", c.getName()));
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
                selectPrompt == null || selectPrompt.isBlank()
                        ? Decision.Prompt.of("Choose a card to move to " + destination, "zoneChange", "zone", String.valueOf(destination))
                        : Decision.Prompt.text(selectPrompt),
                candidates, isOptional ? 0 : 1, 1);
        return chosen.isEmpty() ? null : chosen.get(0);
    }

    @Override
    public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList,
            int min, int max, DelayedReveal delayedReveal, String selectPrompt, Player decider) {
        if (fetchList.isEmpty() || max <= 0) {
            return List.of();
        }
        List<Card> candidates = new ArrayList<>();
        fetchList.forEach(candidates::add);
        return chooseObjects(Decision.Kind.CHOOSE_ENTITY,
                selectPrompt == null || selectPrompt.isBlank()
                        ? Decision.Prompt.of("Choose card(s) to move to " + destination, "zoneChange", "zone", String.valueOf(destination))
                        : Decision.Prompt.text(selectPrompt),
                candidates, min, max);
    }

    // ---------- 効果での選択（生け贄・破壊・捨てる・公開・探査・連繋・二択・種類・カード名） ----------

    @Override
    public CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        List<Card> candidates = new ArrayList<>();
        validTargets.forEach(candidates::add);
        if (candidates.size() <= min) {
            return new CardCollection(candidates); // 選ぶ余地が無い
        }
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_ENTITY,
                message == null || message.isBlank() ? Decision.Prompt.of("Choose permanents to sacrifice", "sacrifice") : Decision.Prompt.text(message),
                candidates, min, max));
    }

    @Override
    public CardCollectionView choosePermanentsToDestroy(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        List<Card> candidates = new ArrayList<>();
        validTargets.forEach(candidates::add);
        if (candidates.size() <= min) {
            return new CardCollection(candidates);
        }
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_ENTITY,
                message == null || message.isBlank() ? Decision.Prompt.of("Choose permanents to destroy", "destroy") : Decision.Prompt.text(message),
                candidates, min, max));
    }

    @Override
    public CardCollectionView chooseCardsToDiscardFrom(Player playerDiscard, SpellAbility sa, CardCollection validCards, int min, int max,
            CardCollectionView visibleToChooser) {
        if (validCards.isEmpty() || max <= 0) {
            return CardCollection.EMPTY;
        }
        List<Card> candidates = new ArrayList<>();
        validCards.forEach(candidates::add);
        if (candidates.size() <= min && min == max) {
            return new CardCollection(candidates);
        }
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_ENTITY,
                Decision.Prompt.of("Choose " + min + " card(s) to discard", "discard", "n", String.valueOf(min)),
                candidates, min, max));
    }

    @Override
    public CardCollectionView chooseCardsToDiscardUnlessType(int min, CardCollectionView hand, String[] unlessTypes, SpellAbility sa) {
        if (hand.isEmpty() || min <= 0) {
            return CardCollection.EMPTY;
        }
        List<Card> rem = new ArrayList<>();
        hand.forEach(rem::add);
        CardCollection chosen = new CardCollection();
        for (int i = 0; i < min && !rem.isEmpty(); i++) {
            List<Card> picked = chooseObjects(Decision.Kind.CHOOSE_ENTITY,
                    Decision.Prompt.of("Choose a card to discard (" + (i + 1) + "/" + min + ")", "discard", "n", String.valueOf(min - i)),
                    rem, 1, 1);
            Card c = picked.get(0);
            chosen.add(c);
            rem.remove(c);
            if (unlessTypes != null && c.isValid(unlessTypes, sa.getActivatingPlayer(), sa.getHostCard(), sa)) {
                break;
            }
        }
        return chosen;
    }

    /** クリンナップで手札の上限まで捨てる */
    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        List<Card> hand = new ArrayList<>();
        player.getCardsIn(ZoneType.Hand).forEach(hand::add);
        if (hand.size() <= numDiscard) {
            return new CardCollection(hand);
        }
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_ENTITY,
                Decision.Prompt.of("Discard " + numDiscard + " card(s) to your maximum hand size", "discardHandSize", "n", String.valueOf(numDiscard)),
                hand, numDiscard, numDiscard));
    }

    @Override
    public CardCollectionView chooseCardsToRevealFromHand(int min, int max, CardCollectionView valid) {
        if (valid.isEmpty() || max <= 0) {
            return CardCollection.EMPTY;
        }
        List<Card> candidates = new ArrayList<>();
        valid.forEach(candidates::add);
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_ENTITY, "Choose card(s) to reveal from hand", candidates, min, max));
    }

    @Override
    public CardCollectionView chooseCardsToDelve(int genericAmount, CardCollection grave) {
        int max = Math.min(genericAmount, grave.size());
        if (max <= 0) {
            return CardCollection.EMPTY;
        }
        List<Card> candidates = new ArrayList<>();
        grave.forEach(candidates::add);
        return new CardCollection(chooseObjects(Decision.Kind.CHOOSE_CARDS,
                Decision.Prompt.of("Choose cards in graveyard to exile for Delve (up to " + max + ")", "delve", "n", String.valueOf(max)),
                candidates, 0, max));
    }

    @Override
    public Map<Card, ManaCostShard> chooseCardsForConvokeOrImprovise(SpellAbility sa, ManaCost manaCost,
            CardCollectionView untappedCards, boolean artifacts, boolean creatures, Integer maxReduction) {
        if (untappedCards.isEmpty()) {
            return new HashMap<>();
        }
        int max = maxReduction == null ? manaCost.getCMC() : Math.min(manaCost.getCMC(), maxReduction);
        max = Math.min(max, untappedCards.size());
        if (max <= 0) {
            return new HashMap<>();
        }
        List<Card> candidates = new ArrayList<>();
        untappedCards.forEach(candidates::add);
        List<Card> chosen = chooseObjects(Decision.Kind.CHOOSE_CARDS,
                Decision.Prompt.of("Choose cards to tap for " + sa.getHostCard().getName() + " (" + manaCost + ")",
                        "convoke", "card", sa.getHostCard().getName(), "cost", manaCost.toString())
                        .withSource(sa.getHostCard().getId()),
                candidates, 0, max);
        ManaCostBeingPaid remaining = new ManaCostBeingPaid(manaCost);
        byte initialUnpaid = remaining.getUnpaidColors();
        List<Card> ordered = new ArrayList<>(chosen);
        ordered.sort(Comparator
                .comparingInt((Card c) -> Integer.bitCount((creatures && c.isCreature() ? c.getColor().getColor() : 0) & initialUnpaid))
                .thenComparingInt(c -> c.getColor().countColors()));
        Map<Card, ManaCostShard> result = new LinkedHashMap<>();
        for (Card c : ordered) {
            byte color = MagicColor.COLORLESS;
            if (creatures && c.isCreature()) {
                ColorSet colors = c.getColor();
                if (colors.isMulticolor()) {
                    colors = ColorSet.fromMask(colors.getColor() & remaining.getUnpaidColors());
                }
                if (colors.isMulticolor()) {
                    color = chooseColorAllowColorless("Choose color to convoke " + c.getName(), c, colors);
                } else {
                    color = colors.getColor();
                }
            }
            ManaCostShard shard = remaining.payManaViaConvoke(color);
            if (shard == null && color != MagicColor.COLORLESS) {
                shard = remaining.payManaViaConvoke(MagicColor.COLORLESS);
            }
            if (shard != null) {
                result.put(c, shard);
            }
        }
        return result;
    }

    @Override
    public List<Card> chooseCardsForSplice(SpellAbility sa, List<Card> cards) {
        if (cards.isEmpty()) {
            return List.of();
        }
        return chooseObjects(Decision.Kind.CHOOSE_CARDS, "Choose card(s) to splice onto " + sa.getHostCard().getName(),
                cards, 0, cards.size());
    }

    private static final Map<String, String[]> BINARY_JA = Map.of(
            "HeadsOrTails", new String[]{"表", "裏"}, "TapOrUntap", new String[]{"タップ", "アンタップ"},
            "PlayOrDraw", new String[]{"先手", "後手"}, "OddsOrEvens", new String[]{"奇数", "偶数"},
            "UntapOrLeaveTapped", new String[]{"アンタップする", "タップ状態のままにする"}, "LeftOrRight", new String[]{"左", "右"},
            "AddOrRemove", new String[]{"置く", "取り除く"}, "IncreaseOrDecrease", new String[]{"増やす", "減らす"});

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
        String[] ja = BINARY_JA.get(kindOfChoice.name());
        String id = channel.ask(Decision.Kind.CHOOSE_MODE, question,
                List.of(new Decision.Option("k0", labels[0], null, ja == null ? null : ja[0]),
                        new Decision.Option("k1", labels[1], null, ja == null ? null : ja[1])), 1, 1).get(0);
        return id.equals("k0");
    }

    @Override
    public boolean chooseFlipResult(SpellAbility sa, Player flipper, boolean call) {
        return chooseBinary(sa, flipper.getName() + ": Call coin flip", BinaryChoiceType.HeadsOrTails, call);
    }

    @Override
    public boolean chooseCardsPile(SpellAbility sa, CardCollectionView pile1, CardCollectionView pile2, String faceUp) {
        String p1 = "Pile 1 (" + pile1.size() + "): " + pile1;
        String p2 = "Pile 2 (" + pile2.size() + "): " + pile2;
        String id = channel.ask(Decision.Kind.CHOOSE_MODE, "Choose a pile",
                List.of(new Decision.Option("k0", p1), new Decision.Option("k1", p2)), 1, 1).get(0);
        return id.equals("k0");
    }

    @Override
    public CounterType chooseCounterType(List<CounterType> options, SpellAbility sa, String prompt, Map<String, Object> params) {
        if (options.size() == 1) {
            return options.get(0);
        }
        return options.get(chooseIndex(prompt == null || prompt.isBlank()
                ? Decision.Prompt.of("Choose a counter type", "counterType") : Decision.Prompt.text(prompt), options));
    }

    @Override
    public String chooseProtectionType(SpellAbility sa, List<String> choices) {
        if (choices.size() == 1) {
            return choices.get(0);
        }
        return choices.get(chooseIndex(Decision.Prompt.of("Choose a protection", "protection"), choices));
    }

    @Override
    public String chooseKeywordForPump(List<String> options, SpellAbility sa, String prompt, Card tgtCard) {
        if (options.isEmpty()) {
            return null;
        }
        if (options.size() == 1) {
            return options.get(0);
        }
        return options.get(chooseIndex(Decision.Prompt.text(prompt == null || prompt.isBlank() ? "Choose a keyword" : prompt), options));
    }

    @Override
    public String chooseSomeType(String kindOfType, SpellAbility sa, Collection<String> validTypes, boolean isOptional) {
        if (validTypes.isEmpty()) {
            return null;
        }
        if (validTypes.size() == 1 && !isOptional) {
            return validTypes.iterator().next();
        }
        // 盤面・手札・墓地などゲーム内のカードが持つタイプを先頭に並べ、選択肢の上限内に収める
        Set<String> inGame = new LinkedHashSet<>();
        for (Card c : getGame().getCardsInGame()) {
            for (String t : validTypes) {
                if (c.getType().hasSubtype(t) || c.getType().hasStringType(t)) {
                    inGame.add(t);
                }
            }
        }
        List<String> candidates = new ArrayList<>(inGame);
        for (String t : validTypes) {
            if (candidates.size() >= MAX_TYPE_OPTIONS) {
                break;
            }
            if (!inGame.contains(t)) {
                candidates.add(t);
            }
        }
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < candidates.size(); i++) {
            opts.add(new Decision.Option("k" + i, candidates.get(i)));
        }
        List<String> ans = channel.ask(Decision.Kind.CHOOSE_MODE,
                Decision.Prompt.text("Choose a " + kindOfType.toLowerCase() + " type"), opts, isOptional ? 0 : 1, 1);
        return ans.isEmpty() ? null : candidates.get(Integer.parseInt(ans.get(0).substring(1)));
    }

    @Override
    public Object vote(SpellAbility sa, String prompt, List<Object> options, ListMultimap<Object, Player> votes, Player forPlayer, boolean optional) {
        if (options.isEmpty()) {
            return null;
        }
        if (options.size() == 1 && !optional) {
            return options.get(0);
        }
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < options.size(); i++) {
            opts.add(new Decision.Option("k" + i, String.valueOf(options.get(i))));
        }
        List<String> ans = channel.ask(Decision.Kind.CHOOSE_MODE,
                Decision.Prompt.text(prompt == null || prompt.isBlank() ? "Vote" : prompt), opts, optional ? 0 : 1, 1);
        return ans.isEmpty() ? null : options.get(Integer.parseInt(ans.get(0).substring(1)));
    }

    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, List<ICardFace> faces, String message) {
        if (faces.isEmpty()) {
            return null;
        }
        if (faces.size() == 1) {
            return faces.get(0);
        }
        List<String> names = new ArrayList<>();
        for (ICardFace f : faces) {
            names.add(f.getName());
        }
        return faces.get(chooseIndex(Decision.Prompt.text(message == null || message.isBlank() ? "Choose a card face" : message), names));
    }

    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, String message, Predicate<ICardFace> cpp, String name) {
        List<ICardFace> faces = matchingFacesInGame(cpp);
        return chooseSingleCardFace(sa, faces, message);
    }

    @Override
    public CardState chooseSingleCardState(SpellAbility sa, List<CardState> states, String message, Map<String, Object> params) {
        if (states.isEmpty()) {
            return null;
        }
        if (states.size() == 1) {
            return states.get(0);
        }
        List<String> names = new ArrayList<>();
        for (CardState st : states) {
            names.add(st.getName());
        }
        return states.get(chooseIndex(Decision.Prompt.text(message == null || message.isBlank() ? "Choose a card state" : message), names));
    }

    @Override
    public String chooseCardName(SpellAbility sa, List<ICardFace> faces, String message) {
        ICardFace chosen = chooseSingleCardFace(sa, faces, message);
        return chosen == null ? "" : chosen.getName();
    }

    @Override
    public String chooseCardName(SpellAbility sa, Predicate<ICardFace> cpp, String valid, String message) {
        if (valid != null && !valid.isEmpty()) {
            CardCollection validCards = forge.game.card.CardLists.getValidCards(
                    getGame().getCardsInGame(), valid, player, sa.getHostCard(), sa);
            Map<String, ICardFace> map = new LinkedHashMap<>();
            for (Card c : validCards) {
                ICardFace f = c.getRules() != null ? c.getRules().getMainPart() : null;
                if (f != null && (cpp == null || cpp.test(f))) {
                    map.putIfAbsent(f.getName(), f);
                }
            }
            if (!map.isEmpty()) {
                return chooseCardName(sa, new ArrayList<>(map.values()), message);
            }
        }
        return chooseCardName(sa, matchingFacesInGame(cpp), message);
    }

    private List<ICardFace> matchingFacesInGame(Predicate<ICardFace> cpp) {
        Map<String, ICardFace> map = new LinkedHashMap<>();
        for (Card c : getGame().getCardsInGame()) {
            if (c.getRules() == null) {
                continue;
            }
            ICardFace main = c.getRules().getMainPart();
            if (main != null && (cpp == null || cpp.test(main))) {
                map.putIfAbsent(main.getName(), main);
            }
            ICardFace other = c.getRules().getOtherPart();
            if (other != null && (cpp == null || cpp.test(other))) {
                map.putIfAbsent(other.getName(), other);
            }
        }
        if (map.isEmpty()) {
            StaticData.instance().getCommonCards().streamAllFaces()
                    .filter(cpp != null ? cpp : f -> true)
                    .limit(MAX_TYPE_OPTIONS)
                    .forEach(f -> map.putIfAbsent(f.getName(), f));
        }
        return new ArrayList<>(map.values());
    }

    /** コストを払う順（マナと、タップ・生け贄などの順）。並びのままでよい（人間用の画面でも既定の順で払う） */
    @Override
    public List<CostPart> orderCosts(List<CostPart> costs) {
        return costs;
    }

    @Override
    public List<OptionalCostValue> chooseOptionalCosts(SpellAbility chosen, List<OptionalCostValue> optionalCostValues) {
        if (optionalCostValues.isEmpty()) {
            return List.of();
        }
        List<Decision.Option> opts = new ArrayList<>();
        for (int i = 0; i < optionalCostValues.size(); i++) {
            OptionalCostValue v = optionalCostValues.get(i);
            opts.add(new Decision.Option("k" + i, v.getType().getName() + " (" + v.getCost() + ")"));
        }
        List<String> ans = channel.ask(Decision.Kind.CHOOSE_MODE,
                Decision.Prompt.of("Choose additional cost(s) for " + chosen.getHostCard().getName(), "optionalCost",
                        "card", chosen.getHostCard().getName()),
                opts, 0, opts.size());
        List<OptionalCostValue> out = new ArrayList<>();
        for (String id : ans) {
            out.add(optionalCostValues.get(Integer.parseInt(id.substring(1))));
        }
        return out;
    }

    // ---------- 数 ----------

    @Override
    public Integer announceRequirements(SpellAbility ability, int min, int max, String announce) {
        return chooseNumberIn(Decision.Prompt.of("Announce " + announce + " for " + ability.getHostCard().getName(), "announce",
                "what", announce, "card", ability.getHostCard().getName()), min, max);
    }

    @Override
    public int chooseNumberForCostReduction(SpellAbility sa, int min, int max) {
        if (min >= max) {
            return min;
        }
        return chooseNumberIn(Decision.Prompt.text("Choose cost reduction for " + sa.getHostCard().getName()), min, max);
    }

    @Override
    public int chooseNumberForKeywordCost(SpellAbility sa, Cost cost, KeywordInterface keyword, String prompt, int max) {
        if (max <= 0) {
            return 0;
        }
        return chooseNumberIn(Decision.Prompt.text(prompt), 0, max);
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, int min, int max) {
        if (min >= max) {
            return min;
        }
        return chooseNumberIn(Decision.Prompt.text(title), min, max);
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, List<Integer> values, Player relatedPlayer) {
        if (values.size() == 1) {
            return values.get(0);
        }
        List<Decision.Option> options = new ArrayList<>();
        for (Integer v : values) {
            options.add(new Decision.Option("n" + v, String.valueOf(v)));
        }
        return Integer.parseInt(channel.ask(Decision.Kind.CHOOSE_NUMBER, title, options, 1, 1).get(0).substring(1));
    }

    private int chooseNumberIn(Decision.Prompt title, int min, int max) {
        if (min >= max) {
            return min;
        }
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
        List<String> answer = channel.ask(Decision.Kind.ATTACKERS,
                Decision.Prompt.of("Declare attackers (defender: " + defender + ")", "attackers"),
                options, 0, able.size());
        for (String id : answer) {
            combat.addAttacker(able.get(indexOf(options, id)), defender);
        }
    }

    @Override
    public List<Card> exertAttackers(List<Card> attackers) {
        if (attackers.isEmpty()) {
            return List.of();
        }
        return chooseObjects(Decision.Kind.CHOOSE_CARDS, "Choose attacker(s) to exert", attackers, 0, attackers.size());
    }

    @Override
    public List<Card> enlistAttackers(List<Card> attackers) {
        if (attackers.isEmpty()) {
            return List.of();
        }
        return chooseObjects(Decision.Kind.CHOOSE_CARDS, "Choose attacker(s) to enlist with", attackers, 0, attackers.size());
    }

    @Override
    public CardCollection orderBlockers(Card attacker, CardCollection blockers) {
        if (blockers.size() <= 1) {
            return blockers;
        }
        List<Card> list = new ArrayList<>();
        blockers.forEach(list::add);
        return orderCardList(list, Decision.Prompt.of("Order blockers for " + attacker.getName(),
                "orderBlockers", "card", attacker.getName()));
    }

    @Override
    public CardCollection orderBlocker(Card attacker, Card blocker, CardCollection oldBlockers) {
        CardCollection all = new CardCollection(oldBlockers);
        all.add(blocker);
        return orderBlockers(attacker, all);
    }

    @Override
    public CardCollection orderAttackers(Card blocker, CardCollection attackers) {
        if (attackers.size() <= 1) {
            return attackers;
        }
        List<Card> list = new ArrayList<>();
        attackers.forEach(list::add);
        return orderCardList(list, Decision.Prompt.of("Order attackers for " + blocker.getName(),
                "orderAttackers", "card", blocker.getName()));
    }

    // ---------- 支払い ----------

    @Override
    public boolean payCostToPreventEffect(Cost cost, SpellAbility sa, boolean alreadyPaid, FCollectionView<Player> allPayers) {
        return PlaySpellAbility.payCostDuringAbilityResolve(this, player, cost, sa, "");
    }

    @Override
    public boolean payCostDuringRoll(Cost cost, SpellAbility sa) {
        return PlaySpellAbility.payCostDuringAbilityResolve(this, player, cost, sa, "");
    }

    @Override
    public boolean payCombatCost(Card card, Cost cost, SpellAbility sa, String prompt) {
        return PlaySpellAbility.payCostDuringAbilityResolve(this, player, cost, sa, prompt);
    }

    @Override
    protected ManaPayer.Source chooseManaSource(SpellAbility saPaidFor, String remaining, List<ManaPayer.Source> sources) {
        if (autoPay.containsKey(saPaidFor)) {
            return sources.get(0);
        }
        List<Decision.Option> options = new ArrayList<>();
        options.add(special("auto", "Auto pay"));
        for (int i = 0; i < sources.size(); i++) {
            ManaPayer.Source src = sources.get(i);
            options.add(new Decision.Option("m" + i, src.label(), Decision.Ref.card(src.ability().getHostCard().getId()),
                    Ja.available() ? Ja.name(src.ability().getHostCard().getName()) + ": " + Ja.with(src.ability()::toString) : null));
        }
        options.add(special("cancel", "Cancel"));
        String id = channel.ask(Decision.Kind.PAY_MANA, Decision.Prompt.of("Pay " + remaining + " for " + saPaidFor.getHostCard().getName(),
                "payMana", "cost", remaining, "card", saPaidFor.getHostCard().getName()),
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
                Decision.Prompt.of("Tap creatures with total power " + need + " or greater (" + sa.getHostCard().getName() + ")", "totalPower",
                        "n", String.valueOf(need), "card", sa.getHostCard().getName()), list, 1, list.size(), true);
        return chosen == null ? null : new CardCollection(chosen);
    }

    /** 証拠収集など: 候補から 1 枚以上を選ばせる。マナ総量の合計が足りなければ支払いを取りやめる（呼び出し側が確かめる） */
    @Override
    protected CardCollectionView chooseCardsForTotalCMC(CardCollectionView candidates, SpellAbility sa, int need, boolean exact) {
        List<Card> list = new ArrayList<>();
        candidates.forEach(list::add);
        List<Card> chosen = chooseObjects(Decision.Kind.CHOOSE_CARDS,
                Decision.Prompt.of("Exile cards with total mana value " + need + (exact ? "" : " or greater")
                        + " (" + sa.getHostCard().getName() + ")", "totalCMC",
                        "n", String.valueOf(need), "card", sa.getHostCard().getName()), list, 1, list.size(), true);
        return chosen == null ? null : new CardCollection(chosen);
    }

    @Override
    public CardCollectionView chooseCardsForCost(CardCollectionView optionList, SpellAbility sa, CostPartWithList cpl,
            int amount, boolean isOptional, String prompt) {
        List<Card> candidates = new ArrayList<>();
        optionList.forEach(candidates::add);
        List<Card> chosen = chooseObjects(Decision.Kind.CHOOSE_CARDS, Decision.Prompt.of("Pay cost: " + prompt, "payCost", "cost", prompt,
                "card", sa.getHostCard().getName()), candidates, isOptional ? 0 : amount, amount, true);
        return chosen == null ? null : new CardCollection(chosen);
    }
}
