// Tables that ship with the app, in two kinds:
//
// - **Built-ins** (`builtins/builtins.json`): the geographic tables every map
//   can use — US states and counties, polygons the server makes from the
//   us-atlas package. Offered under ＋ Dataset → Built-in, and to the assistant
//   (add_builtin).
// - **Samples** (`defaults/<folder>/folder.json`): example data tables, CSVs in
//   the default folder this build points at (`defaults/active.json`), which its
//   default map uses. Offered under ＋ Dataset → Samples; the assistant sees a
//   sample only once the user has added it. Other folders' samples aren't in
//   this build.
//
// Uploading either stores a copy in the database as an ordinary dataset, marked
// `extensions.builtin = table` and `extensions.version` so the default
// workspace can reuse an existing copy instead of uploading again — only while
// its shape is current. Documents call both origin `builtin`.
import active from '../../defaults/active.json'
import builtins from '../../builtins/builtins.json'

export interface BuiltinTable {
  table: string
  label: string
  description: string
  /** Where the server reads it: a sample's CSV in the default folder, or polygons from us-atlas. */
  source: 'csv' | 'boundary'
  /** Bump when the table's columns or contents change: older stored copies stop being reused. */
  version: number
}

type TableSpec = Omit<BuiltinTable, 'source'>

/** A default folder: what it is, and its sample tables. */
export interface DefaultFolder {
  /** The folder's directory name under `defaults/`. */
  id: string
  name: string
  description: string
  samples: BuiltinTable[]
}

/** The geographic built-ins, in every build. */
export const BUILTIN_TABLES: BuiltinTable[] = (builtins.tables as TableSpec[]).map((t) => ({ ...t, source: 'boundary' }))

const specs = import.meta.glob<{ name: string; description: string; samples: TableSpec[] }>('../../defaults/*/folder.json', { eager: true, import: 'default' })

/** Every default folder in the repo, by id. */
export const DEFAULT_FOLDERS: Record<string, DefaultFolder> = Object.fromEntries(
  Object.entries(specs).map(([path, spec]) => {
    const id = /defaults\/([^/]+)\/folder\.json$/.exec(path)![1]
    for (const t of spec.samples) {
      if (BUILTIN_TABLES.some((b) => b.table === t.table)) throw new Error(`defaults/${id}/folder.json: "${t.table}" is a built-in, not a sample`)
    }
    return [id, { id, name: spec.name, description: spec.description, samples: spec.samples.map((t) => ({ ...t, source: 'csv' as const })) }]
  }),
)

/** The folder this build ships. */
export const ACTIVE_FOLDER: DefaultFolder =
  DEFAULT_FOLDERS[active.folder] ??
  (() => {
    throw new Error(`defaults/active.json points at "${active.folder}", which has no defaults/${active.folder}/folder.json`)
  })()

/** The active folder's samples. */
export const SAMPLE_TABLES: BuiltinTable[] = ACTIVE_FOLDER.samples

/** Every table this build can make by name: the built-ins and the samples (the server and documents use both). */
export const KNOWN_TABLES: BuiltinTable[] = [...BUILTIN_TABLES, ...SAMPLE_TABLES]

export const builtinTable = (table: string, tables: BuiltinTable[] = KNOWN_TABLES) => tables.find((t) => t.table === table)
