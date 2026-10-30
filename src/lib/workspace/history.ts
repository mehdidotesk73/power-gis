// Undo / redo for the workspace draft. Every edit already makes a new copy of
// the workspace (the ops in workspace.ts), so the history is just the copies
// before each edit. Edits that come in quick succession (typing a name, an
// agent's apply-then-run) count as one step. Loading another workspace starts
// a new history; saving doesn't (undo after Save makes it unsaved again).
// Only the draft: data written to the database (a transform's run, a deleted
// dataset) isn't undone.

export class History<T> {
  private past: T[] = []
  private future: T[] = []
  private last = -Infinity

  constructor(
    private readonly limit = 100,
    /** Edits closer together than this (ms) are one step. */
    private readonly merge = 600,
  ) {}

  /** An edit is about to replace `prev`. */
  record(prev: T, at = Date.now()) {
    if (at - this.last > this.merge || !this.past.length) {
      this.past.push(prev)
      if (this.past.length > this.limit) this.past.shift()
    }
    this.last = at
    this.future = []
  }

  /** The copy to go back to (`current` becomes redoable), if any. */
  undo(current: T): T | undefined {
    const prev = this.past.pop()
    if (prev === undefined) return undefined
    this.future.push(current)
    this.last = -Infinity
    return prev
  }

  /** The copy to go forward to again (`current` becomes undoable), if any. */
  redo(current: T): T | undefined {
    const next = this.future.pop()
    if (next === undefined) return undefined
    this.past.push(current)
    this.last = -Infinity
    return next
  }

  clear() {
    this.past = []
    this.future = []
    this.last = -Infinity
  }

  get canUndo() {
    return this.past.length > 0
  }
  get canRedo() {
    return this.future.length > 0
  }
}
