import { describe, expect, it } from 'vitest'
import { applyWorkspaceEdits, renderWorkspace } from './workspaceText'
import { emptyWorkspace, type WorkspaceDoc } from '../workspace/workspace'

const doc: WorkspaceDoc = {
  ...emptyWorkspace('Costs ${2026}'),
  datasetIds: ['a'],
  transforms: [{ id: 't1', name: 'T', inputs: [{ datasetId: 'a', alias: 'a' }], outputs: [{ key: 'o1', name: 'Out', sql: 'SELECT "x", \'${y}\' FROM a' }] }],
}

describe('the workspace as the agent edits it', () => {
  it('puts SQL in blocks, and only tokens read as tokens', () => {
    const w = renderWorkspace(doc)
    expect(w.template).toContain('"sql": ${sql:t1.o1}')
    expect(w.template).toContain('"name": "Costs $\\u007b2026}"')
    expect(w.sql.get('t1.o1')).toBe(doc.transforms[0].outputs[0].sql)
    const r = applyWorkspaceEdits(w, [])
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.value).toMatchObject({ name: 'Costs ${2026}', transforms: [{ outputs: [{ sql: doc.transforms[0].outputs[0].sql }] }] })
  })

  it('inserts values as JSON literals, once, and edits inside a SQL block by name', () => {
    const w = renderWorkspace(doc)
    const r = applyWorkspaceEdits(
      w,
      [
        { sql: 'sql:t1.o1', old: '"x"', new: '"z"' },
        { old: '"name": "Out"', new: '"name": ${n}' },
      ],
      { n: 'Out ${sql:t1.o1} "quoted"' },
    )
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.value).toMatchObject({ transforms: [{ outputs: [{ name: 'Out ${sql:t1.o1} "quoted"', sql: 'SELECT "z", \'${y}\' FROM a' }] }] })
    expect(applyWorkspaceEdits(w, [{ sql: 'nope', old: 'a', new: 'b' }])).toMatchObject({ ok: false, errors: [expect.stringContaining('no SQL block "nope"')] })
  })
})
