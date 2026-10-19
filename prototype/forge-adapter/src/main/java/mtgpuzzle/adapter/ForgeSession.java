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
import forge.game.event.GameEvent;
import forge.game.event.GameEventGameOutcome;
import forge.game.event.GameEventPlayerLivesChanged;
import forge.game.event.GameEventSpellAbilityCast;
import forge.game.event.GameEventSpellResolved;
import forge.game.event.GameEventTurnBegan;
import forge.game.event.GameEventTurnPhase;
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

    public record StepResult(Status status, String reason, Decision pending, List<String> events, long elapsedMillis) { }

    public record CardState(String instanceId, int forgeId, String name, String zone, String controller,
                            boolean tapped, boolean sick, Map<String, Integer> counters) { }

    public record PlayerState(String id, String name, int life, List<CardState> cards) { }

    public record GameSnapshot(int turn, String phase, String activePlayer, String priorityPlayer, int stackSize,
                               List<String> stack, List<PlayerState> players) { }

    private final PuzzleDefinition puzzle;
    private final FallbackLog fallbackLog = new FallbackLog();

    private DecisionChannel channel;
    private Thread gameThread;
    private volatile Game game;
    private Decision pending;
    private Status status = Status.IN_PROGRESS;
    private String reason = "";
    private final List<String> eventBuffer = Collections.synchronizedList(new ArrayList<>());
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
        if (optionIds.size() < pending.min() || optionIds.size() > pending.max()) {
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

    /** ゲームスレッドが選択待ちで止まっている（または終了している）間だけ呼ぶこと */
    public GameSnapshot getState() {
        Game g = game;
        Map<Integer, String> forgeToInstance = new LinkedHashMap<>();
        instanceToForgeId.forEach((k, v) -> forgeToInstance.put(v, k));
        List<PlayerState> players = new ArrayList<>();
        for (Player p : g.getRegisteredPlayers()) {
            List<CardState> cards = new ArrayList<>();
            for (ZoneType z : ZONES) {
                for (Card c : p.getCardsIn(z)) {
                    Map<String, Integer> counters = new LinkedHashMap<>();
                    c.getCounters().entrySet().forEach(e -> counters.put(e.getElement().toString(), e.getCount()));
                    cards.add(new CardState(forgeToInstance.get(c.getId()), c.getId(), c.getName(), z.name(),
                            c.getController().getName(), c.isTapped(), c.isSick(), counters));
                }
            }
            players.add(new PlayerState(puzzleIdOf(p), p.getName(), p.getLife(), cards));
        }
        List<String> stack = new ArrayList<>();
        g.getStack().forEach(si -> stack.add(si.getStackDescription()));
        return new GameSnapshot(g.getPhaseHandler().getTurn(), String.valueOf(g.getPhaseHandler().getPhase()),
                g.getPhaseHandler().getPlayerTurn().getName(),
                g.getPhaseHandler().getPriorityPlayer() == null ? null : g.getPhaseHandler().getPriorityPlayer().getName(),
                g.getStack().size(), stack, players);
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
                        : new PassingPlayerController(pl.getGame(), pl, self, fallbackLog));
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
                state.applyToGame(g); // ゲームスレッド上なので同期実行される
                startTurn = g.getPhaseHandler().getTurn();
                mapInstances(g);
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
                finish(Status.FAILED, "期限（このターン中）を過ぎました");
            } else {
                pending = pd.decision();
            }
        } else if (s instanceof DecisionChannel.Finished) {
            judgeGameOver();
        } else if (s instanceof DecisionChannel.Failed f) {
            finish(Status.ERROR, "エンジン異常: " + f.error());
            f.error().printStackTrace();
        }
        List<String> ev;
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
            if (e instanceof GameEventTurnBegan tb) {
                if (startTurn > 0 && tb.turnNumber() > startTurn) {
                    deadlineExceeded = true;
                }
                eventBuffer.add("turn " + tb.turnNumber() + " (" + tb.turnOwner() + ")");
            } else if (e instanceof GameEventTurnPhase tp) {
                eventBuffer.add("phase " + tp.phase());
            } else if (e instanceof GameEventSpellAbilityCast sc) {
                eventBuffer.add("cast " + sc.sa());
            } else if (e instanceof GameEventSpellResolved sr) {
                eventBuffer.add("resolved " + sr.stackDescription() + (sr.hasFizzled() ? " (fizzled)" : ""));
            } else if (e instanceof GameEventPlayerLivesChanged lc) {
                eventBuffer.add("life " + lc.player() + " " + lc.oldLives() + " -> " + lc.newLives());
            } else if (e instanceof GameEventGameOutcome go) {
                eventBuffer.add("outcome winner=" + go.winningPlayerName());
            }
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
