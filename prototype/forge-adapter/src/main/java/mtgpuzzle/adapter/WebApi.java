package mtgpuzzle.adapter;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * ブラウザ（JS）から呼ぶための入口。引数・戻り値はすべて JSON 文字列にして、
 * 各 WASM 方式の JS 連携の差を小さくする（V3 の Adapter API の原型）。
 */
public final class WebApi {
    private static ForgeSession session;

    private WebApi() { }

    /** res バンドル（zip）を展開して Forge を初期化する */
    public static String init(String zipPath, String extractDir) {
        return run(() -> {
            Map<String, Object> r = new LinkedHashMap<>();
            long t0 = System.currentTimeMillis();
            int n = extract(zipPath, extractDir);
            boolean cached = n < 0;
            int files = Math.max(n, 0);
            r.put("extractMs", System.currentTimeMillis() - t0);
            r.put("extractCached", cached);
            r.put("files", files);
            ForgeRuntime.init(extractDir, false);
            r.put("initMs", ForgeRuntime.getInitMillis());
            r.put("initPhases", new java.util.TreeMap<>(ForgeRuntime.getInitPhases()));
            Runtime rt = Runtime.getRuntime();
            r.put("heapUsedMB", (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024));
            return r;
        });
    }

    /**
     * 共通の res バンドル（カードを含まない zip。CardData が作る）を展開する。Forge の初期化は useCards で行う。
     * 展開済みなら省く（init と同じ）
     */
    public static String prepare(String zipPath, String extractDir) {
        return run(() -> {
            Map<String, Object> r = new LinkedHashMap<>();
            long t0 = System.currentTimeMillis();
            r.put("extractCached", extract(zipPath, extractDir) < 0);
            r.put("extractMs", System.currentTimeMillis() - t0);
            resDir = extractDir;
            cardsKey = null;
            return r;
        });
    }

    /**
     * 問題で使うカードのデータ（ブラウザがカードデータから抜き出したもの）を res に書き、Forge を初期化し直す。
     * 引数: {"key": カードの組の識別子, "cards": [{"f": ファイル名, "s": スクリプト}], "editions": {ファイル名: 中身},
     *        "tokens": {トークン名: スクリプト}, "ja": 訳の行}
     * key が前回と同じなら何もしない（同じ問題のやり直し）
     */
    @SuppressWarnings("unchecked")
    public static String useCards(String cardsJson) {
        return run(() -> {
            if (resDir == null) {
                throw new ApiException("NOT_LOADED", "prepare が呼ばれていません");
            }
            Map<String, Object> data = Json.parseObject(cardsJson);
            String key = String.valueOf(data.get("key"));
            Map<String, Object> r = new LinkedHashMap<>();
            if (key.equals(cardsKey)) {
                r.put("reused", true);
                return r;
            }
            if (session != null) {
                session.close();
                session = null;
            }
            long t0 = System.currentTimeMillis();
            Path res = Path.of(resDir);
            for (String dir : new String[] {"cardsfolder", "editions", "tokenscripts"}) {
                deleteRecursively(res.resolve(dir));
                Files.createDirectories(res.resolve(dir));
            }
            List<Map<String, Object>> cards = (List<Map<String, Object>>) data.get("cards");
            for (Map<String, Object> c : cards) {
                Files.writeString(safe(res.resolve("cardsfolder"), String.valueOf(c.get("f"))), String.valueOf(c.get("s")));
            }
            for (Map.Entry<String, Object> e : ((Map<String, Object>) data.get("editions")).entrySet()) {
                Files.writeString(safe(res.resolve("editions"), e.getKey()), String.valueOf(e.getValue()));
            }
            for (Map.Entry<String, Object> e : ((Map<String, Object>) data.getOrDefault("tokens", Map.of())).entrySet()) {
                Files.writeString(safe(res.resolve("tokenscripts"), e.getKey() + ".txt"), String.valueOf(e.getValue()));
            }
            Files.createDirectories(res.resolve("languages"));
            Files.writeString(res.resolve("languages").resolve("cardnames-ja-JP.txt"), String.valueOf(data.getOrDefault("ja", "")));
            r.put("writeMs", System.currentTimeMillis() - t0);
            cardsKey = null; // 初期化に失敗したら、次は必ずやり直す
            ForgeRuntime.reload(resDir);
            cardsKey = key;
            r.put("reused", false);
            r.put("cards", cards.size());
            r.put("initMs", ForgeRuntime.getInitMillis());
            r.put("initPhases", new java.util.TreeMap<>(ForgeRuntime.getInitPhases()));
            return r;
        });
    }

    private static String resDir;
    private static String cardsKey;

    /** dir の直下のファイル（名前に区切りや .. を含むものは受け付けない） */
    private static Path safe(Path dir, String name) {
        Path p = dir.resolve(name).normalize();
        if (!p.getParent().equals(dir.normalize())) {
            throw new PuzzleValidationException("ファイル名が不正です: " + name);
        }
        return p;
    }

    /** API と Forge のバージョン。UI は api が想定と違えば読み込みをやめる */
    public static String version() {
        return run(() -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("api", API_VERSION);
            m.put("forge", FORGE_VERSION);
            return m;
        });
    }

    public static String load(String puzzleJson) {
        return run(() -> {
            if (session != null) {
                session.close();
                session = null;
            }
            PuzzleDefinition puzzle;
            try {
                puzzle = PuzzleDefinition.fromJson(puzzleJson);
            } catch (IllegalArgumentException | ClassCastException e) {
                throw new PuzzleValidationException("問題データを読めません: " + e.getMessage());
            }
            session = ForgeSession.load(puzzle);
            return step(session.lastStep());
        });
    }

    public static String submit(String optionIdsJson) {
        return run(() -> step(loaded().submit(Json.parseStringArray(optionIdsJson))));
    }

    public static String reset() {
        return run(() -> step(loaded().reset()));
    }

    /** A6: 長時間利用の確認用。GC 後のヒープ使用量と、生きているスレッド数（ゲームスレッドの解放漏れの検出） */
    public static String heap() {
        return run(() -> {
            System.gc();
            Runtime rt = Runtime.getRuntime();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("usedMB", (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024));
            m.put("threads", Thread.activeCount());
            return m;
        });
    }

    public static String state() {
        return run(() -> view(loaded()));
    }

    static final int API_VERSION = 2;
    static final String FORGE_VERSION = "2.0.15";

    private static ForgeSession loaded() {
        if (session == null) {
            throw new ApiException("NOT_LOADED", "問題が読み込まれていません");
        }
        return session;
    }

    /** 呼び出し側に返すエラーの種類（design/adapter-api.md） */
    static final class ApiException extends RuntimeException {
        final String code;

        ApiException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static Map<String, Object> step(ForgeSession.StepResult r) {
        ForgeSession s = session;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("engine", engineState(s, r));
        m.put("pending", toMap(s, r.pending()));
        m.put("events", r.events());
        m.put("elapsedMs", r.elapsedMillis());
        m.put("view", view(s));
        m.put("fallback", s.fallbackLog());
        // Java 側の判定（JVM のテストとの照合用。UI の判定は Puzzle Core が行う）
        Map<String, Object> judge = new LinkedHashMap<>();
        judge.put("status", r.status().name());
        judge.put("reason", r.reason());
        m.put("javaJudge", judge);
        return m;
    }

    /** エンジンの状態: AWAITING（選択待ち）/ GAME_OVER（終局）/ HALTED（期限を過ぎて停止）/ ERROR */
    private static Map<String, Object> engineState(ForgeSession s, ForgeSession.StepResult r) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (r.status() == ForgeSession.Status.ERROR) {
            m.put("state", "ERROR");
            m.put("message", r.reason());
        } else if (r.pending() != null) {
            m.put("state", "AWAITING");
        } else if (s.outcome() != null) {
            m.put("state", "GAME_OVER");
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("winner", s.outcome().winner());
            o.put("draw", s.outcome().draw());
            o.put("winCondition", s.outcome().winCondition());
            m.put("outcome", o);
        } else if (s.halted()) {
            m.put("state", "HALTED");
        } else {
            m.put("state", "ERROR");
            m.put("message", r.reason());
        }
        return m;
    }

    // record は明示的に変換する。
    // CheerpJ（Java 17 プレビュー）では record のリフレクション情報が取れず、{} になってしまうため。

    private static Map<String, Object> toMap(ForgeSession s, Decision d) {
        if (d == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("seq", d.seq());
        m.put("kind", d.kind().name());
        m.put("prompt", d.prompt());
        m.put("promptKey", d.promptKey());
        m.put("promptArgs", d.promptArgs() == null ? Map.of() : new LinkedHashMap<>(d.promptArgs()));
        m.put("min", d.min());
        m.put("max", d.max());
        List<Map<String, Object>> options = new ArrayList<>();
        for (Decision.Option o : d.options()) {
            Map<String, Object> om = new LinkedHashMap<>();
            om.put("id", o.id());
            om.put("label", o.label());
            om.put("labelJa", o.labelJa());
            om.put("ref", toMap(s, o.ref()));
            options.add(om);
        }
        m.put("options", options);
        return m;
    }

    private static Map<String, Object> toMap(ForgeSession s, Decision.Ref ref) {
        if (ref == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", ref.type());
        switch (ref.type()) {
            case "card" -> m.put("cardId", s.instanceIdOf(ref.forgeId()));
            case "player" -> m.put("player", ref.player());
            case "ability" -> {
                m.put("cardId", s.instanceIdOf(ref.forgeId()));
                m.put("abilityKind", ref.abilityKind());
            }
            case "stack" -> m.put("index", ref.stackIndex());
            default -> m.put("value", ref.special());
        }
        return m;
    }

    /**
     * UI に返す盤面。ライブラリーはどのプレイヤーも枚数だけ、相手の手札も枚数だけにする
     * （相手の手札・ライブラリーはパズルで重要でなく、UI でも最小限の表示にするため）。
     */
    private static Map<String, Object> view(ForgeSession s) {
        ForgeSession.GameSnapshot st = s.getState();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("turn", st.turn());
        m.put("phase", st.phase());
        m.put("activePlayer", st.activePlayer());
        m.put("priorityPlayer", st.priorityPlayer());
        List<Map<String, Object>> stack = new ArrayList<>();
        for (ForgeSession.StackState si : st.stack()) {
            Map<String, Object> sm = new LinkedHashMap<>();
            sm.put("index", si.index());
            sm.put("sourceId", si.sourceId());
            sm.put("controller", si.controller());
            sm.put("description", si.description());
            sm.put("descriptionJa", si.descriptionJa());
            sm.put("spell", si.spell());
            sm.put("targets", si.targets());
            stack.add(sm);
        }
        m.put("stack", stack);
        List<Map<String, Object>> combat = new ArrayList<>();
        for (ForgeSession.AttackState a : st.combat()) {
            Map<String, Object> am = new LinkedHashMap<>();
            am.put("attackerId", a.attackerId());
            am.put("defender", a.defender());
            am.put("blockers", a.blockers());
            combat.add(am);
        }
        m.put("combat", combat);
        List<Map<String, Object>> players = new ArrayList<>();
        for (ForgeSession.PlayerState p : st.players()) {
            boolean viewer = p.id().equals(s.viewer());
            Map<String, Object> pm = new LinkedHashMap<>();
            pm.put("id", p.id());
            pm.put("life", p.life());
            pm.put("poison", p.poison());
            pm.put("manaPool", p.manaPool());
            pm.put("handCount", p.handCount());
            pm.put("libraryCount", p.libraryCount());
            List<Map<String, Object>> cards = new ArrayList<>();
            for (ForgeSession.CardState c : p.cards()) {
                if (c.zone().equals("Library") || (!viewer && c.zone().equals("Hand"))) {
                    continue;
                }
                cards.add(toMap(c));
            }
            pm.put("cards", cards);
            players.add(pm);
        }
        m.put("players", players);
        return m;
    }

    private static Map<String, Object> toMap(ForgeSession.CardState c) {
        Map<String, Object> cm = new LinkedHashMap<>();
        cm.put("instanceId", c.instanceId());
        cm.put("name", c.name());
        cm.put("zone", c.zone());
        cm.put("owner", c.owner());
        cm.put("controller", c.controller());
        cm.put("kinds", c.kinds());
        cm.put("typeLine", c.typeLine());
        cm.put("manaCost", c.manaCost());
        cm.put("text", c.text());
        cm.put("power", c.power());
        cm.put("toughness", c.toughness());
        cm.put("basePower", c.basePower());
        cm.put("baseToughness", c.baseToughness());
        cm.put("damage", c.damage());
        cm.put("tapped", c.tapped());
        cm.put("sick", c.sick());
        cm.put("token", c.token());
        cm.put("faceDown", c.faceDown());
        cm.put("counters", c.counters());
        cm.put("attachedTo", c.attachedTo());
        cm.put("exiledBy", c.exiledBy());
        return cm;
    }

    private interface Body {
        Object call() throws Exception;
    }

    private static String run(Body body) {
        try {
            return Json.stringify(body.call());
        } catch (Throwable t) {
            t.printStackTrace();
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("code", errorCode(t));
            err.put("message", String.valueOf(t.getMessage() == null ? t : t.getMessage()));
            return Json.stringify(Map.of("error", err));
        }
    }

    private static String errorCode(Throwable t) {
        if (t instanceof ApiException a) {
            return a.code;
        }
        if (t instanceof PuzzleValidationException) {
            return "INVALID_PUZZLE";
        }
        if (t instanceof IllegalStateException && t.getMessage() != null && t.getMessage().startsWith("回答待ちの選択がありません")) {
            return "NO_PENDING";
        }
        if (t instanceof IllegalArgumentException) {
            // 選択肢にない ID・選択数の範囲外・回答の JSON の解析失敗
            return "INVALID_ANSWER";
        }
        return "INTERNAL";
    }

    /**
     * zip を展開する（展開したファイル数）。展開済み（同じサイズの zip）なら省いて -1。
     * CheerpJ の /files は IndexedDB に永続化されるため 2 回目以降に効く
     */
    private static int extract(String zipPath, String extractDir) throws IOException {
        Path marker = Path.of(extractDir, ".bundle-size");
        String size = String.valueOf(Files.size(Path.of(zipPath)));
        if (Files.exists(marker) && Files.readString(marker).equals(size)) {
            return -1;
        }
        deleteRecursively(Path.of(extractDir)); // 古いバンドルのファイルが残らないように
        int n = unzip(Path.of(zipPath), Path.of(extractDir));
        Files.writeString(marker, size);
        return n;
    }

    private static void deleteRecursively(Path dir) throws IOException {
        if (!Files.exists(dir)) {
            return;
        }
        try (java.util.stream.Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.delete(p);
            }
        }
    }

    private static int unzip(Path zip, Path dir) throws IOException {
        int n = 0;
        try (InputStream in = Files.newInputStream(zip); ZipInputStream z = new ZipInputStream(in)) {
            ZipEntry e;
            while ((e = z.getNextEntry()) != null) {
                Path target = dir.resolve(e.getName()).normalize();
                if (!target.startsWith(dir.normalize())) {
                    throw new IOException("zip の外に展開しようとしました: " + e.getName());
                }
                if (e.isDirectory()) {
                    Files.createDirectories(target);
                    continue;
                }
                Files.createDirectories(target.getParent());
                Files.copy(z, target, StandardCopyOption.REPLACE_EXISTING);
                n++;
            }
        }
        return n;
    }

    /** JVM 上での動作確認用: WebApi <zip> <dir> <puzzle.json> */
    public static void main(String[] args) throws Exception {
        System.out.println(init(args[0], args[1]));
        System.out.println(load(Files.readString(new File(args[2]).toPath())));
    }
}
