package mtgpuzzle.adapter;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * 縮めた jar（ProGuard 後）が壊れていないかを JVM で確かめるスモークテスト。
 * JUnit を使わず WebApi（JSON）経由でシナリオを流す。ブラウザの harness.js と同じ手順。
 *
 * 使い方: Smoke <res-mini.zip> <展開先> <puzzles dir>
 */
public final class Smoke {
    private record Case(String puzzle, List<String> picks, String expect) { }

    private static final List<Case> CASES = List.of(
            new Case("s1-bolt", List.of("Lightning Bolt", "player:p2", "Mountain", "Pass"), "CLEARED"),
            new Case("s2-attack", List.of("Pass", "Pass", "Hill Giant", "Pass", "Pass", "Pass", "Pass"), "CLEARED"),
            new Case("s3-self-bolt", List.of("Lightning Bolt", "player:p1", "Auto pay", "Pass"), "FAILED"),
            new Case("s4-etb-trigger", List.of("Flametongue Kavu", "Auto pay", "Pass", "Grizzly Bears", "Pass"), "IN_PROGRESS"),
            new Case("s6-activated", List.of("Prodigal Pyromancer", "player:p2", "Pass"), "CLEARED"),
            new Case("s8-sick-attacker", List.of("Pass", "Pass", "Pass", "Pass", "Pass", "Pass", "Pass", "Pass", "Pass", "Pass"), "FAILED"));

    public static void main(String[] args) throws Exception {
        System.out.println(WebApi.init(args[0], args[1]));
        int failed = 0;
        for (Case c : CASES) {
            String status = play(Files.readString(Path.of(args[2], c.puzzle() + ".json")), c.picks());
            boolean ok = status.equals(c.expect());
            failed += ok ? 0 : 1;
            System.out.println((ok ? "OK   " : "NG   ") + c.puzzle() + " -> " + status);
        }
        String bad = WebApi.load(Files.readString(Path.of(args[2], "s7-invalid-card.json")));
        boolean s7 = bad.contains("PuzzleValidationException");
        failed += s7 ? 0 : 1;
        System.out.println((s7 ? "OK   " : "NG   ") + "s7-invalid-card -> " + bad);
        System.out.println(failed == 0 ? "ALL OK" : failed + " FAILED");
        System.exit(failed == 0 ? 0 : 1);
    }

    @SuppressWarnings("unchecked")
    private static String play(String puzzleJson, List<String> picks) {
        Map<String, Object> step = Json.parseObject(WebApi.load(puzzleJson));
        for (String pick : picks) {
            Map<String, Object> d = (Map<String, Object>) step.get("pending");
            if (d == null) {
                break;
            }
            String id = null;
            for (Map<String, Object> o : (List<Map<String, Object>>) d.get("options")) {
                if (o.get("label").toString().startsWith(pick)) {
                    id = o.get("id").toString();
                    break;
                }
            }
            if (id == null) {
                return "NO_OPTION(" + pick + ")";
            }
            step = Json.parseObject(WebApi.submit(Json.stringify(List.of(id))));
        }
        return String.valueOf(step.get("status"));
    }
}
