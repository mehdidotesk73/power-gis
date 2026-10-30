import { describe, expect, it } from 'vitest'
import { History } from './history'

describe('workspace history', () => {
  it('undoes and redoes, step by step; a new edit drops what could be redone', () => {
    const h = new History<string>(100, 0)
    let doc = 'a'
    const edit = (next: string, at: number) => (h.record(doc, at), (doc = next))
    edit('b', 1)
    edit('c', 2)
    expect(h.canRedo).toBe(false)
    doc = h.undo(doc)!
    expect(doc).toBe('b')
    doc = h.undo(doc)!
    expect(doc).toBe('a')
    expect(h.undo(doc)).toBeUndefined()
    doc = h.redo(doc)!
    expect(doc).toBe('b')
    edit('x', 10)
    expect(h.canRedo).toBe(false)
    doc = h.undo(doc)!
    expect(doc).toBe('b')
  })

  it('counts quick successive edits as one step, and keeps at most the limit', () => {
    const h = new History<string>(2, 600)
    let doc = 'a'
    const edit = (next: string, at: number) => (h.record(doc, at), (doc = next))
    edit('ab', 1000)
    edit('abc', 1200) // typing: one step
    expect(h.undo(doc)).toBe('a')
    h.clear()
    doc = 'a'
    edit('b', 0)
    edit('c', 1000)
    edit('d', 2000)
    expect([h.undo(doc), h.undo('c'), h.undo('b')]).toEqual(['c', 'b', undefined]) // 'a' fell off
  })
})
