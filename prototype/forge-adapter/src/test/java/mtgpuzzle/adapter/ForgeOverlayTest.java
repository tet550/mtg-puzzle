package mtgpuzzle.adapter;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;

import org.junit.jupiter.api.Test;

/**
 * Forge のクラスの上書き（tools/forge-overlay/generate.py、design/forge-overlay.md）が効いているか。
 * 効いていないと、ブラウザ（CheerpJ）で Card.keywordsToText を一定回数呼んだあとにゲームが止まる
 */
class ForgeOverlayTest {

    @Test
    void cardIsTheOverlay() throws Exception {
        Class<?> card = Class.forName("forge.game.card.Card");
        assertTrue(Arrays.stream(card.getDeclaredMethods()).anyMatch(m -> m.getName().equals("keywordToText")),
                "Card に keywordToText が無い（forge-game の Card のまま）");
        String from = card.getProtectionDomain().getCodeSource().getLocation().toString();
        assertFalse(from.contains("forge-game"), "Card が forge-game の jar から読まれている: " + from);
    }
}
