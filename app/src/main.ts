// 入口。#/ は問題の一覧、#/play/<id> はその問題を遊ぶ画面、#/edit（または #/edit/<id>）は盤面エディタ。
// #/play?p=<data>（または #p=<data>）と #/edit?p=<data> で URL 共有パズルを直接読み込む。
import "./ui/style.css";
import { ForgeEngine } from "./engine/client";
import { loadCatalog, loadPuzzle } from "./puzzle/catalog";
import { validatePuzzle, type PuzzleJson } from "./puzzle/schema";
import { decodePuzzleFromParam, parseShareLocation } from "./puzzle/share";
import { renderCatalog } from "./ui/catalog";
import { h } from "./ui/dom";
import { EditPage } from "./ui/edit";
import { loadCardImages } from "./ui/images";
import { onLangChange } from "./i18n";
import { PlayPage } from "./ui/play";

// ?timeout=<秒> でエンジンの 1 回の呼び出しの待ち時間を変える（調査用）
const timeout = Number(new URLSearchParams(location.search).get("timeout"));
const engine = new ForgeEngine(timeout > 0 ? { callTimeoutMs: timeout * 1000 } : {});
const root = document.getElementById("app")!;
let page: PlayPage | EditPage | null = null;

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
    if (share.mode === "edit") {
      try {
        const res = await decodePuzzleFromParam(share.param);
        openEditor(res.ok ? res.puzzle : undefined);
      } catch {
        openEditor();
      }
      return;
    }
    const playPage = new PlayPage(engine, "shared", () => { location.hash = "#/"; }, {
      recordClear: false,
    });
    page = playPage;
    root.replaceChildren(playPage.el);
    try {
      const res = await decodePuzzleFromParam(share.param);
      await playPage.load(res.ok ? res.puzzle : { error: res.errors.join(" / ") });
    } catch (e) {
      await playPage.load({ error: String(e) });
    }
    return;
  }

  const playMatch = /^#\/play\/([\w-]+)$/.exec(location.hash);
  if (playMatch) {
    const id = playMatch[1];
    const playPage = new PlayPage(engine, id, () => { location.hash = "#/"; });
    page = playPage;
    root.replaceChildren(playPage.el);
    try {
      await playPage.load(await loadPuzzle(id));
    } catch (e) {
      await playPage.load({ error: String(e) });
    }
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
