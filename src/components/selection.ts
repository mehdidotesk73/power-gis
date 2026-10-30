// Picking several workspace items to act on together (delete), shared by the
// graph and the lists: the page provides it, list cards and graph nodes use it.
// Keys are the graph's (`ds:<id>`, `tr:<id>`, `viz:<id>`), so a pick made in one
// view shows in the other.
import { inject, provide, type InjectionKey, type Ref } from 'vue'

export interface Selection {
  /** Phones: taps pick instead of opening (Select in the tools menu). */
  selecting: Ref<boolean>
  marked: Ref<string[]>
  toggle(key: string): void
}

const KEY: InjectionKey<Selection> = Symbol('selection')

export const provideSelection = (s: Selection) => provide(KEY, s)
export const useSelection = () => inject(KEY, null)

/** A click that picks rather than opens: Select mode, or Ctrl/⌘- or Shift-click. */
export const picks = (s: Selection | null, e: MouseEvent) => !!s && (s.selecting.value || e.ctrlKey || e.metaKey || e.shiftKey)
