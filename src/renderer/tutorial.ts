// Tutorial / first-run coachmarks. No imports/exports — same reason as renderer.ts (loads as a plain
// <script>, no module loader). Loaded before renderer.js; talks to the rest of the app only through
// the window.CascadeTutorial surface at the bottom, which renderer.ts calls into.

// Plain top-level interface merging works here because this file has no import/export, so TypeScript
// treats it as a script in the global scope rather than a module — no `declare global` wrapper needed.
interface Window {
  CascadeTutorial: {
    maybeStart(seenStepIds: string[], onComplete: (seenIds: string[]) => void): void;
    replay(onComplete: (seenIds: string[]) => void): void;
  };
}

interface TutorialStep {
  /** Stable, never reused. This id is what gets persisted (Settings.tutorialSeenStepIds), so renaming
   *  or reordering ids here effectively re-shows that step to everyone. */
  id: string;
  title: string;
  body: string;
  /** CSS selector of the real element to spotlight, or null to just center the card with no spotlight. */
  target: string | null;
}

// Add new steps here as Cascade grows features — that's the whole mechanism for "upgradeable":
// append a step with a fresh id, anywhere in the array. A returning install that already has every
// earlier id in Settings.tutorialSeenStepIds will be shown *only* the new one(s), framed as "What's
// new" instead of the full tour; a brand new install sees everything in order, framed as a first look.
// Keep every target to something that exists right after a fresh launch with an empty list — an
// element inside a download row won't exist yet for a first-time user, so don't target one here
// without also giving reposition() below a reason to re-check (it already re-measures on every
// window resize, but not on a timer, so a target that can appear/disappear mid-tour isn't safe yet).
const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to Cascade",
    body: "A download manager that splits files across multiple connections for speed, and survives pauses, crashes, and restarts without losing progress. A quick four-step look around — skip any time.",
    target: null,
  },
  {
    id: "add-download",
    title: "Add a download",
    body: "Paste a link here to start one. Cascade splits it across up to 32 connections on its own — nothing to configure.",
    target: "#addBtn",
  },
  {
    id: "pause-resume-all",
    title: "Control everything at once",
    body: "Pause or resume every active download in one click — handy before closing the lid or stepping onto a slow connection.",
    target: "#resumeAllBtn",
  },
  {
    id: "settings",
    title: "Make it yours",
    body: "Themes, connection limits, your download folder, the browser extension, and this tour again whenever you want — it all lives here.",
    target: "#settingsBtn",
  },
];

(function () {
  let overlay: HTMLDivElement | null = null;
  let spotlight: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let activeBatch: TutorialStep[] = [];
  let activeIndex = 0;
  let onDone: ((seenIds: string[]) => void) | null = null;

  function reposition(): void {
    if (!overlay || !spotlight || !card) return;
    const step = activeBatch[activeIndex];
    const targetEl = step.target ? document.querySelector<HTMLElement>(step.target) : null;

    if (!targetEl) {
      // No real element to point at (either by design, e.g. the welcome step, or because the
      // selector didn't match anything right now) — shrink the spotlight to a point at the center
      // and drop its ring, rather than hiding it outright: its box-shadow is what dims the rest of
      // the screen, for every step, so something still needs to be there to cast it.
      spotlight.classList.add("no-target");
      spotlight.style.top = "50%";
      spotlight.style.left = "50%";
      spotlight.style.width = "0px";
      spotlight.style.height = "0px";
      card.style.top = "50%";
      card.style.left = "50%";
      card.style.transform = "translate(-50%, -50%)";
      return;
    }

    spotlight.classList.remove("no-target");
    const r = targetEl.getBoundingClientRect();
    const pad = 8;
    spotlight.style.top = `${r.top - pad}px`;
    spotlight.style.left = `${r.left - pad}px`;
    spotlight.style.width = `${r.width + pad * 2}px`;
    spotlight.style.height = `${r.height + pad * 2}px`;

    // Prefer below the target; flip above if there's not enough room; clamp sideways so the card
    // never runs off a narrow window.
    const cardRect = card.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const top = spaceBelow > cardRect.height + 32 ? r.bottom + 14 : Math.max(14, r.top - cardRect.height - 14);
    const left = Math.min(Math.max(14, r.left), window.innerWidth - cardRect.width - 14);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    card.style.transform = "none";
  }

  function render(): void {
    if (!card) return;
    const step = activeBatch[activeIndex];
    const isLast = activeIndex === activeBatch.length - 1;
    card.innerHTML = `
      <p class="tutorial-title">${escapeHtml(step.title)}</p>
      <p class="tutorial-body">${escapeHtml(step.body)}</p>
      <div class="tutorial-dots">${activeBatch.map((_, i) => `<span class="tutorial-dot${i === activeIndex ? " on" : ""}"></span>`).join("")}</div>
      <div class="tutorial-actions">
        <button type="button" class="btn btn-ghost tutorial-skip">Skip</button>
        <div class="tutorial-actions-right">
          ${activeIndex > 0 ? `<button type="button" class="btn btn-ghost tutorial-back">Back</button>` : ""}
          <button type="button" class="btn btn-primary tutorial-next">${isLast ? "Done" : "Next"}</button>
        </div>
      </div>`;
    card.querySelector(".tutorial-skip")!.addEventListener("click", finish);
    card.querySelector(".tutorial-next")!.addEventListener("click", () => {
      if (isLast) finish();
      else {
        activeIndex++;
        render();
        reposition();
      }
    });
    card.querySelector(".tutorial-back")?.addEventListener("click", () => {
      activeIndex = Math.max(0, activeIndex - 1);
      render();
      reposition();
    });
    reposition();
  }

  function escapeHtml(s: string): string {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function finish(): void {
    const seenIds = activeBatch.map((s) => s.id);
    window.removeEventListener("resize", reposition);
    overlay?.remove();
    overlay = spotlight = card = null;
    const cb = onDone;
    onDone = null;
    cb?.(seenIds);
  }

  function start(steps: TutorialStep[], done: (seenIds: string[]) => void): void {
    if (steps.length === 0) return;
    activeBatch = steps;
    activeIndex = 0;
    onDone = done;

    overlay = document.createElement("div");
    overlay.className = "tutorial-overlay";
    spotlight = document.createElement("div");
    spotlight.className = "tutorial-spotlight";
    card = document.createElement("div");
    card.className = "tutorial-card";
    overlay.append(spotlight, card);
    document.body.append(overlay);

    window.addEventListener("resize", reposition);
    render();
  }

  window.CascadeTutorial = {
    maybeStart(seenStepIds: string[], onComplete: (seenIds: string[]) => void): void {
      const unseen = TUTORIAL_STEPS.filter((s) => !seenStepIds.includes(s.id));
      if (unseen.length === 0) return;
      // A brand new install has seen none of them; a returning install that's missing only some has
      // them because new steps were added since — either way, "whatever's unseen" is the right batch,
      // just a different framing in the welcome copy would be nice (left as plain Next/Skip for now).
      start(unseen, onComplete);
    },
    replay(onComplete: (seenIds: string[]) => void): void {
      start(TUTORIAL_STEPS, onComplete);
    },
  };
})();
