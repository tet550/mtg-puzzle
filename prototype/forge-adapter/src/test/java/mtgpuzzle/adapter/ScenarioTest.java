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

    /** マナ能力は優先権でも起動できる。出したマナはマナプールに残り、呪文の支払いに使われる（PAY_MANA は出ない） */
    @Test
    void manaAbilityAtPriority() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            Decision d = expect(s, Decision.Kind.PRIORITY);
            Decision.Option mountain = d.findByLabelPrefix("Mountain");
            assertEquals("mana", mountain.ref().abilityKind());
            StepResult r = s.submit(mountain.id());
            log("mana at priority", r);
            GameSnapshot st = s.getState();
            assertTrue(card(st, "c2").tapped());
            assertEquals(1, st.players().get(0).manaPool().get("R"));
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Lightning Bolt").id());
            r = s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            assertEquals(Decision.Kind.PRIORITY, r.pending().kind(), "マナプールで払えたので支払いの選択は出ない");
            assertEquals(Status.CLEARED, s.submit("pass").status());
        }
    }

    /** s1-bolt の Mountain（c2）を別のカードに替えた問題 */
    static PuzzleDefinition s1With(String cardName) throws Exception {
        return PuzzleDefinition.fromJson(java.nio.file.Files.readString(new File(System.getProperty("puzzles.dir", "../puzzles"), "s1-bolt.json").toPath())
                .replace("\"cardId\": \"Mountain\"", "\"cardId\": \"" + cardName + "\""));
    }

    /** 「好きな色 1 色」のマナ能力は、優先権で色ごとの選択肢になる。選べば起動のあとに色を聞かない。生け贄などのコストも払われる */
    @Test
    void manaAbilityColorChosenBeforeActivation() throws Exception {
        try (ForgeSession s = ForgeSession.load(s1With("Lotus Petal"))) {
            Decision d = expect(s, Decision.Kind.PRIORITY);
            List<Decision.Option> petal = d.options().stream().filter(o -> o.label().startsWith("Lotus Petal")).toList();
            assertEquals(List.of("W", "U", "B", "R", "G"), petal.stream().map(o -> o.ref().color()).toList());
            assertTrue(petal.stream().allMatch(o -> "mana".equals(o.ref().abilityKind())));
            StepResult r = s.submit(petal.get(4).id());
            log("petal", r);
            assertEquals(Decision.Kind.PRIORITY, r.pending().kind(), "色は先に選んだので聞かない");
            GameSnapshot st = s.getState();
            assertEquals(1, st.players().get(0).manaPool().get("G"));
            assertEquals("GRAVEYARD", card(st, "c2").zone().toUpperCase());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    /** 色を先に決められないマナ能力（違う色のマナ 2 点）は、起動のあとに 1 点ずつ色を聞く。選択肢にはカードと色が付く */
    @Test
    void manaAbilityAsksColorsAfterActivation() throws Exception {
        try (ForgeSession s = ForgeSession.load(s1With("Firemind Vessel"))) {
            Decision.Option vessel = expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Firemind Vessel");
            assertEquals(null, vessel.ref().color());
            s.submit(vessel.id());
            Decision first = expect(s, Decision.Kind.CHOOSE_MODE);
            assertEquals("color", first.promptKey());
            assertEquals("1", first.promptArgs().get("n"));
            assertEquals("2", first.promptArgs().get("of"));
            Decision.Option red = first.options().stream().filter(o -> "R".equals(o.ref().color())).findFirst().orElseThrow();
            assertEquals("color", red.ref().type());
            assertEquals(vessel.ref().forgeId(), red.ref().forgeId(), "色の選択肢に、能力の持ち主のカードが付く");
            s.submit(red.id());
            Decision second = expect(s, Decision.Kind.CHOOSE_MODE);
            assertTrue(second.options().stream().noneMatch(o -> "R".equals(o.ref().color())), "違う色なので赤は出ない");
            s.submit(second.options().stream().filter(o -> "G".equals(o.ref().color())).findFirst().orElseThrow().id());
            GameSnapshot st = s.getState();
            assertEquals(1, st.players().get(0).manaPool().get("R"));
            assertEquals(1, st.players().get(0).manaPool().get("G"));
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    /** 対象の選択には、唱えている呪文・起動している能力の持ち主のカード（source）が付く（画面はスタックに出して、そこから矢印を出す） */
    @Test
    void targetsCarryTheSourceCard() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Lightning Bolt").id());
            assertEquals("c1", s.instanceIdOf(expect(s, Decision.Kind.TARGETS).source()), "呪文");
        }
        try (ForgeSession s = ForgeSession.load(puzzle("s6-activated"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Prodigal Pyromancer").id());
            Decision t = expect(s, Decision.Kind.TARGETS);
            String id = s.instanceIdOf(t.source());
            assertEquals("Prodigal Pyromancer", card(s.getState(), id).name(), "起動型能力");
        }
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            assertEquals(-1, expect(s, Decision.Kind.PRIORITY).source(), "優先権には付かない");
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

    @Test
    void s11_crewWithTotalPower() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s11-crew"))) {
            StepResult r = s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Smuggler's Copter | Crew").id());
            log("S11 crew", r);
            // 搭乗: パワーの合計が 1 以上になるようにタップするクリーチャーを選ぶ
            Decision tap = expect(s, Decision.Kind.CHOOSE_CARDS);
            r = s.submit(tap.findByLabelPrefix("Grizzly Bears").id());
            log("S11 tap", r);
            assertTrue(card(s.getState(), "b1").tapped(), "灰色熊がタップされている");
            int guard = 0;
            while (s.getPendingDecision() != null && s.getPendingDecision().kind() == Decision.Kind.PRIORITY && guard++ < 10) {
                r = s.submit("pass");
            }
            Decision a = expect(s, Decision.Kind.ATTACKERS);
            r = s.submit(a.findByLabelPrefix("Smuggler's Copter").id());
            guard = 0;
            while (s.getPendingDecision() != null && guard++ < 10) {
                Decision d = s.getPendingDecision();
                r = d.kind() == Decision.Kind.CONFIRM ? s.submit("no") : s.submit("pass");
            }
            log("S11 end", r);
            assertEquals(Status.CLEARED, r.status(), r.reason());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void s12_planeswalkerMinusAbility() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s12-pw-minus"))) {
            // 忠誠カウンターを取り除くコスト（-2）。以前は counterTable が無くてゲームが止まっていた
            StepResult r = s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Ajani Vengeant | -2").id());
            log("S12 activate", r);
            r = s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            assertEquals(1, card(s.getState(), "w1").counters().getOrDefault("LOYALTY", 0));
            r = s.submit("pass");
            log("S12 resolve", r);
            assertEquals(Status.CLEARED, r.status(), r.reason());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void cancelCostChoiceRollsBack() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s11-crew"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Smuggler's Copter | Crew").id());
            Decision tap = expect(s, Decision.Kind.CHOOSE_CARDS);
            StepResult r = s.submit("cancel");
            log("cancel crew", r);
            // 取りやめると起動する前に戻る（灰色熊はアンタップのまま、スタックは空）
            assertFalse(card(s.getState(), "b1").tapped());
            assertEquals(0, s.getState().stackSize());
            assertEquals(Decision.Kind.PRIORITY, s.getPendingDecision().kind());
            assertNotNull(tap);
        }
    }

    /** S13: 相手は受けるダメージが最も少なくなるようにブロックする（Hill Giant を壁で止め、灰色熊の 2 点では足りない） */
    @Test
    void s13_opponentBlocksToMinimizeDamage() throws Exception {
        try (ForgeSession s = ForgeSession.load(puzzle("s13-opponent-blocks"))) {
            StepResult r = attackWithAll(s);
            log("S13 end", r);
            assertEquals(Status.FAILED, r.status(), r.reason());
            assertEquals(1, s.getState().players().get(1).life(), "灰色熊の 2 点だけが通る");
        }
        PuzzleDefinition noBlock = puzzle("s13-opponent-blocks");
        noBlock.opponent.block = "none";
        try (ForgeSession s = ForgeSession.load(noBlock)) {
            StepResult r = attackWithAll(s);
            assertEquals(Status.CLEARED, r.status(), r.reason());
        }
    }

    /** 戦闘まで進め、攻撃できるクリーチャーすべてで攻撃して、最後まで進める */
    private static StepResult attackWithAll(ForgeSession s) {
        StepResult r = s.lastStep();
        int guard = 0;
        while (s.getPendingDecision() != null && guard++ < 20) {
            Decision d = s.getPendingDecision();
            if (d.kind() == Decision.Kind.ATTACKERS) {
                r = s.submit(d.options().stream().map(Decision.Option::id).toArray(String[]::new));
            } else {
                r = s.submit("pass");
            }
        }
        return r;
    }

    /** 方式 A（design/option-i18n.md）: 選択肢に Forge の訳の日本語の文（labelJa）、説明に種類と値（promptKey / promptArgs）が付く */
    @Test
    void japaneseLabelsAndPromptKeys() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(Ja.available(), "日本語の訳（cardnames-ja-JP.txt）が無い");
        try (ForgeSession s = ForgeSession.load(puzzle("s10-modal"))) {
            Decision d = expect(s, Decision.Kind.PRIORITY);
            assertEquals("priority", d.promptKey());
            Decision.Option cmd = d.findByLabelPrefix("Kolaghan's Command");
            assertTrue(cmd.labelJa().startsWith("コラガンの命令 | 以下から２つを選ぶ"), cmd.labelJa());
            assertTrue(cmd.label().startsWith("Kolaghan's Command | Choose two"), "英語の文はそのまま: " + cmd.label());
            s.submit(cmd.id());
            Decision modes = expect(s, Decision.Kind.CHOOSE_MODE);
            assertEquals("mode", modes.promptKey());
            assertEquals("Kolaghan's Command", modes.promptArgs().get("card"));
            assertEquals("アーティファクト１つを対象とし、それを破壊する。", modes.findByLabelPrefix("Destroy target artifact").labelJa());
        }
        try (ForgeSession s = ForgeSession.load(puzzle("s1-bolt"))) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Lightning Bolt").id());
            Decision t = expect(s, Decision.Kind.TARGETS);
            assertEquals("targets", t.promptKey());
            assertEquals("Lightning Bolt", t.promptArgs().get("card"));
        }
    }

    private static PuzzleDefinition customPuzzle(List<String> p1Hand, List<String> p1Battlefield,
            List<String> p1Graveyard, List<String> p1Library, int p2Life, List<String> p2Battlefield) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"schemaVersion\":1,\"title\":\"test\",\"engine\":{\"type\":\"forge\",\"version\":\"2.0.15\"},");
        sb.append("\"game\":{\"activePlayer\":\"p1\",\"phase\":\"main1\",\"players\":[");
        sb.append("{\"id\":\"p1\",\"life\":20,\"hand\":").append(cardsJson("h", p1Hand));
        sb.append(",\"battlefield\":").append(cardsJson("b", p1Battlefield));
        sb.append(",\"graveyard\":").append(cardsJson("g", p1Graveyard));
        sb.append(",\"library\":").append(cardsJson("l", p1Library)).append("},");
        sb.append("{\"id\":\"p2\",\"life\":").append(p2Life).append(",\"battlefield\":").append(cardsJson("ob", p2Battlefield));
        sb.append(",\"library\":[{\"id\":\"ol0\",\"cardId\":\"Island\"}]}]},");
        sb.append("\"goal\":{\"type\":\"win\",\"player\":\"p1\",\"deadline\":\"current_turn\"},\"opponent\":{\"policy\":\"pass\"}}");
        return PuzzleDefinition.fromJson(sb.toString());
    }

    private static String cardsJson(String prefix, List<String> names) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < names.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append("{\"id\":\"").append(prefix).append(i).append("\",\"cardId\":\"").append(names.get(i)).append("\"}");
        }
        return sb.append("]").toString();
    }

    @Test
    void dividedDamageAsksForAllocation() throws Exception {
        PuzzleDefinition p = customPuzzle(
                List.of("Pyrotechnics"),
                List.of("Mountain", "Mountain", "Mountain", "Mountain", "Mountain"),
                List.of(),
                List.of("Island"),
                3,
                List.of("Llanowar Elves"));
        try (ForgeSession s = ForgeSession.load(p)) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Pyrotechnics").id());
            Decision t = expect(s, Decision.Kind.TARGETS);
            s.submit(t.findByLabelPrefix("Llanowar Elves").id(), t.findByLabelPrefix("player:p2").id());
            Decision div = expect(s, Decision.Kind.CHOOSE_NUMBER);
            assertEquals("divide", div.promptKey());
            s.submit(div.findByLabelPrefix("1").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            StepResult r = s.submit("pass");
            assertEquals(Status.CLEARED, r.status(), r.reason());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void modalAllowRepeat() throws Exception {
        PuzzleDefinition p = customPuzzle(
                List.of("Fiery Confluence", "Season of Loss"),
                List.of("Mountain", "Mountain", "Mountain", "Mountain", "Swamp", "Swamp", "Swamp", "Grizzly Bears"),
                List.of(),
                List.of("Island"),
                6,
                List.of("Llanowar Elves"));
        try (ForgeSession s = ForgeSession.load(p)) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Season of Loss").id());
            Decision m1 = expect(s, Decision.Kind.CHOOSE_MODE);
            assertEquals("h1", s.instanceIdOf(m1.source()));
            assertEquals(0, m1.min());
            assertEquals(1, m1.max());
            assertEquals(3, m1.options().size());
            assertTrue(m1.options().get(0).label().startsWith("{P} \u2014 "), m1.options().get(0).label());
            assertTrue(m1.options().get(1).label().startsWith("{P}{P} \u2014 "), m1.options().get(1).label());
            assertTrue(m1.options().get(2).label().startsWith("{P}{P}{P} \u2014 "), m1.options().get(2).label());
            // {P}{P}{P} を選ぶと残り予算 2 になり、次は {P} と {P}{P} の 2 択だけが出る
            s.submit(m1.options().get(2).id());
            Decision m2 = expect(s, Decision.Kind.CHOOSE_MODE);
            assertEquals(2, m2.options().size());
            s.submit(m2.options().get(0).id());
            // 途中で空回答を送るとモード選択を打ち切れる
            Decision m3 = expect(s, Decision.Kind.CHOOSE_MODE);
            s.submit();
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Cancel").id());

            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Fiery Confluence").id());
            for (int i = 0; i < 3; i++) {
                Decision m = expect(s, Decision.Kind.CHOOSE_MODE);
                assertEquals(1, m.min());
                assertEquals(1, m.max());
                s.submit(m.findByLabelPrefix("Fiery Confluence deals 2 damage").id());
            }
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            StepResult r = s.submit("pass");
            assertEquals(Status.CLEARED, r.status(), r.reason());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void scryAndSurveil() throws Exception {
        PuzzleDefinition p = customPuzzle(
                List.of("Opt", "Consider"),
                List.of("Island", "Island"),
                List.of(),
                List.of("Mountain", "Lightning Bolt", "Swamp"),
                3,
                List.of());
        try (ForgeSession s = ForgeSession.load(p)) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Opt").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            s.submit("pass");
            Decision scry = expect(s, Decision.Kind.CHOOSE_CARDS);
            assertEquals("scryBottom", scry.promptKey());
            // 先頭の Mountain を下に送り、次の Lightning Bolt を引く
            s.submit(scry.findByLabelPrefix("Mountain").id());
            assertTrue(s.getState().players().get(0).cards().stream()
                    .anyMatch(c -> "Lightning Bolt".equals(c.name()) && "HAND".equalsIgnoreCase(c.zone())));

            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Consider").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            s.submit("pass");
            Decision surveil = expect(s, Decision.Kind.CHOOSE_CARDS);
            assertEquals("surveilGrave", surveil.promptKey());
            s.submit(surveil.findByLabelPrefix("Swamp").id());
            assertTrue(s.getState().players().get(0).cards().stream()
                    .anyMatch(c -> "Swamp".equals(c.name()) && "GRAVEYARD".equalsIgnoreCase(c.zone())));
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void convokeAndDelve() throws Exception {
        PuzzleDefinition p = customPuzzle(
                List.of("Stoke the Flames", "Gurmag Angler", "Pile On"),
                List.of("Mountain", "Mountain", "Swamp", "Goblin Piker", "Goblin Piker", "Ygra, Eater of All", "Camellia, the Seedmiser"),
                List.of("Island", "Island", "Island", "Island", "Island", "Island"),
                List.of("Island"),
                4,
                List.of("Grizzly Bears"));
        try (ForgeSession s = ForgeSession.load(p)) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Pile On").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("Grizzly Bears").id());
            Decision pileConvoke = expect(s, Decision.Kind.CHOOSE_CARDS);
            assertEquals("convoke", pileConvoke.promptKey());
            assertEquals("h2", s.instanceIdOf(pileConvoke.source()));
            // 多色（黒緑）クリーチャー 2 体で {3}{B} の招集を払うとき、1 体目で {B}、2 体目で不特定マナが自動選択され色質問は出ない
            s.submit(pileConvoke.findByLabelPrefix("Ygra").id(), pileConvoke.findByLabelPrefix("Camellia").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Cancel").id());

            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Gurmag Angler").id());
            Decision delve = expect(s, Decision.Kind.CHOOSE_CARDS);
            assertEquals("delve", delve.promptKey());
            s.submit(delve.options().stream().map(Decision.Option::id).limit(6).toArray(String[]::new));
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Swamp").id());
            s.submit("pass");

            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Stoke the Flames").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("player:p2").id());
            Decision convoke = expect(s, Decision.Kind.CHOOSE_CARDS);
            assertEquals("convoke", convoke.promptKey());
            s.submit(convoke.findByLabelPrefix("Goblin Piker").id(),
                    convoke.options().stream().filter(o -> o.label().startsWith("Goblin Piker")).skip(1).findFirst().orElseThrow().id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            StepResult r = s.submit("pass");
            assertEquals(Status.CLEARED, r.status(), r.reason());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void stackSpellTargetingAndRetargeting() throws Exception {
        PuzzleDefinition p = customPuzzle(
                List.of("Lightning Bolt", "Reverberate"),
                List.of("Mountain", "Mountain", "Mountain"),
                List.of(),
                List.of("Island"),
                3,
                List.of("Grizzly Bears"));
        try (ForgeSession s = ForgeSession.load(p)) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Lightning Bolt").id());
            s.submit(expect(s, Decision.Kind.TARGETS).findByLabelPrefix("Grizzly Bears").id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            // スタックに Lightning Bolt がある状態で Reverberate を唱える
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Reverberate").id());
            Decision tgtSpell = expect(s, Decision.Kind.TARGETS);
            Decision.Option boltOnStack = tgtSpell.findByLabelPrefix("Lightning Bolt");
            assertTrue(boltOnStack.id().startsWith("s"), boltOnStack.toString());
            s.submit(boltOnStack.id());
            s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            // Reverberate を解決 → 新しい対象を選ぶ（TARGETS, optional なので min=0）→ player:p2 を選ぶ
            s.submit("pass");
            Decision newTgt = expect(s, Decision.Kind.TARGETS);
            assertEquals(0, newTgt.min());
            s.submit(newTgt.findByLabelPrefix("player:p2").id());
            StepResult r = s.submit("pass");
            assertEquals(Status.CLEARED, r.status(), r.reason());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }

    @Test
    void collectEvidenceCost() throws Exception {
        PuzzleDefinition p = customPuzzle(
                List.of("Extract a Confession"),
                List.of("Swamp", "Swamp"),
                List.of("Grizzly Bears", "Hill Giant", "Mountain"),
                List.of("Island"),
                20,
                List.of("Llanowar Elves", "Shivan Dragon"));
        try (ForgeSession s = ForgeSession.load(p)) {
            s.submit(expect(s, Decision.Kind.PRIORITY).findByLabelPrefix("Extract a Confession").id());
            // Collect evidence 6（任意の追加コスト）
            Decision opt = expect(s, Decision.Kind.CHOOSE_MODE);
            assertEquals("optionalCost", opt.promptKey());
            s.submit(opt.options().get(0).id());
            if (s.getPendingDecision().kind() == Decision.Kind.PAY_MANA) {
                s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
                Decision ev = expect(s, Decision.Kind.CHOOSE_CARDS);
                assertEquals("totalCMC", ev.promptKey());
                assertEquals("6", ev.promptArgs().get("n"));
                s.submit(ev.findByLabelPrefix("Grizzly Bears").id(), ev.findByLabelPrefix("Hill Giant").id());
            } else {
                Decision ev = expect(s, Decision.Kind.CHOOSE_CARDS);
                assertEquals("totalCMC", ev.promptKey());
                assertEquals("6", ev.promptArgs().get("n"));
                s.submit(ev.findByLabelPrefix("Grizzly Bears").id(), ev.findByLabelPrefix("Hill Giant").id());
                s.submit(expect(s, Decision.Kind.PAY_MANA).findByLabelPrefix("Auto pay").id());
            }
            s.submit("pass");
            // 証拠収集 6 を支払ったので、パワー最大の Shivan Dragon を生け贄に捧げさせる
            assertEquals("GRAVEYARD", card(s.getState(), "ob1").zone().toUpperCase());
            assertTrue(s.fallbackLog().isEmpty(), s.fallbackLog().toString());
        }
    }
}
