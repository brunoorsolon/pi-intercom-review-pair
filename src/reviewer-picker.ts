import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { candidateDescription, candidateLabel, visibleCandidateRows, type LiveSession } from "./core.ts";

class ReviewerPicker extends Container {
  private readonly list: SelectList;
  private readonly rows: () => number;
  private readonly keybindings: KeybindingsManager;
  private readonly candidates: LiveSession[];
  private readonly done: (session: LiveSession | undefined) => void;
  private finished = false;

  constructor(tui: TUI, keybindings: KeybindingsManager, theme: Theme, candidates: LiveSession[], done: (session: LiveSession | undefined) => void) {
    super();
    this.keybindings = keybindings;
    this.candidates = candidates;
    this.done = done;
    this.rows = () => visibleCandidateRows(tui.terminal.rows, candidates.length);
    this.list = new SelectList(
      candidates.map((session) => ({ value: session.id, label: candidateLabel(session), description: candidateDescription(session) })),
      this.rows(),
      getSelectListTheme(),
      { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 32 },
    );
    this.list.onSelect = (item) => this.finish(candidates.find((session) => session.id === item.value));
    this.list.onCancel = () => this.finish(undefined);

    this.addChild(new Text(theme.fg("accent", theme.bold("Select reviewer")), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "↑↓ move · pgup/pgdn page · enter pair · esc cancel"), 1, 0));
  }

  private finish(session: LiveSession | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.done(session);
  }

  render(width: number): string[] {
    this.list.maxVisible = this.rows();
    return super.render(width);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    const pageUp = this.keybindings.matches(data, "tui.select.pageUp");
    if (pageUp || this.keybindings.matches(data, "tui.select.pageDown")) {
      const direction = pageUp ? -1 : 1;
      const current = this.list.filteredItems.indexOf(this.list.getSelectedItem()!);
      const next = (current + direction * this.list.maxVisible + this.candidates.length) % this.candidates.length;
      this.list.setSelectedIndex(next);
      return;
    }
    this.list.handleInput(data);
  }
}

export function createReviewerPicker(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  candidates: LiveSession[],
  done: (session: LiveSession | undefined) => void,
): Container {
  return new ReviewerPicker(tui, keybindings, theme, candidates, done);
}