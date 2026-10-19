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

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * ブラウザ向けに、Forge の res から必要なファイルだけを 1 つの zip にまとめる（ビルド時ツール）。
 * cardsfolder は問題で使うカードだけを含める。Forge の遅延ロードは索引作成のために全カードを読むので使えない。
 *
 * 使い方: ResBundler <forge res dir> <puzzles dir> <output zip> [追加カード名...]
 */
public final class ResBundler {
    private static final List<String> WHOLE_DIRS = List.of("editions", "tokenscripts", "blockdata", "setlookup", "ai");
    private static final List<String> FILES = List.of("lists/TypeLists.txt", "lists/NonStackingKWList.txt",
            "languages/en-US.properties");

    public static void main(String[] args) throws IOException {
        Path res = Path.of(args[0]);
        Path puzzles = Path.of(args[1]);
        Path out = Path.of(args[2]);

        Set<String> names = new TreeSet<>();
        ObjectMapper json = new ObjectMapper();
        try (Stream<Path> files = Files.list(puzzles)) {
            for (Path p : files.filter(f -> f.toString().endsWith(".json")).toList()) {
                PuzzleDefinition def = json.readValue(p.toFile(), PuzzleDefinition.class);
                for (PuzzleDefinition.PlayerDef pl : def.game.players) {
                    for (List<PuzzleDefinition.CardDef> zone : List.of(pl.hand, pl.battlefield, pl.graveyard, pl.exile, pl.library)) {
                        zone.forEach(c -> names.add(c.cardId));
                    }
                }
            }
        }
        for (int i = 3; i < args.length; i++) {
            names.add(args[i]);
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
