package mtgpuzzle.adapter;
import java.nio.file.*; import java.util.*;
/**
 * 問題を、ランダムな選び方で最後まで何度も進め、既定の答え（fallbackLog）とエンジンの異常（ERROR）を集める。
 * 未対応の選択・コストや、ゲームスレッドが止まる不具合を洗い出すために使う。
 *
 * 使い方: Fuzz <res ディレクトリ> <問題 JSON のディレクトリ> <1 問あたりの回数>
 */
public class Fuzz {
  public static void main(String[] a) throws Exception {
    ForgeRuntime.init(a[0], true);
    int runs = Integer.parseInt(a[2]);
    Map<String, Set<String>> fb = new TreeMap<>(); Map<String, Set<String>> errs = new TreeMap<>();
    try (var files = Files.list(Path.of(a[1]))) {
      for (Path f : files.filter(p -> p.toString().endsWith(".json") && !p.toString().endsWith(".solution.json") && !p.getFileName().toString().equals("index.json")).sorted().toList()) {
        String name = f.getFileName().toString();
        Random rnd = new Random(42);
        try (ForgeSession s = ForgeSession.load(PuzzleDefinition.fromJson(Files.readString(f)))) {
          for (int r = 0; r < runs; r++) {
            if (r > 0) s.reset();
            for (int step = 0; step < 40 && s.getPendingDecision() != null; step++) {
              Decision d = s.getPendingDecision();
              List<String> ids = new ArrayList<>();
              List<Decision.Option> opts = new ArrayList<>(d.options());
              if (d.kind() == Decision.Kind.PAY_MANA) { ids.add(rnd.nextInt(4) == 0 ? opts.get(1 + rnd.nextInt(Math.max(1, opts.size() - 2))).id() : "auto"); }
              else {
                opts.removeIf(o -> o.id().equals("cancel"));
                Collections.shuffle(opts, rnd);
                int k = d.min() + (d.max() > d.min() ? rnd.nextInt(d.max() - d.min() + 1) : 0);
                if (d.kind() == Decision.Kind.PRIORITY && rnd.nextInt(3) == 0) { ids.add("pass"); }
                else for (int i = 0; i < Math.min(k, opts.size()); i++) ids.add(opts.get(i).id());
                if (d.kind() == Decision.Kind.PRIORITY && ids.isEmpty()) ids.add("pass");
              }
              try { s.submit(ids); } catch (IllegalArgumentException e) { break; }
            }
            fb.computeIfAbsent(name, k -> new TreeSet<>()).addAll(s.fallbackLog());
            if (s.lastStep().status() == ForgeSession.Status.ERROR) errs.computeIfAbsent(name, k -> new TreeSet<>()).add(s.lastStep().reason().substring(0, Math.min(160, s.lastStep().reason().length())));
          }
        } catch (Exception e) { errs.computeIfAbsent(name, k -> new TreeSet<>()).add("LOAD " + e); }
      }
    }
    fb.forEach((k, v) -> { if (!v.isEmpty()) System.out.println("FB  " + k + " " + v); });
    errs.forEach((k, v) -> System.out.println("ERR " + k + " " + v));
    System.exit(0);
  }
}
