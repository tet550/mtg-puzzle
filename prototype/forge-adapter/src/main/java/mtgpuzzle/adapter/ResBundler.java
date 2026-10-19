package mtgpuzzle.adapter;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * ブラウザ向けに、Forge の res から必要なファイルだけを 1 つの zip にまとめる（ビルド時ツール）。
 * cardsfolder は問題で使うカードだけを含める。Forge の遅延ロードは索引作成のために全カードを読むので使えない。
 *
 * editions と tokenscripts も、既定では問題のカードに必要な分だけに絞る（C4）。
 * 全部入れるときは --full-editions / --all-tokens を付ける。
 *
 * 使い方: ResBundler <forge res dir> <puzzles dir> <output zip> [--full-editions] [--all-tokens] [追加カード名...]
 */
public final class ResBundler {
    private static final List<String> WHOLE_DIRS = List.of("blockdata", "setlookup");
    private static final java.util.regex.Pattern TOKEN_SCRIPT = java.util.regex.Pattern.compile("TokenScript\\$\\s*([^|]+)");
    private static final List<String> FILES = List.of("lists/TypeLists.txt", "lists/NonStackingKWList.txt",
            "languages/en-US.properties");

    public static void main(String[] args) throws IOException {
        Path res = Path.of(args[0]);
        Path puzzles = Path.of(args[1]);
        Path out = Path.of(args[2]);

        Set<String> names = new TreeSet<>();
        try (Stream<Path> files = Files.list(puzzles)) {
            for (Path p : files.filter(f -> f.toString().endsWith(".json")).toList()) {
                PuzzleDefinition def = PuzzleDefinition.fromJson(Files.readString(p));
                for (PuzzleDefinition.PlayerDef pl : def.game.players) {
                    for (List<PuzzleDefinition.CardDef> zone : List.of(pl.hand, pl.battlefield, pl.graveyard, pl.exile, pl.library)) {
                        zone.forEach(c -> names.add(c.cardId));
                    }
                }
            }
        }
        boolean fullEditions = false;
        boolean allTokens = false;
        for (int i = 3; i < args.length; i++) {
            switch (args[i]) {
                case "--full-editions" -> fullEditions = true;
                case "--all-tokens" -> allTokens = true;
                default -> names.add(args[i]);
            }
        }

        Map<String, Path> cardFiles = indexCardFiles(res.resolve("cardsfolder"));
        List<String> missing = new ArrayList<>();
        Files.createDirectories(out.toAbsolutePath().getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(out))) {
            int cards = 0;
            for (String name : names) {
                Path f = cardFiles.get(name.toLowerCase());
                if (f == null) {
                    missing.add(name);
                    continue;
                }
                put(zip, "cardsfolder/" + f.getFileName(), f);
                cards++;
            }
            // トークン: カードのスクリプトにある TokenScript$ の名前だけ
            Set<String> tokens = new TreeSet<>();
            for (String name : names) {
                Path f = cardFiles.get(name.toLowerCase());
                if (f == null) continue;
                java.util.regex.Matcher m = TOKEN_SCRIPT.matcher(Files.readString(f));
                while (m.find()) {
                    for (String t : m.group(1).split(",")) tokens.add(t.trim());
                }
            }
            if (allTokens) {
                putDir(zip, res, "tokenscripts");
            } else {
                for (String t : tokens) {
                    Path f = res.resolve("tokenscripts").resolve(t + ".txt");
                    if (Files.exists(f)) put(zip, "tokenscripts/" + t + ".txt", f);
                }
            }

            // エディション: カードごとに、収録しているエディションを 1 つだけ（Core / Expansion を優先）
            Set<Path> editions = new java.util.TreeSet<>();
            if (fullEditions) {
                putDir(zip, res, "editions");
            } else {
                Map<String, Path> editionOf = pickEditions(res.resolve("editions"), names);
                editions.addAll(editionOf.values());
                for (Path e : editions) put(zip, "editions/" + e.getFileName(), e);
            }
            System.out.println("tokens=" + tokens + " editions=" + editions.stream().map(e -> e.getFileName().toString()).toList());

            for (String dir : WHOLE_DIRS) {
                try (Stream<Path> walk = Files.walk(res.resolve(dir))) {
                    for (Path f : walk.filter(Files::isRegularFile).toList()) {
                        put(zip, res.relativize(f).toString().replace(File.separatorChar, '/'), f);
                    }
                }
            }
            for (String f : FILES) {
                put(zip, f, res.resolve(f));
            }
            System.out.println("cards=" + cards + " missing=" + missing + " -> " + out + " (" + Files.size(out) / 1024 + " KB before close)");
        }
        System.out.println("size=" + Files.size(out) / 1024 + " KB");
    }

    private static void putDir(ZipOutputStream zip, Path res, String dir) throws IOException {
        try (Stream<Path> walk = Files.walk(res.resolve(dir))) {
            for (Path f : walk.filter(Files::isRegularFile).toList()) {
                put(zip, res.relativize(f).toString().replace(File.separatorChar, '/'), f);
            }
        }
    }

    /** カード名 → そのカードを収録したエディションファイル（Core / Expansion で日付が最も古いもの） */
    private static Map<String, Path> pickEditions(Path dir, Set<String> names) throws IOException {
        Map<String, Path> best = new HashMap<>();
        Map<String, String> bestKey = new HashMap<>();
        Set<String> lower = new java.util.HashSet<>();
        names.forEach(n -> lower.add(n.toLowerCase()));
        try (Stream<Path> files = Files.list(dir)) {
            for (Path e : files.filter(f -> f.toString().endsWith(".txt")).toList()) {
                List<String> lines = Files.readAllLines(e, StandardCharsets.UTF_8);
                String type = "", date = "9999";
                boolean inCards = false;
                for (String l : lines) {
                    if (l.startsWith("Type=")) type = l.substring(5).trim();
                    if (l.startsWith("Date=")) date = l.substring(5).trim();
                    if (l.startsWith("[")) inCards = l.equals("[cards]");
                    else if (inCards && !l.isBlank()) {
                        // 例: "146 C Lightning Bolt @Christopher Moeller"
                        String[] parts = l.split(" ", 3);
                        if (parts.length < 3) continue;
                        String name = parts[2].split(" @")[0].trim().toLowerCase();
                        if (!lower.contains(name)) continue;
                        // 優先度: Core / Expansion を先に、その中で日付が古い順
                        String key = (type.equals("Core") || type.equals("Expansion") ? "0" : "1") + date;
                        if (!bestKey.containsKey(name) || key.compareTo(bestKey.get(name)) < 0) {
                            bestKey.put(name, key);
                            best.put(name, e);
                        }
                    }
                }
            }
        }
        return best;
    }

    private static Map<String, Path> indexCardFiles(Path cardsfolder) throws IOException {
        Map<String, Path> index = new HashMap<>();
        try (Stream<Path> walk = Files.walk(cardsfolder)) {
            for (Path f : walk.filter(p -> p.toString().endsWith(".txt")).toList()) {
                try (Stream<String> lines = Files.lines(f, StandardCharsets.UTF_8)) {
                    lines.filter(l -> l.startsWith("Name:")).findFirst()
                            .ifPresent(l -> index.putIfAbsent(l.substring(5).trim().toLowerCase(), f));
                }
            }
        }
        return index;
    }

    private static void put(ZipOutputStream zip, String name, Path file) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        Files.copy(file, (OutputStream) zip);
        zip.closeEntry();
    }
}
