package mtgpuzzle.adapter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.File;
import java.util.List;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import mtgpuzzle.adapter.ForgeSession.CardState;
import mtgpuzzle.adapter.ForgeSession.GameSnapshot;
import mtgpuzzle.adapter.ForgeSession.Status;
import mtgpuzzle.adapter.ForgeSession.StepResult;

/** 検証シナリオ（design/verification-plan.md の S1〜S5 と追加分） */
class ScenarioTest {

    @BeforeAll
    static void init() {
        ForgeRuntime.init(ForgeRuntime.defaultResDir(), Boolean.parseBoolean(System.getProperty("lazy", "true")));
        System.gc();
        Runtime rt = Runtime.getRuntime();
        System.out.println("[metric] init(lazy=" + System.getProperty("lazy", "true") + ") ms=" + ForgeRuntime.getInitMillis()
                + " heapUsedMB=" + (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024));
    }

    static PuzzleDefinition puzzle(String name) throws Exception {
        return PuzzleDefinition.fromJson(java.nio.file.Files.readString(new File(System.getProperty("puzzles.dir", "../puzzles"), name + ".json").toPath()));
    }

    static void log(String scenario, StepResult r) {
        System.out.println("[" + scenario + "] " + r.status() + " " + r.reason() + " (" + r.elapsedMillis() + "ms) pending="
                + (r.pending() == null ? null : r.pending().kind() + " " + r.pending().options()) + " events=" + r.events());
    }

    static Decision expect(ForgeSession s, Decision.Kind kind) {
        Decision d = s.getPendingDecision();
        assertNotNull(d, "選択要求がありません: " + s.lastStep());
        assertEquals(kind, d.kind(), "選択要求の種類: " + d);
        return d;
    }

    static CardState card(GameSnapshot st, String instanceId) {
        return st.players().stream().flatMap(p -> p.cards().stream())
                .filter(c -> instanceId.equals(c.instanceId())).findFirst().orElseThrow();
    }

    @Test
    void s1_boltToFaceWins() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            log("S1 load", s.lastStep());
            GameSnapshot st = s.getState();
            assertEquals("MAIN1", st.phase());
            assertEquals(3, st.players().get(1).life());
            assertFalse(card(st, "c2").tapped());

            Decision d = expect(s, Decision.Kind.PRIORITY);
            StepResult r = s.submit(d.findByLabelPrefix("Lightning Bolt").id());
            log("S1 cast", r);
            Decision t = expect(s, Decision.Kind.TARGETS);
            r = s.submit(t.findByLabelPrefix("player:p2").id());
            log("S1 target", r);
            // マナの支払い: 起動するマナ源を手動で選ぶ
            Decision pay = expect(s, Decision.Kind.PAY_MANA);
            r = s.submit(pay.findByLabelPrefix("Mountain").id());
            log("S1 pay", r);
            // スタックに積まれた状態で p1 に優先権が戻る → パスすると解決
            assertEquals(1, s.getState().stackSize());
            assertTrue(card(s.getState(), "c2").tapped(), "選んだ Mountain がタップされている");
            r = s.submit("pass");
            log("S1 resolve", r);
            assertEquals(Status.CLEARED, r.status(), r.reason());
            System.out.println("[S1] fallback=" + s.fallbackLog());
        }
    }

    @Test
    void s2_attackWins() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s2-attack"))) {
            StepResult r = s.lastStep();
            int guard = 0;
            while (s.getPendingDecision() != null && s.getPendingDecision().kind() == Decision.Kind.PRIORITY && guard++ < 10) {
                r = s.submit("pass");
            }
            log("S2 to combat", r);
            Decision a = expect(s, Decision.Kind.ATTACKERS);
            r = s.submit(a.findByLabelPrefix("Hill Giant").id());
            log("S2 attack", r);
            guard = 0;
            while (s.getPendingDecision() != null && guard++ < 10) {
                r = s.submit("pass");
            }
            log("S2 end", r);
            assertEquals(Status.CLEARED, r.status(), r.reason());
        }
    }

    @Test
    void s3_passingUntilEndOfTurnFails() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            StepResult r = s.lastStep();
            int guard = 0;
            while (s.getPendingDecision() != null && guard++ < 30) {
                Decision d = s.getPendingDecision();
                r = d.kind() == Decision.Kind.ATTACKERS ? s.submit() : s.submit("pass");
            }
            log("S3 pass-only", r);
            assertEquals(Status.FAILED, r.status(), r.reason());
            assertTrue(r.reason().contains("期限"), r.reason());
        }
    }

    @Test
    void s3b_boltSelfLoses() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s3-self-bolt"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Lightning Bolt").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p1").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            StepResult r = s.submit("pass");
            log("S3b", r);
            assertEquals(Status.FAILED, r.status(), r.reason());
            assertTrue(r.reason().contains("敗北"), r.reason());
        }
    }

    @Test
    void s4_etbTriggerTargetsExternally() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s4-etb-trigger"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Flametongue Kavu").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id()); // 4 マナを自動で支払う
            StepResult r = s.submit("pass"); // FTK を解決 → ETB 誘発 → 対象選択
            log("S4 resolve creature", r);
            Decision t = expect(s, Decision.Kind.TARGETS);
            r = s.submit(t.findByLabelPrefix("Grizzly Bears").id());
            log("S4 trigger target", r);
            r = s.submit("pass"); // 誘発を解決
            log("S4 resolve trigger", r);
            GameSnapshot st = s.getState();
            assertEquals("GRAVEYARD", card(st, "b1").zone().toUpperCase());
            assertEquals("BATTLEFIELD", card(st, "c1").zone().toUpperCase());
            assertEquals(Status.IN_PROGRESS, r.status());
            System.out.println("[S4] fallback=" + s.fallbackLog());
        }
    }

    @Test
    void s5_resetRestoresInitialState() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            GameSnapshot initial = s.getState();
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Lightning Bolt").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            assertTrue(card(s.getState(), "c2").tapped());

            long t0 = System.nanoTime();
            StepResult r = s.reset();
            System.out.println("[metric] reset ms=" + (System.nanoTime() - t0) / 1_000_000);
            log("S5 reset", r);
            GameSnapshot after = s.getState();
            assertEquals(normalize(initial), normalize(after));
            // リセット後もそのまま解ける
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Lightning Bolt").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            assertEquals(Status.CLEARED, s.submit("pass").status());
        }
    }

    /** Forge のカード ID はリセットで変わりうるので、インスタンス ID ベースで比較する */
    private static String normalize(GameSnapshot st) {
        StringBuilder sb = new StringBuilder(st.turn() + "/" + st.phase() + "/" + st.activePlayer() + "/" + st.stackSize() + "\n");
        st.players().forEach(p -> {
            sb.append(p.id()).append(" life=").append(p.life()).append('\n');
            p.cards().forEach(c -> sb.append("  ").append(c.instanceId()).append(' ').append(c.name()).append(' ')
                    .append(c.zone()).append(" tapped=").append(c.tapped()).append(" sick=").append(c.sick())
                    .append(' ').append(c.counters()).append('\n'));
        });
        return sb.toString();
    }

    @Test
    void s6_activatedAbilityWins() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s6-activated"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Prodigal Pyromancer").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            StepResult r = s.submit("pass");
            log("S6", r);
            assertEquals(Status.CLEARED, r.status(), r.reason());
        }
    }

    @Test
    void invalidAnswerKeepsDecisionPending() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            Decision d = expect(s, Decision.Kind.PRIORITY);
            assertThrows(IllegalArgumentException.class, () -> s.submit("zzz"));
            assertThrows(IllegalArgumentException.class, () -> s.submit("pass", "a0"));
            // 不正な回答のあとも同じ選択要求が残り、そのまま続けられる
            assertEquals(d, s.getPendingDecision());
            s.submit(d.findByLabelPrefix("Lightning Bolt").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            assertEquals(Status.CLEARED, s.submit("pass").status());
        }
    }

    @Test
    void cancelManaPaymentRollsBack() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Lightning Bolt").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            StepResult r = s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Cancel").id());
            log("cancel pay", r);
            // 支払いを取りやめると、唱える前の状態に戻る（Bolt は手札、Mountain はアンタップ、スタックは空）
            GameSnapshot st = s.getState();
            assertEquals("HAND", card(st, "c1").zone().toUpperCase());
            assertFalse(card(st, "c2").tapped());
            assertEquals(0, st.stackSize());
            assertEquals(Decision.Kind.PRIORITY, s.getPendingDecision().kind());
        }
    }

    @Test
    void s7_invalidCardIsRejected() throws Exception {
        PuzzleValidationException e = assertThrows(PuzzleValidationException.class, () -> ForgeSession.load(puzzle("s7-invalid-card")));
        System.out.println("[S7] " + e.getMessage());
    }

    @Test
    void s8_summoningSickCreatureCannotAttack() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s8-sick-attacker"))) {
            GameSnapshot st = s.getState();
            assertTrue(card(st, "c1").sick());
            assertTrue(card(st, "c2").tapped());
            StepResult r = s.lastStep();
            int guard = 0;
            while (s.getPendingDecision() != null && guard++ < 30) {
                assertFalse(s.getPendingDecision().kind() == Decision.Kind.ATTACKERS, "召喚酔いのクリーチャーで攻撃できてしまう");
                r = s.submit("pass");
            }
            log("S8", r);
            assertEquals(Status.FAILED, r.status());
            List<String> fb = s.fallbackLog();
            System.out.println("[S8] fallback=" + fb);
        }
    }

    @Test
    void s9_xSpellAsksForNumber() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s9-x-spell"))) {
            StepResult r = s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Blaze").id());
            log("S9 cast", r);
            Decision x = expect(s, Decision.Kind.CHOOSE_NUMBER);
            r = s.submit(x.findByLabelPrefix("3").id());
            log("S9 X", r);
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            r = s.submit("pass");
            log("S9 resolve", r);
            assertEquals(Status.CLEARED, r.status(), r.reason());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void s10_modalSpellAsksForModes() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s10-modal"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Kolaghan's Command").id());
            Decision modes = expect(s, Decision.Kind.CHOOSE_MODE);
            assertEquals(2, modes.min());
            assertEquals(2, modes.max());
            StepResult r = s.submit(modes.findByLabelPrefix("Destroy target artifact").id(),
                    modes.findByLabelPrefix("Kolaghan's Command deals 2 damage").id());
            log("S10 modes", r);
            // 対象はモードごとに問い合わせる（モードの並び順）
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("Ornithopter").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            r = s.submit("pass");
            log("S10 resolve", r);
            assertEquals(Status.CLEARED, r.status(), r.reason());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void viewHasCardDetails() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s2-attack"))) {
            GameSnapshot st = s.getState();
            CardState giant = st.players().get(0).cards().stream().filter(c -> c.name().equals("Hill Giant")).findFirst().orElseThrow();
            assertEquals(List.of("creature"), giant.kinds());
            assertEquals(3, giant.power());
            assertEquals(3, giant.toughness());
            assertEquals("{3}{R}", giant.manaCost());
            assertEquals("p1", giant.owner());
            assertEquals(0, giant.damage());
        }
    }

    @Test
    void webApiV1HidesOpponentHandAndLibraries() throws Exception {
        String json = java.nio.file.Files.readString(new File(System.getProperty("puzzles.dir", "../puzzles"), "s10-modal.json").toPath());
        java.util.Map<String, Object> step = Json.parseObject(WebApi.load(json));
        @SuppressWarnings("unchecked")
        java.util.Map<String, Object> engine = (java.util.Map<String, Object>) step.get("engine");
        assertEquals("AWAITING", engine.get("state"));
        @SuppressWarnings("unchecked")
        List<java.util.Map<String, Object>> players = (List<java.util.Map<String, Object>>) ((java.util.Map<String, Object>) step.get("view")).get("players");
        @SuppressWarnings("unchecked")
        List<java.util.Map<String, Object>> p2cards = (List<java.util.Map<String, Object>>) players.get(1).get("cards");
        assertEquals(1, ((Number) players.get(1).get("handCount")).intValue());
        assertEquals(3, ((Number) players.get(1).get("libraryCount")).intValue());
        assertTrue(p2cards.stream().noneMatch(c -> c.get("zone").equals("Hand") || c.get("zone").equals("Library")), p2cards.toString());
        @SuppressWarnings("unchecked")
        List<java.util.Map<String, Object>> p1cards = (List<java.util.Map<String, Object>>) players.get(0).get("cards");
        assertTrue(p1cards.stream().anyMatch(c -> c.get("instanceId").equals("c1") && c.get("zone").equals("Hand")));
        // 選択肢は盤面のカードへの参照を持つ（インスタンス ID）
        @SuppressWarnings("unchecked")
        List<java.util.Map<String, Object>> options = (List<java.util.Map<String, Object>>) ((java.util.Map<String, Object>) step.get("pending")).get("options");
        assertTrue(options.stream().anyMatch(o -> o.get("ref") != null && "c1".equals(((java.util.Map<?, ?>) o.get("ref")).get("cardId"))), options.toString());
        // エラーは code と message の形
        java.util.Map<String, Object> err = Json.parseObject(WebApi.submit("[\"zzz\"]"));
        assertEquals("INVALID_ANSWER", ((java.util.Map<?, ?>) err.get("error")).get("code"));
        err = Json.parseObject(WebApi.load("{"));
        assertEquals("INVALID_PUZZLE", ((java.util.Map<?, ?>) err.get("error")).get("code"));
    }
}
