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

import com.fasterxml.jackson.databind.ObjectMapper;

import mtgpuzzle.adapter.ForgeSession.CardState;
import mtgpuzzle.adapter.ForgeSession.GameSnapshot;
import mtgpuzzle.adapter.ForgeSession.Status;
import mtgpuzzle.adapter.ForgeSession.StepResult;

/** 検証シナリオ（design/verification-plan.md の S1〜S5 と追加分） */
class ScenarioTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @BeforeAll
    static void init() {
        ForgeRuntime.init(ForgeRuntime.defaultResDir(), Boolean.parseBoolean(System.getProperty("lazy", "true")));
        System.gc();
        Runtime rt = Runtime.getRuntime();
        System.out.println("[metric] init(lazy=" + System.getProperty("lazy", "true") + ") ms=" + ForgeRuntime.getInitMillis()
                + " heapUsedMB=" + (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024));
    }

    static PuzzleDefinition puzzle(String name) throws Exception {
        return JSON.readValue(new File(System.getProperty("puzzles.dir", "../puzzles"), name + ".json"), PuzzleDefinition.class);
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
            // スタックに積まれた状態で p1 に優先権が戻る → パスすると解決
            assertEquals(1, s.getState().stackSize());
            assertTrue(card(s.getState(), "c2").tapped(), "Mountain が自動でタップされている");
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
}
