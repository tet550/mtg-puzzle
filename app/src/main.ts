// 入口。#/ は問題の一覧、#/play/<id> はその問題を遊ぶ画面、#/edit（または #/edit/<id>）は盤面エディタ。
// #/play?p=<data>（または #p=<data>）と #/edit?p=<data> で URL 共有パズルを直接読み込む。
import "./ui/style.css";
import { ForgeEngine } from "./engine/client";
import { loadCatalog, loadPuzzle } from "./puzzle/catalog";
import { validatePuzzle, type PuzzleJson } from "./puzzle/schema";
import {
  decodePuzzleFromParam,
  decodeSolutionFromParam,
  parsePlayRouteLocation,
  parseShareLocation,
} from "./puzzle/share";
import type { SolutionStep } from "./puzzle/solution";
import { renderCatalog } from "./ui/catalog";
import { DeckPage, openMulliganDialog } from "./ui/deck";
import { h } from "./ui/dom";
import { EditPage, saveEditorDraft } from "./ui/edit";
import { loadCardImages } from "./ui/images";
import { onLangChange } from "./i18n";
import { PlayPage } from "./ui/play";
import { extractDeckFromPlaytestPuzzle, type DeckDef } from "./puzzle/deck";

// ?timeout=<秒> でエンジンの 1 回の呼び出しの待ち時間を変える（調査用）
const timeout = Number(new URLSearchParams(location.search).get("timeout"));
const engine = new ForgeEngine(timeout > 0 ? { callTimeoutMs: timeout * 1000 } : {});
const root = document.getElementById("app")!;
let page: PlayPage | EditPage | DeckPage | null = null;

// 一覧を見ている間にエンジンの準備を始めておく（数秒かかるため）
void engine.start().catch(() => { /* 画面ごとに状態を出す */ });

function openEditor(initialPuzzle?: PuzzleJson) {
  page?.dispose();
  const editPage = new EditPage(
    engine,
    () => { location.hash = "#/"; },
    (testPuzzle) => {
      void startTestPlay(testPuzzle);
    },
    initialPuzzle,
  );
  page = editPage;
  root.replaceChildren(editPage.el);
}

async function startTestPlay(puzzle: PuzzleJson) {
  page?.dispose();
  const playPage = new PlayPage(
    engine,
    "editor-test",
    () => {
      openEditor(puzzle);
    },
    {
      backKey: "editor.backToEdit",
      backTitleKey: "editor.backToEdit.title",
      toBackKey: "editor.backToEdit",
      recordClear: false,
      onOpenEditor: (snap) => {
        openEditor(snap);
      },
      onRegisterSolution: (steps: SolutionStep[]) => {
        if (steps.length > 0) puzzle.solution = steps;
        else delete puzzle.solution;
        saveEditorDraft(puzzle);
      },
    },
  );
  page = playPage;
  root.replaceChildren(playPage.el);
  await playPage.load(puzzle);
}

function openDecks(initialDeckId?: string) {
  page?.dispose();
  const deckPage = new DeckPage(
    () => { location.hash = "#/"; },
    (playtestPuzzle, deck) => {
      void startDeckPlaytest(playtestPuzzle, deck);
    },
    initialDeckId,
  );
  page = deckPage;
  root.replaceChildren(deckPage.el);
}

async function startDeckPlaytest(puzzle: PuzzleJson, deck: DeckDef) {
  page?.dispose();
  const playPage = new PlayPage(
    engine,
    `playtest-${deck.id}`,
    () => {
      openDecks(deck.id);
    },
    {
      backKey: "playtest.backToDecks",
      backTitleKey: "playtest.backToDecks.title",
      toBackKey: "playtest.toDecks",
      recordClear: false,
      onOpenEditor: (snap) => {
        openEditor(snap);
      },
      onNewHand: () => {
        openMulliganDialog(deck, (nextPuzzle, nextDeck) => {
          void startDeckPlaytest(nextPuzzle, nextDeck);
        });
      },
    },
  );
  page = playPage;
  root.replaceChildren(playPage.el);
  await playPage.load(puzzle);
}

async function route() {
  page?.dispose();
  page = null;

  const share = parseShareLocation(location.hash);
  if (share) {
    let sharedSolution: SolutionStep[] | undefined;
    if (share.solutionParam) {
      try {
        const sol = await decodeSolutionFromParam(share.solutionParam);
        if (sol && sol.length > 0) sharedSolution = sol;
      } catch { /* 無効な s パラメータは無視 */ }
    }
    if (share.mode === "edit") {
      try {
        const res = await decodePuzzleFromParam(share.param);
        if (res.ok && sharedSolution) res.puzzle.solution = sharedSolution;
        openEditor(res.ok ? res.puzzle : undefined);
      } catch {
        openEditor();
      }
      return;
    }
    let decoded: Awaited<ReturnType<typeof decodePuzzleFromParam>> | null = null;
    let decodeErr: unknown = null;
    try {
      decoded = await decodePuzzleFromParam(share.param);
    } catch (e) {
      decodeErr = e;
    }
    const sharedDeck = decoded && decoded.ok ? extractDeckFromPlaytestPuzzle(decoded.puzzle) : null;
    const playPage = new PlayPage(engine, "shared", () => { location.hash = "#/"; }, {
      recordClear: false,
      sharedSolution,
      onOpenEditor: (snap) => {
        openEditor(snap);
      },
      onNewHand: sharedDeck
        ? () => {
            openMulliganDialog(sharedDeck, (nextPuzzle, nextDeck) => {
              void startDeckPlaytest(nextPuzzle, nextDeck);
            });
          }
        : undefined,
    });
    page = playPage;
    root.replaceChildren(playPage.el);
    if (decodeErr != null) {
      await playPage.load({ error: String(decodeErr) });
    } else if (decoded) {
      await playPage.load(decoded.ok ? decoded.puzzle : { error: decoded.errors.join(" / ") });
    }
    return;
  }

  const playRoute = parsePlayRouteLocation(location.hash);
  if (playRoute) {
    const { id, solutionParam } = playRoute;
    let sharedSolution: SolutionStep[] | undefined;
    if (solutionParam) {
      try {
        const sol = await decodeSolutionFromParam(solutionParam);
        if (sol && sol.length > 0) sharedSolution = sol;
      } catch { /* 無効な s パラメータは無視 */ }
    }
    const playPage = new PlayPage(engine, id, () => { location.hash = "#/"; }, {
      sharedSolution,
      onOpenEditor: (snap) => {
        openEditor(snap);
      },
    });
    page = playPage;
    root.replaceChildren(playPage.el);
    try {
      await playPage.load(await loadPuzzle(id));
    } catch (e) {
      await playPage.load({ error: String(e) });
    }
    return;
  }

  const decksMatch = /^#\/decks(?:\/([\w-]+))?$/.exec(location.hash);
  if (decksMatch) {
    openDecks(decksMatch[1]);
    return;
  }

  const editMatch = /^#\/edit(?:\/([\w-]+))?$/.exec(location.hash);
  if (editMatch) {
    const templateId = editMatch[1];
    if (templateId) {
      try {
        const res = validatePuzzle(await loadPuzzle(templateId));
        openEditor(res.ok ? res.puzzle : undefined);
      } catch {
        openEditor();
      }
    } else {
      openEditor();
    }
    return;
  }

  try {
    root.replaceChildren(
      renderCatalog(
        await loadCatalog(),
        (id) => { location.hash = `#/play/${id}`; },
        (id) => { location.hash = id ? `#/edit/${id}` : "#/edit"; },
        () => { location.hash = "#/decks"; },
      ),
    );
  } catch (e) {
    root.replaceChildren(h("div.fatal", null, String(e)));
  }
}

window.addEventListener("hashchange", () => void route());
// 言語を切り替えたら描き直す（遊んでいる問題はそのまま。一覧は作り直す）
onLangChange(() => {
  if (page) page.refresh();
  else void route();
});
// 画像の URL の一覧（小さい JSON）を読んでから描く。読めなければ文字のカードになる
void loadCardImages().then(route);

// 自動テスト（Playwright）用
Object.assign(window, { __engine: engine, __page: () => page });
