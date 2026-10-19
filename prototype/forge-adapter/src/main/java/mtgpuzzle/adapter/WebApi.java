package mtgpuzzle.adapter;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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
            // 展開済み（同じサイズの zip）なら展開を省く。CheerpJ の /files は IndexedDB に永続化されるため 2 回目以降に効く
            Path marker = Path.of(extractDir, ".bundle-size");
            String size = String.valueOf(Files.size(Path.of(zipPath)));
            boolean cached = Files.exists(marker) && Files.readString(marker).equals(size);
            if (!cached) {
                deleteRecursively(Path.of(extractDir)); // 古いバンドルのファイルが残らないように
            }
            int files = cached ? 0 : unzip(Path.of(zipPath), Path.of(extractDir));
            if (!cached) {
                Files.writeString(marker, size);
            }
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

    public static String load(String puzzleJson) {
        return run(() -> {
            if (session != null) {
                session.close();
            }
            session = ForgeSession.load(PuzzleDefinition.fromJson(puzzleJson));
            return step(session.lastStep());
        });
    }

    public static String submit(String optionIdsJson) {
        return run(() -> step(session.submit(Json.parseStringArray(optionIdsJson))));
    }

    public static String reset() {
        return run(() -> step(session.reset()));
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
        return run(() -> toMap(session.getState()));
    }

    private static Map<String, Object> step(ForgeSession.StepResult r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("status", r.status().name());
        m.put("reason", r.reason());
        m.put("pending", toMap(r.pending()));
        m.put("events", r.events());
        m.put("elapsedMs", r.elapsedMillis());
        m.put("state", toMap(session.getState()));
        m.put("fallback", session.fallbackLog());
        return m;
    }

    // record は Jackson に任せず明示的に変換する。
    // CheerpJ（Java 17 プレビュー）では record のリフレクション情報が取れず、{} になってしまうため。

    private static Map<String, Object> toMap(Decision d) {
        if (d == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("seq", d.seq());
        m.put("kind", d.kind().name());
        m.put("prompt", d.prompt());
        m.put("min", d.min());
        m.put("max", d.max());
        List<Map<String, Object>> options = new java.util.ArrayList<>();
        for (Decision.Option o : d.options()) {
            Map<String, Object> om = new LinkedHashMap<>();
            om.put("id", o.id());
            om.put("label", o.label());
            options.add(om);
        }
        m.put("options", options);
        return m;
    }

    private static Map<String, Object> toMap(ForgeSession.GameSnapshot st) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("turn", st.turn());
        m.put("phase", st.phase());
        m.put("activePlayer", st.activePlayer());
        m.put("priorityPlayer", st.priorityPlayer());
        m.put("stackSize", st.stackSize());
        m.put("stack", st.stack());
        List<Map<String, Object>> players = new java.util.ArrayList<>();
        for (ForgeSession.PlayerState p : st.players()) {
            Map<String, Object> pm = new LinkedHashMap<>();
            pm.put("id", p.id());
            pm.put("name", p.name());
            pm.put("life", p.life());
            List<Map<String, Object>> cards = new java.util.ArrayList<>();
            for (ForgeSession.CardState c : p.cards()) {
                Map<String, Object> cm = new LinkedHashMap<>();
                cm.put("instanceId", c.instanceId());
                cm.put("forgeId", c.forgeId());
                cm.put("name", c.name());
                cm.put("zone", c.zone());
                cm.put("controller", c.controller());
                cm.put("tapped", c.tapped());
                cm.put("sick", c.sick());
                cm.put("counters", c.counters());
                cards.add(cm);
            }
            pm.put("cards", cards);
            players.add(pm);
        }
        m.put("players", players);
        return m;
    }

    private interface Body {
        Object call() throws Exception;
    }

    private static String run(Body body) {
        try {
            return Json.stringify(body.call());
        } catch (Throwable t) {
            t.printStackTrace();
            return Json.stringify(Map.of("error", String.valueOf(t)));
        }
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
