package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.List;

import forge.game.player.Player;

/** 外部入力に置き換えていない選択に、既定の答えを返した記録（1 回のゲームの分）。対応が必要な選択を洗い出すために使う */
final class FallbackLog {
    private final List<String> entries = new ArrayList<>();

    synchronized void add(Player p, String what) {
        entries.add(p.getName() + ": " + what);
    }

    synchronized void clear() {
        entries.clear();
    }

    synchronized List<String> entries() {
        return List.copyOf(entries);
    }
}
