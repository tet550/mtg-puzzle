package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiFunction;

import com.google.common.eventbus.Subscribe;

import forge.LobbyPlayer;
import forge.StaticData;
import forge.deck.Deck;
import forge.game.Game;
import forge.game.GameRules;
import forge.game.GameState;
import forge.game.GameType;
import forge.game.Match;
import forge.game.card.Card;
import forge.card.MagicColor;
import forge.game.GameEntity;
import forge.game.GameEntityView;
import forge.game.card.CardView;
import forge.game.combat.Combat;
import forge.game.event.GameEvent;
import forge.game.event.GameEventAttackersDeclared;
import forge.game.event.GameEventCardChangeZone;
import forge.game.event.GameEventCardCounters;
import forge.game.event.GameEventCardDamaged;
import forge.game.event.GameEventCardTapped;
import forge.game.event.GameEventGameOutcome;
import forge.game.event.GameEventPlayerDamaged;
import forge.game.event.GameEventPlayerLivesChanged;
import forge.game.event.GameEventSpellAbilityCast;
import forge.game.event.GameEventSpellResolved;
import forge.game.event.GameEventTurnBegan;
import forge.game.event.GameEventTurnPhase;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.player.IGameEntitiesFactory;
import forge.game.player.Player;
import forge.game.player.PlayerController;
import forge.game.player.RegisteredPlayer;
import forge.game.zone.ZoneType;

/**
 * Forge Adapter の本体。1 つのパズルを Forge 上に復元し、外部からの入力で進める。
 *
 * <pre>
 *   load(puzzle)  … 盤面を構築し、p1 の最初の選択要求（または終局）まで進める
 *   submit(ids)   … 選択要求に回答し、次の選択要求（または終局）まで進める
 *   getState()    … 現在の盤面（UI 表示用。Forge の内部オブジェクトは返さない）
 *   reset()       … 初期盤面から作り直す
 * </pre>
 *
 * Forge のゲームループは専用スレッド（名前が "Game" で始まる必要がある）で動かす。
 */
public final class ForgeSession implements AutoCloseable {
    private static final long STEP_TIMEOUT_MS = 30_000;
    private static final AtomicInteger THREAD_SEQ = new AtomicInteger();
    private static final List<ZoneType> ZONES = List.of(ZoneType.Hand, ZoneType.Battlefield, ZoneType.Graveyard,
            ZoneType.Exile, ZoneType.Library);

    public enum Status { IN_PROGRESS, CLEARED, FAILED, ERROR }

    /** events はゲームの出来事（{"type": ..., ...}）。カードはインスタンス ID、プレイヤーは問題のプレイヤー ID で表す */
    public record StepResult(Status status, String reason, Decision pending, List<Map<String, Object>> events, long elapsedMillis) { }

    /** kinds は land / creature / artifact / enchantment / planeswalker / battle / instant / sorcery。P/T はクリーチャーのときだけ */
    public record CardState(String instanceId, int forgeId, String name, String zone, String owner, String controller,
                            boolean tapped, boolean sick, Map<String, Integer> counters, List<String> kinds,
                            String typeLine, String manaCost, Integer power, Integer toughness, Integer basePower,
                            Integer baseToughness, int damage, boolean token, boolean faceDown, String attachedTo,
                            String exiledBy, String text) { }

    /** manaPool は色（W / U / B / R / G / C）ごとの量 */
    public record PlayerState(String id, String name, int life, int poison, Map<String, Integer> manaPool,
                              int handCount, int libraryCount, List<CardState> cards) { }

    /** index 0 が一番上。targets はインスタンス ID かプレイヤー ID */
    public record StackState(int index, String sourceId, String controller, String description, boolean spell,
                             List<String> targets, String descriptionJa) { }

    /** defender はプレイヤー ID か、プレインズウォーカー・バトルのインスタンス ID */
    public record AttackState(String attackerId, String defender, List<String> blockers) { }

    /** 終局したときの結果（winner は勝者のプレイヤー ID。引き分けなら null） */
    public record Outcome(String winner, boolean draw, String winCondition) { }

    public record GameSnapshot(int turn, String phase, String activePlayer, String priorityPlayer, int stackSize,
                               List<StackState> stack, List<AttackState> combat, List<PlayerState> players) { }

    private final PuzzleDefinition puzzle;
    private final FallbackLog fallbackLog = new FallbackLog();

    private DecisionChannel channel;
    private Thread gameThread;
    private volatile Game game;
    private Decision pending;
    private Status status = Status.IN_PROGRESS;
    private String reason = "";
    private final List<Map<String, Object>> eventBuffer = Collections.synchronizedList(new ArrayList<>());
    /** 盤面の復元が終わったか（復元中の出来事はイベントとして返さない） */
    private volatile boolean setupDone;
    /** 期限（このターン）を過ぎたので、エンジンを止めた */
    private boolean halted;
    private Outcome outcome;
    private volatile int startTurn;
    private volatile boolean deadlineExceeded;
    /** 問題のインスタンス ID → Forge のカード ID */
    private final Map<String, Integer> instanceToForgeId = Collections.synchronizedMap(new LinkedHashMap<>());
    private volatile String setupError;

    private ForgeSession(PuzzleDefinition puzzle) {
        this.puzzle = puzzle;
    }

    // ================= 公開 API =================

    public static ForgeSession load(PuzzleDefinition puzzle) {
        validate(puzzle);
        ForgeSession s = new ForgeSession(puzzle);
        s.lastStep = s.start();
        return s;
    }

    private StepResult lastStep;

    public StepResult lastStep() {
        return lastStep;
    }

    public Decision getPendingDecision() {
        return pending;
    }

    public StepResult submit(String... optionIds) {
        return submit(Arrays.asList(optionIds));
    }

    public StepResult submit(List<String> optionIds) {
        if (pending == null) {
            throw new IllegalStateException("回答待ちの選択がありません（status=" + status + "）");
        }
        // 「取りやめ」だけの回答は、選択数の範囲に関係なく受け付ける（コストのカードを選んでいる途中で唱えるのをやめる）
        boolean cancelOnly = optionIds.size() == 1 && optionIds.get(0).equals("cancel")
                && pending.options().stream().anyMatch(o -> o.id().equals("cancel"));
        if (!cancelOnly && (optionIds.size() < pending.min() || optionIds.size() > pending.max())) {
            throw new IllegalArgumentException("選択数が範囲外: " + optionIds.size() + " (min=" + pending.min() + ", max=" + pending.max() + ")");
        }
        // 不正な ID をゲームスレッドに渡すとゲームが止まるので、ここで弾く（選択待ちの状態はそのまま）
        java.util.Set<String> valid = new java.util.HashSet<>();
        pending.options().forEach(o -> valid.add(o.id()));
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (String id : optionIds) {
            if (!valid.contains(id)) {
                throw new IllegalArgumentException("選択肢にない ID: " + id);
            }
            if (!seen.add(id)) {
                throw new IllegalArgumentException("同じ ID が重複しています: " + id);
            }
        }
        long t0 = System.nanoTime();
        pending = null;
        channel.answer(optionIds);
        lastStep = awaitQuiescent(t0);
        return lastStep;
    }

    public StepResult reset() {
        stopThread();
        status = Status.IN_PROGRESS;
        reason = "";
        pending = null;
        deadlineExceeded = false;
        setupDone = false;
        halted = false;
        fallbackLog.clear();
        outcome = null;
        eventBuffer.clear();
        instanceToForgeId.clear();
        lastStep = start();
        return lastStep;
    }

    public List<String> fallbackLog() {
        return fallbackLog.entries();
    }

    public List<List<String>> answerLog() {
        return channel.answerLog();
    }

    public Map<String, Integer> instanceMap() {
        return Map.copyOf(instanceToForgeId);
    }

    /** 期限を過ぎてエンジンを止めたか */
    public boolean halted() {
        return halted;
    }

    /** 終局していればその結果（していなければ null） */
    public Outcome outcome() {
        return outcome;
    }

    /** 問題を解くプレイヤーの ID */
    public String viewer() {
        return puzzle.goal.player;
    }

    /** Forge のカード ID → 問題のインスタンス ID。問題に無いカード（トークンなど）は "f" + Forge の ID */
    public String instanceIdOf(int forgeId) {
        synchronized (instanceToForgeId) {
            for (Map.Entry<String, Integer> e : instanceToForgeId.entrySet()) {
                if (e.getValue() == forgeId) {
                    return e.getKey();
                }
            }
        }
        return "f" + forgeId;
    }

    /** ゲームスレッドが選択待ちで止まっている（または終了している）間だけ呼ぶこと */
    public GameSnapshot getState() {
        Game g = game;
        List<PlayerState> players = new ArrayList<>();
        for (Player p : g.getRegisteredPlayers()) {
            List<CardState> cards = new ArrayList<>();
            for (ZoneType z : ZONES) {
                for (Card c : p.getCardsIn(z)) {
                    cards.add(cardState(c, z));
                }
            }
            Map<String, Integer> pool = new LinkedHashMap<>();
            for (Map.Entry<String, Byte> e : MANA_COLORS.entrySet()) {
                int n = p.getManaPool().getAmountOfColor(e.getValue());
                if (n > 0) {
                    pool.put(e.getKey(), n);
                }
            }
            players.add(new PlayerState(puzzleIdOf(p), p.getName(), p.getLife(), p.getPoisonCounters(), pool,
                    p.getCardsIn(ZoneType.Hand).size(), p.getCardsIn(ZoneType.Library).size(), cards));
        }
        List<StackState> stack = new ArrayList<>();
        int index = 0;
        for (SpellAbilityStackInstance si : g.getStack()) {
            List<String> targets = new ArrayList<>();
            if (si.getTargetChoices() != null) {
                si.getTargetChoices().getTargetCards().forEach(c -> targets.add(instanceIdOf(c.getId())));
                si.getTargetChoices().getTargetPlayers().forEach(pl -> targets.add(pl.getName()));
            }
            stack.add(new StackState(index++, instanceIdOf(si.getSourceCard().getId()), si.getActivatingPlayer().getName(),
                    si.getStackDescription(), si.isSpell(), targets, Ja.stackDescription(si.getSpellAbility())));
        }
        List<AttackState> combat = new ArrayList<>();
        Combat cb = g.getCombat();
        if (cb != null) {
            for (Card a : cb.getAttackers()) {
                List<String> blockers = new ArrayList<>();
                cb.getBlockers(a).forEach(b -> blockers.add(instanceIdOf(b.getId())));
                combat.add(new AttackState(instanceIdOf(a.getId()), entityId(cb.getDefenderByAttacker(a)), blockers));
            }
        }
        return new GameSnapshot(g.getPhaseHandler().getTurn(), String.valueOf(g.getPhaseHandler().getPhase()),
                g.getPhaseHandler().getPlayerTurn().getName(),
                g.getPhaseHandler().getPriorityPlayer() == null ? null : g.getPhaseHandler().getPriorityPlayer().getName(),
                g.getStack().size(), stack, combat, players);
    }

    private static final Map<String, Byte> MANA_COLORS = new LinkedHashMap<>();
    static {
        MANA_COLORS.put("W", MagicColor.WHITE);
        MANA_COLORS.put("U", MagicColor.BLUE);
        MANA_COLORS.put("B", MagicColor.BLACK);
        MANA_COLORS.put("R", MagicColor.RED);
        MANA_COLORS.put("G", MagicColor.GREEN);
        MANA_COLORS.put("C", MagicColor.COLORLESS);
    }

    private CardState cardState(Card c, ZoneType z) {
        Map<String, Integer> counters = new LinkedHashMap<>();
        c.getCounters().entrySet().forEach(e -> counters.put(e.getElement().toString(), e.getCount()));
        List<String> kinds = new ArrayList<>();
        if (c.isLand()) kinds.add("land");
        if (c.isCreature()) kinds.add("creature");
        if (c.isArtifact()) kinds.add("artifact");
        if (c.isEnchantment()) kinds.add("enchantment");
        if (c.isPlaneswalker()) kinds.add("planeswalker");
        if (c.isBattle()) kinds.add("battle");
        if (c.isInstant()) kinds.add("instant");
        if (c.isSorcery()) kinds.add("sorcery");
        boolean creature = c.isCreature();
        GameEntity attachedTo = c.getEntityAttachedTo();
        Card exiledWith = z == ZoneType.Exile ? c.getExiledWith() : null;
        return new CardState(instanceIdOf(c.getId()), c.getId(), c.getName(), z.name(), c.getOwner().getName(),
                c.getController().getName(), c.isTapped(), c.isSick(), counters, kinds, c.getType().toString(),
                c.getManaCost() == null ? "" : c.getManaCost().getSimpleString(),
                creature ? c.getNetPower() : null, creature ? c.getNetToughness() : null,
                creature ? c.getBasePower() : null, creature ? c.getBaseToughness() : null,
                c.getDamage(), c.isToken(), c.isFaceDown(),
                attachedTo == null ? null : entityId(attachedTo),
                exiledWith == null ? null : instanceIdOf(exiledWith.getId()),
                c.getOracleText());
    }

    private String entityId(GameEntity e) {
        if (e == null) {
            return null;
        }
        return e instanceof Player p ? p.getName() : instanceIdOf(((Card) e).getId());
    }

    @Override
    public void close() {
        stopThread();
    }

    // ================= 検証 =================

    static void validate(PuzzleDefinition p) {
        if (p.schemaVersion != 1) {
            throw new PuzzleValidationException("未対応の schemaVersion: " + p.schemaVersion);
        }
        if (p.game == null || p.game.players.size() != 2) {
            throw new PuzzleValidationException("プレイヤーは 2 人である必要があります");
        }
        if (p.goal == null || !"win".equals(p.goal.type) || !"current_turn".equals(p.goal.deadline)) {
            throw new PuzzleValidationException("未対応の goal です");
        }
        if (p.opponent != null && !List.of("minimize", "none").contains(p.opponent.block)) {
            throw new PuzzleValidationException("未対応の opponent.block です: " + p.opponent.block);
        }
        p.playerIndex(p.game.activePlayer);
        p.playerIndex(p.goal.player);
        StaticData data = StaticData.instance();
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (PuzzleDefinition.PlayerDef pl : p.game.players) {
            for (List<PuzzleDefinition.CardDef> zone : List.of(pl.hand, pl.battlefield, pl.graveyard, pl.exile, pl.library)) {
                for (PuzzleDefinition.CardDef c : zone) {
                    if (c.id == null || !ids.add(c.id)) {
                        throw new PuzzleValidationException("カードのインスタンス ID が未指定か重複しています: " + c.id);
                    }
                    data.attemptToLoadCard(c.cardId);
                    if (data.getCommonCards().getCard(c.cardId) == null) {
                        throw new PuzzleValidationException("存在しないカード: " + c.cardId);
                    }
                }
            }
        }
    }

    // ================= ゲームスレッド =================

    private StepResult start() {
        long t0 = System.nanoTime();
        channel = new DecisionChannel();
        gameThread = new Thread(this::runGame, "Game-adapter-" + THREAD_SEQ.incrementAndGet());
        gameThread.setDaemon(true);
        gameThread.start();
        return awaitQuiescent(t0);
    }

    private void runGame() {
        DecisionChannel ch = channel;
        try {
            List<RegisteredPlayer> players = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                final boolean external = puzzle.game.players.get(i).id.equals(puzzle.goal.player);
                String name = puzzle.game.players.get(i).id;
                LobbyPlayer lp = new AdapterLobbyPlayer(name, (pl, self) -> external
                        ? new ExternalPlayerController(pl.getGame(), pl, self, ch, fallbackLog)
                        : new PassingPlayerController(pl.getGame(), pl, self, ch, fallbackLog,
                                puzzle.opponent == null ? "minimize" : puzzle.opponent.block));
                RegisteredPlayer rp = new RegisteredPlayer(new Deck()).setPlayer(lp);
                rp.setStartingHand(0);
                players.add(rp);
            }
            GameRules rules = new GameRules(GameType.Puzzle);
            rules.setGamesPerMatch(1);
            Match match = new Match(rules, players, "puzzle");
            Game g = match.createGame();
            game = g;
            g.subscribeToEvents(new EventListener());

            GameState state = new GameState();
            state.parse(puzzle.toGameStateLines());
            match.startGame(g, () -> {
                // ゲームスレッド上なので同期実行される。カードを作るときに日本語の訳の対応表ができるよう、日本語にしておく
                Ja.run(() -> state.applyToGame(g));
                startTurn = g.getPhaseHandler().getTurn();
                mapInstances(g);
                setupDone = true;
            });
            ch.finished();
        } catch (DecisionChannel.Aborted e) {
            // reset / close
        } catch (Throwable t) {
            ch.failed(t);
        }
    }

    private void mapInstances(Game g) {
        for (int i = 0; i < 2; i++) {
            PuzzleDefinition.PlayerDef def = puzzle.game.players.get(i);
            Player p = g.getRegisteredPlayers().get(i);
            check(def.hand, p.getCardsIn(ZoneType.Hand), ZoneType.Hand, def.id);
            check(def.battlefield, p.getCardsIn(ZoneType.Battlefield), ZoneType.Battlefield, def.id);
            check(def.graveyard, p.getCardsIn(ZoneType.Graveyard), ZoneType.Graveyard, def.id);
            check(def.exile, p.getCardsIn(ZoneType.Exile), ZoneType.Exile, def.id);
            check(def.library, p.getCardsIn(ZoneType.Library), ZoneType.Library, def.id);
        }
    }

    private void check(List<PuzzleDefinition.CardDef> defs, Iterable<Card> actual, ZoneType zone, String pid) {
        List<Card> list = new ArrayList<>();
        actual.forEach(list::add);
        if (defs.size() != list.size()) {
            setupError = pid + " " + zone + ": 枚数が一致しません (定義 " + defs.size() + ", 実際 " + list.size() + ")";
            return;
        }
        for (int i = 0; i < defs.size(); i++) {
            Card c = list.get(i);
            if (!c.getName().equals(defs.get(i).cardId)) {
                setupError = pid + " " + zone + "[" + i + "]: " + defs.get(i).cardId + " が " + c.getName() + " になっています";
                return;
            }
            instanceToForgeId.put(defs.get(i).id, c.getId());
        }
    }

    private StepResult awaitQuiescent(long t0) {
        DecisionChannel.Signal s = channel.await(STEP_TIMEOUT_MS);
        if (setupError != null && status == Status.IN_PROGRESS) {
            finish(Status.ERROR, "盤面の復元に失敗: " + setupError);
        } else if (s instanceof DecisionChannel.Pending pd) {
            if (deadlineExceeded) {
                halted = true;
                finish(Status.FAILED, "期限（このターン中）を過ぎました");
            } else {
                pending = pd.decision();
            }
        } else if (s instanceof DecisionChannel.Halted) {
            halted = true;
            finish(Status.FAILED, "期限（このターン中）を過ぎました");
        } else if (s instanceof DecisionChannel.Finished) {
            judgeGameOver();
        } else if (s instanceof DecisionChannel.Failed f) {
            finish(Status.ERROR, "エンジン異常: " + f.error());
            f.error().printStackTrace();
        }
        List<Map<String, Object>> ev;
        synchronized (eventBuffer) {
            ev = List.copyOf(eventBuffer);
            eventBuffer.clear();
        }
        return new StepResult(status, reason, pending, ev, (System.nanoTime() - t0) / 1_000_000);
    }

    private void judgeGameOver() {
        Game g = game;
        if (g == null || !g.isGameOver() || g.getOutcome() == null) {
            finish(Status.ERROR, "ゲームが終局せずに停止しました");
            return;
        }
        String winnerId = g.getOutcome().getWinningLobbyPlayer() == null ? null : g.getOutcome().getWinningLobbyPlayer().getName();
        outcome = new Outcome(g.getOutcome().isDraw() ? null : winnerId, g.getOutcome().isDraw(),
                String.valueOf(g.getOutcome().getWinCondition()));
        if (g.getOutcome().isDraw()) {
            finish(Status.FAILED, "引き分け");
            return;
        }
        String winner = g.getOutcome().getWinningLobbyPlayer() == null ? null : g.getOutcome().getWinningLobbyPlayer().getName();
        if (puzzle.goal.player.equals(winner) && !deadlineExceeded) {
            finish(Status.CLEARED, "勝利 (" + g.getOutcome().getWinCondition() + ")");
        } else if (puzzle.goal.player.equals(winner)) {
            finish(Status.FAILED, "勝利したが期限切れ");
        } else {
            finish(Status.FAILED, "敗北 (winner=" + winner + ")");
        }
    }

    private void finish(Status st, String why) {
        status = st;
        reason = why;
        pending = null;
        if (st != Status.CLEARED && gameThread != null && gameThread.isAlive()) {
            gameThread.interrupt();
        }
    }

    private void stopThread() {
        if (gameThread != null && gameThread.isAlive()) {
            gameThread.interrupt();
            try {
                gameThread.join(5_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private String puzzleIdOf(Player p) {
        return p.getName();
    }

    // ================= イベント =================

    /** Guava EventBus はゲームスレッド上で同期的に呼ぶ */
    public final class EventListener {
        @Subscribe
        public void on(GameEvent e) {
            boolean wasExceeded = deadlineExceeded;
            if (e instanceof GameEventTurnBegan tb) {
                if (startTurn > 0 && tb.turnNumber() > startTurn) {
                    deadlineExceeded = true;
                    channel.requestHalt();
                }
            }
            if (!setupDone || wasExceeded) {
                return; // 盤面の復元で起きた出来事と、期限を過ぎた後の出来事は返さない
            }
            Map<String, Object> m = new LinkedHashMap<>();
            if (e instanceof GameEventTurnBegan tb) {
                m.put("type", "turnBegan");
                m.put("turn", tb.turnNumber());
                m.put("player", tb.turnOwner().getName());
            } else if (e instanceof GameEventTurnPhase tp) {
                m.put("type", "phase");
                m.put("phase", tp.phase().name());
                m.put("player", tp.playerTurn().getName());
            } else if (e instanceof GameEventSpellAbilityCast sc) {
                m.put("type", "cast");
                m.put("sourceId", cardId(sc.sa().getHostCard()));
                m.put("controller", sc.si().getActivatingPlayer() == null ? null : sc.si().getActivatingPlayer().getName());
                m.put("description", sc.si().getText());
            } else if (e instanceof GameEventSpellResolved sr) {
                m.put("type", "resolved");
                m.put("sourceId", cardId(sr.spell().getHostCard()));
                m.put("description", sr.stackDescription());
                m.put("fizzled", sr.hasFizzled());
            } else if (e instanceof GameEventPlayerLivesChanged lc) {
                m.put("type", "life");
                m.put("player", lc.player().getName());
                m.put("from", lc.oldLives());
                m.put("to", lc.newLives());
            } else if (e instanceof GameEventPlayerDamaged pd) {
                m.put("type", "damage");
                m.put("sourceId", cardId(pd.source()));
                m.put("target", pd.target().getName());
                m.put("amount", pd.amount());
                m.put("combat", pd.combat());
            } else if (e instanceof GameEventCardDamaged cd) {
                m.put("type", "damage");
                m.put("sourceId", cardId(cd.source()));
                m.put("target", cardId(cd.card()));
                m.put("amount", cd.amount());
                m.put("combat", false);
            } else if (e instanceof GameEventCardChangeZone cz) {
                m.put("type", "zoneChange");
                m.put("cardId", cardId(cz.card()));
                m.put("from", cz.from() == null ? null : cz.from().zoneType().name());
                m.put("to", cz.to() == null ? null : cz.to().zoneType().name());
            } else if (e instanceof GameEventCardTapped ct) {
                m.put("type", "tapped");
                m.put("cardId", cardId(ct.card()));
                m.put("tapped", ct.tapped());
            } else if (e instanceof GameEventCardCounters cc) {
                m.put("type", "counters");
                m.put("cardId", cardId(cc.card()));
                m.put("counter", String.valueOf(cc.type()));
                m.put("from", cc.oldValue());
                m.put("to", cc.newValue());
            } else if (e instanceof GameEventAttackersDeclared ad) {
                List<Map<String, Object>> attackers = new ArrayList<>();
                ad.attackersMap().entries().forEach(en -> {
                    GameEntityView def = en.getKey();
                    CardView card = en.getValue();
                    Map<String, Object> a = new LinkedHashMap<>();
                    a.put("cardId", cardId(card));
                    a.put("defender", entityId(def));
                    attackers.add(a);
                });
                m.put("type", "attackersDeclared");
                m.put("attackers", attackers);
            } else if (e instanceof GameEventGameOutcome go) {
                m.put("type", "gameOver");
                m.put("winner", go.winningPlayerName());
            } else {
                return;
            }
            eventBuffer.add(m);
        }

        private String cardId(CardView c) {
            return c == null ? null : instanceIdOf(c.getId());
        }

        private String entityId(GameEntityView v) {
            if (v == null) {
                return null;
            }
            return v instanceof CardView c ? instanceIdOf(c.getId()) : v.getName();
        }
    }

    // ================= LobbyPlayer =================

    static final class AdapterLobbyPlayer extends LobbyPlayer implements IGameEntitiesFactory {
        private final BiFunction<Player, LobbyPlayer, PlayerController> factory;

        AdapterLobbyPlayer(String name, BiFunction<Player, LobbyPlayer, PlayerController> factory) {
            super(name);
            this.factory = factory;
        }

        @Override
        public PlayerController createMindSlaveController(Player master, Player slave) {
            return factory.apply(slave, this);
        }

        @Override
        public Player createIngamePlayer(Game game, int id) {
            Player p = new Player(getName(), game, id);
            p.setFirstController(factory.apply(p, this));
            return p;
        }

        @Override
        public void hear(LobbyPlayer player, String message) { }
    }
}
