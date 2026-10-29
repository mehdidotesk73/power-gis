// Tables that ship with the app. They come from the **default folder** this
// build points at (`defaults/active.json` → `defaults/<folder>/`): its
// `folder.json` lists the tables, its CSVs hold their rows and its
// `workspace.powergis.json` is the default map. Other folders' tables are not
// built-ins in this build (tests can still read them, by folder).
//
// Uploading one stores a copy in the database as an ordinary dataset, marked
// `extensions.builtin = table` and `extensions.version` so the default
// workspace can reuse an existing copy instead of uploading again — only while
// its shape is current.
import active from '../../defaults/active.json'

export interface BuiltinTable {
  table: string
  label: string
  description: string
  /** Where the server reads it: a CSV in the default folder, polygons from us-atlas, or generated. */
  source: 'csv' | 'boundary' | 'generated'
  /** Bump when the table's columns or contents change: older stored copies stop being reused. */
  version: number
}

/** A default folder: what it is, and the tables it makes built-in. */
export interface DefaultFolder {
  /** The folder's directory name under `defaults/`. */
  id: string
  name: string
  description: string
  tables: BuiltinTable[]
}

const SOURCES = ['csv', 'boundary', 'generated']
const specs = import.meta.glob<Omit<DefaultFolder, 'id'>>('../../defaults/*/folder.json', { eager: true, import: 'default' })

/** Every default folder in the repo, by id. */
export const DEFAULT_FOLDERS: Record<string, DefaultFolder> = Object.fromEntries(
  Object.entries(specs).map(([path, spec]) => {
    const id = /defaults\/([^/]+)\/folder\.json$/.exec(path)![1]
    for (const t of spec.tables) {
      if (!SOURCES.includes(t.source)) throw new Error(`defaults/${id}/folder.json: "${t.table}" has source "${t.source}"`)
    }
    return [id, { id, ...spec }]
  }),
)

/** The folder this build ships. */
export const ACTIVE_FOLDER: DefaultFolder =
  DEFAULT_FOLDERS[active.folder] ??
  (() => {
    throw new Error(`defaults/active.json points at "${active.folder}", which has no defaults/${active.folder}/folder.json`)
  })()

export const BUILTIN_TABLES: BuiltinTable[] = ACTIVE_FOLDER.tables

export const builtinTable = (table: string, tables: BuiltinTable[] = BUILTIN_TABLES) => tables.find((t) => t.table === table)
