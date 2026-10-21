package mtgpuzzle.adapter;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * 問題を Adapter で実際に解けるかを、選択肢の探索で確かめる（Phase 1 M2）。
 * 解けた問題は、解答手順を {@code <名前>.solution.json} に書き出す（E2E テストでも使う）。
 * 既定の答え（fallbackLog）を使った手順は解けたとみなさない（Adapter が未対応の選択を含むため）。
 *
 * 使い方: Solver <res ディレクトリ> <問題 JSON のディレクトリ> <解答の出力先> [1 問あたりの秒数=15]
 *
 * 探索の決まり（分岐を減らすため）: マナは常に自動で支払う。攻撃は「全員」か「なし」。
 * 複数を選ぶ選択は、必要な最小数（0 なら 1）の組み合わせを 20 通りまで試す。
 */
public final class Solver {
    private static final int MAX_DEPTH = 40;
    private static final int MAX_COMBINATIONS = 20;

    /** 1 手: 選択要求の種類と、選んだ選択肢の位置（ID はリセットで変わりうるので位置で持つ）とラベル */
    record Move(Decision.Kind kind, List<Integer> indexes, List<String> labels) { }

    private final ForgeSession session;
    private final long deadline;
    private final List<Move> path = new ArrayList<>();
    private int nodes;

    private Solver(ForgeSession session, long deadline) {
        this.session = session;
        this.deadline = deadline;
    }

    public static void main(String[] args) throws Exception {
        if (args[0].equals("--verify")) {
            System.exit(verify(args[1], args[2], Path.of(args[3]), args.length > 4 ? Path.of(args[4]) : null));
        }
        ForgeRuntime.init(args[0], true);
        Path dir = Path.of(args[1]);
        Path out = Path.of(args[2]);
        long budgetMs = (args.length > 3 ? Long.parseLong(args[3]) : 15) * 1000;
        Files.createDirectories(out);
        List<Path> files;
        try (Stream<Path> s = Files.list(dir)) {
            files = s.filter(f -> f.toString().endsWith(".json") && !f.toString().endsWith(".solution.json")).sorted().toList();
        }
        int solved = 0;
        for (Path f : files) {
            String name = f.getFileName().toString().replaceFirst("\\.json$", "");
            long t0 = System.currentTimeMillis();
            String result;
            try (ForgeSession s = ForgeSession.load(PuzzleDefinition.fromJson(Files.readString(f)))) {
                if (s.lastStep().status() == ForgeSession.Status.ERROR) {
                    result = "ERROR " + s.lastStep().reason();
                } else {
                    Solver solver = new Solver(s, t0 + budgetMs);
                    List<Move> solution = solver.search(0) ? solver.path : null;
                    if (solution != null) {
                        Files.writeString(out.resolve(name + ".solution.json"), Json.stringify(toJson(name, solution)) + "\n");
                        solved++;
                        result = "SOLVED " + solution.size() + " moves";
                    } else {
                        result = (System.currentTimeMillis() > t0 + budgetMs ? "TIMEOUT" : "UNSOLVED") + " nodes=" + solver.nodes;
                    }
                }
            } catch (Throwable t) {
                result = "ERROR " + t;
            }
            System.out.println(name + "\t" + result + "\t" + (System.currentTimeMillis() - t0) + "ms");
        }
        System.out.println("solved " + solved + " / " + files.size());
        System.exit(0);
    }

    /**
     * --verify: res バンドル（zip）で初期化し、解答手順のある問題を WebApi 経由で解き直す。
     * 縮めた jar と、問題のカードだけの res で解けることを確かめる（tools/build-engine.sh から呼ぶ）。
     * カードデータ（CardData）を渡したときは、zip を共通の res として、問題ごとにカードを抜き出して
     * WebApi.useCards で初期化し直す（ブラウザと同じ流れ。問題を続けて読むので、初期化し直しの確かめにもなる）。
     */
    @SuppressWarnings("unchecked")
    private static int verify(String zip, String extractDir, Path dir, Path cardData) throws Exception {
        Map<String, Object> cards = null;
        if (cardData == null) {
            System.out.println(WebApi.init(zip, extractDir));
        } else {
            System.out.println(WebApi.prepare(zip, extractDir));
            cards = CardData.load(cardData);
        }
        List<Path> files;
        try (Stream<Path> s = Files.list(dir)) {
            files = s.filter(f -> f.toString().endsWith(".solution.json")).sorted().toList();
        }
        int failed = 0;
        for (Path f : files) {
            Map<String, Object> sol = Json.parseObject(Files.readString(f));
            String name = String.valueOf(sol.get("puzzle"));
            String puzzle = Files.readString(dir.resolve(name + ".json"));
            if (cards != null) {
                Map<String, Object> used = Json.parseObject(WebApi.useCards(
                        CardData.select(cards, CardData.cardNames(PuzzleDefinition.fromJson(puzzle)))));
                if (used.containsKey("error")) {
                    failed++;
                    System.out.println("NG   " + name + " -> " + used.get("error"));
                    continue;
                }
            }
            Map<String, Object> step = Json.parseObject(WebApi.load(puzzle));
            String why = null;
            for (Map<String, Object> st : (List<Map<String, Object>>) sol.get("steps")) {
                if (step.containsKey("error")) {
                    why = String.valueOf(step.get("error"));
                    break;
                }
                Map<String, Object> d = (Map<String, Object>) step.get("pending");
                if (d == null || !st.get("kind").equals(d.get("kind"))) {
                    why = "expected " + st.get("kind") + " but " + (d == null ? "no decision" : d.get("kind"));
                    break;
                }
                List<Map<String, Object>> options = (List<Map<String, Object>>) d.get("options");
                List<String> ids = new ArrayList<>();
                for (Object i : (List<Object>) st.get("indexes")) {
                    ids.add(String.valueOf(options.get(((Number) i).intValue()).get("id")));
                }
                step = Json.parseObject(WebApi.submit(Json.stringify(ids)));
            }
            if (why == null) {
                Map<String, Object> judge = (Map<String, Object>) step.get("javaJudge");
                List<Object> fb = (List<Object>) step.get("fallback");
                if (judge == null || !"CLEARED".equals(judge.get("status"))) {
                    why = "not cleared: " + (judge == null ? step : judge);
                } else if (fb != null && !fb.isEmpty()) {
                    why = "fallback: " + fb;
                }
            }
            failed += why == null ? 0 : 1;
            System.out.println((why == null ? "OK   " : "NG   ") + name + (why == null ? "" : " -> " + why));
        }
        System.out.println(failed == 0 ? "ALL OK (" + files.size() + ")" : failed + " FAILED");
        return failed == 0 ? 0 : 1;
    }

    private static Map<String, Object> toJson(String name, List<Move> moves) {
        List<Map<String, Object>> steps = new ArrayList<>();
        for (Move m : moves) {
            Map<String, Object> st = new LinkedHashMap<>();
            st.put("kind", m.kind().name());
            st.put("indexes", m.indexes());
            st.put("labels", m.labels());
            steps.add(st);
        }
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("puzzle", name);
        o.put("steps", steps);
        return o;
    }

    /** 今の局面（path をたどった所）から解を探す。見つかれば path に解が残る */
    private boolean search(int depth) {
        nodes++;
        ForgeSession.StepResult last = session.lastStep();
        if (last.status() == ForgeSession.Status.CLEARED) {
            return session.fallbackLog().isEmpty();
        }
        Decision d = session.getPendingDecision();
        if (last.status() != ForgeSession.Status.IN_PROGRESS || d == null || depth >= MAX_DEPTH
                || System.currentTimeMillis() > deadline || !session.fallbackLog().isEmpty()) {
            return false;
        }
        boolean first = true;
        for (List<Integer> choice : choices(d)) {
            if (!first) {
                replay(); // 2 つ目以降の候補は、親の局面に戻してから試す
            }
            first = false;
            List<String> ids = new ArrayList<>();
            List<String> labels = new ArrayList<>();
            for (int i : choice) {
                ids.add(d.options().get(i).id());
                labels.add(d.options().get(i).label());
            }
            path.add(new Move(d.kind(), choice, labels));
            try {
                session.submit(ids);
            } catch (RuntimeException e) {
                path.remove(path.size() - 1);
                continue;
            }
            if (search(depth + 1)) {
                return true;
            }
            path.remove(path.size() - 1);
            if (System.currentTimeMillis() > deadline) {
                return false;
            }
        }
        return false;
    }

    /** 初期盤面から path をたどり直す */
    private void replay() {
        session.reset();
        for (Move m : path) {
            Decision d = session.getPendingDecision();
            List<String> ids = new ArrayList<>();
            for (int i : m.indexes()) {
                ids.add(d.options().get(i).id());
            }
            session.submit(ids);
        }
    }

    /** 試す候補（選択肢の位置の組）。有望そうな順に並べる */
    private static List<List<Integer>> choices(Decision d) {
        int n = d.options().size();
        List<List<Integer>> out = new ArrayList<>();
        switch (d.kind()) {
            case PRIORITY -> {
                for (int i = 0; i < n; i++) {
                    if (!d.options().get(i).id().equals("pass")) {
                        out.add(List.of(i));
                    }
                }
                for (int i = 0; i < n; i++) {
                    if (d.options().get(i).id().equals("pass")) {
                        out.add(List.of(i));
                    }
                }
            }
            case PAY_MANA -> {
                for (int i = 0; i < n; i++) {
                    if (d.options().get(i).id().equals("auto")) {
                        out.add(List.of(i));
                    }
                }
            }
            case ATTACKERS -> {
                List<Integer> all = new ArrayList<>();
                for (int i = 0; i < n; i++) {
                    all.add(i);
                }
                out.add(all);
                if (!all.isEmpty()) {
                    out.add(List.of());
                }
            }
            default -> {
                int k = Math.max(d.min(), Math.min(1, d.max()));
                if (d.kind() == Decision.Kind.CHOOSE_MODE) {
                    k = d.max();
                }
                combinations(n, k, 0, new ArrayList<>(), out);
                if (d.min() == 0 && k > 0) {
                    out.add(List.of());
                }
            }
        }
        return out;
    }

    private static void combinations(int n, int k, int from, List<Integer> cur, List<List<Integer>> out) {
        if (out.size() >= MAX_COMBINATIONS) {
            return;
        }
        if (cur.size() == k) {
            out.add(List.copyOf(cur));
            return;
        }
        for (int i = from; i < n; i++) {
            cur.add(i);
            combinations(n, k, i + 1, cur, out);
            cur.remove(cur.size() - 1);
        }
    }
}
