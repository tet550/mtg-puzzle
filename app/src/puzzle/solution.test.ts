import { describe, expect, it, beforeEach } from "vitest";
import type { Decision } from "../engine/protocol";
import {
  deleteRegisteredSolution,
  formatSolutionStep,
  loadRegisteredSolution,
  matchSolutionStep,
  recordDecisionStep,
  saveRegisteredSolution,
  SOLUTIONS_STORAGE_KEY,
  validateSolutionSteps,
  type SolutionStep,
} from "./solution";

function makeDecision(patch: Partial<Decision>): Decision {
  return {
    seq: 1,
    kind: "PRIORITY",
    prompt: "",
    min: 1,
    max: 1,
    options: [
      { id: "pass", label: "Pass", ref: null },
      { id: "sa_1", label: "Mountain [1] — {T}: Add {R}.", ref: null },
      { id: "sa_2", label: "Burst Lightning [2] — Burst Lightning deals 2 damage to any target.", ref: null },
    ],
    ...patch,
  };
}

describe("solution steps", () => {
  beforeEach(() => {
    try {
      localStorage.removeItem(SOLUTIONS_STORAGE_KEY);
    } catch { /* ignore */ }
  });

  it("records a decision into a SolutionStep with indexes and labels", () => {
    const d = makeDecision({});
    const step = recordDecisionStep(d, ["sa_2"]);
    expect(step).toEqual({
      kind: "PRIORITY",
      indexes: [2],
      labels: ["Burst Lightning [2] — Burst Lightning deals 2 damage to any target."],
    });
  });

  it("matches a SolutionStep by exact label first, then normalized label, then index", () => {
    const d = makeDecision({
      options: [
        { id: "pass", label: "Pass", ref: null },
        { id: "sa_10", label: "Burst Lightning [99] — Burst Lightning deals 2 damage to any target.", ref: null },
      ],
    });

    // Normalized label match (instance number [2] vs [99] differs)
    const stepByNormLabel: SolutionStep = {
      kind: "PRIORITY",
      indexes: [2],
      labels: ["Burst Lightning [2] — Burst Lightning deals 2 damage to any target."],
    };
    expect(matchSolutionStep(d, stepByNormLabel)).toEqual(["sa_10"]);

    // Index fallback when label is empty
    const stepByIndex: SolutionStep = {
      kind: "PRIORITY",
      indexes: [0],
      labels: [],
    };
    expect(matchSolutionStep(d, stepByIndex)).toEqual(["pass"]);

    // Kind mismatch returns null
    const wrongKind: SolutionStep = {
      kind: "TARGET",
      indexes: [0],
      labels: ["Pass"],
    };
    expect(matchSolutionStep(d, wrongKind)).toBeNull();
  });

  it("prefers the recorded index when several options share the same label", () => {
    const d = makeDecision({
      kind: "CHOOSE_ENTITY",
      options: [
        { id: "e_1", label: "Mox Amber (Battlefield, p1)", ref: null },
        { id: "e_2", label: "Mox Amber (Battlefield, p1)", ref: null },
      ],
    });
    const step: SolutionStep = { kind: "CHOOSE_ENTITY", indexes: [1], labels: ["Mox Amber (Battlefield, p1)"] };
    expect(matchSolutionStep(d, step)).toEqual(["e_2"]);
  });

  it("validates solution steps arrays and PuzzleSolution wrappers", () => {
    const steps: SolutionStep[] = [
      { kind: "PRIORITY", indexes: [1], labels: ["Mountain [1] — {T}: Add {R}."] },
      { kind: "TARGET", indexes: [1], labels: ["p2 (20 life)"] },
    ];
    expect(validateSolutionSteps(steps)).toEqual(steps);
    expect(validateSolutionSteps({ id: "t01-burn", steps })).toEqual(steps);
    expect(validateSolutionSteps([{ kind: "", indexes: [] }])).toBeNull();
    expect(validateSolutionSteps("invalid")).toBeNull();
  });

  it("formats solution steps in Japanese and English", () => {
    const tapStep: SolutionStep = {
      kind: "PRIORITY",
      indexes: [1],
      labels: ["Mountain [1] — {T}: Add {R}."],
    };
    expect(formatSolutionStep(tapStep, { lang: "ja" })).toBe("Mountain: {T}: Add {R}.");

    const passStep: SolutionStep = {
      kind: "PRIORITY",
      indexes: [0],
      labels: ["Pass"],
    };
    expect(formatSolutionStep(passStep, { lang: "ja" })).toBe("パス");
    expect(formatSolutionStep(passStep, { lang: "en" })).toBe("Pass");

    const targetStep: SolutionStep = {
      kind: "TARGET",
      indexes: [1],
      labels: ["p2 (2 life)"],
    };
    expect(formatSolutionStep(targetStep, { lang: "ja" })).toBe("対象: 相手");
    expect(formatSolutionStep(targetStep, { lang: "en" })).toBe("Target: Opponent");
  });

  it("saves, loads, and deletes registered solutions in localStorage", () => {
    const steps: SolutionStep[] = [
      { kind: "PRIORITY", indexes: [0], labels: ["Pass"] },
    ];
    expect(loadRegisteredSolution("test-puzzle")).toBeNull();
    saveRegisteredSolution("test-puzzle", steps);
    expect(loadRegisteredSolution("test-puzzle")).toEqual(steps);
    deleteRegisteredSolution("test-puzzle");
    expect(loadRegisteredSolution("test-puzzle")).toBeNull();
  });
});
