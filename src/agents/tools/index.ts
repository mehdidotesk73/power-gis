// The assistant's tools (src/agents/assistant/agent.ts lists them), one file per tool or small bundle:
// each file holds its tools' specs (what the model sees) next to their handlers (what runs).

import type { ToolOutcome } from '../../lib/agent/loop'
import type { ToolSpec } from '../../lib/agent/provider'
import { EDITOR_TOOL } from '../../lib/agent/workspaceFiles'
import { askUser, pickSource, proposeFrame, proposePlan } from './cards'
import { Invalid, err, isObj, need } from './common'
import { addBuiltin, deleteDataset, listDatasets } from './datasets'
import { diagnose } from './diagnose'
import { AgentHost } from './host'
import { querySql, visualizationStats } from './query'
import { recipe } from './recipe'
import { tellStory } from './story'
import { fetchRun, listRuns, readRun, sendWeb } from './web'
import { applyWorkspace, editor, getWorkspace, runTransform } from './workspace'
import { CARDS_TOOLS } from './cards'
import { DATASETS_TOOLS } from './datasets'
import { DIAGNOSE_TOOLS } from './diagnose'
import { QUERY_TOOLS } from './query'
import { RECIPE_TOOLS } from './recipe'
import { STORY_TOOLS } from './story'
import { WEB_TOOLS } from './web'
import { WORKSPACE_TOOLS } from './workspace'

export async function runTool(host: AgentHost, name: string, input: unknown): Promise<ToolOutcome> {
  try {
    need(isObj(input), 'The tool input must be a JSON object')
    switch (name) {
      case 'list_datasets':
        return await listDatasets(host)
      case 'get_workspace':
        return await getWorkspace(host)
      case 'propose_plan':
        return await proposePlan(host, input)
      case 'pick_source':
        return await pickSource(host, input)
      case 'propose_frame':
        return await proposeFrame(host, input)
      case 'ask_user':
        return await askUser(host, input)
      case 'add_builtin':
        return await addBuiltin(host, input)
      case 'send_scout':
        return await sendWeb(host, 'scout', input)
      case 'send_scraper':
        return await sendWeb(host, 'scraper', input)
      case 'query_sql':
        return await querySql(host, input)
      case EDITOR_TOOL:
        return await editor(host, input)
      case 'apply_workspace':
        return await applyWorkspace(host, input)
      case 'visualization_stats':
        return await visualizationStats(host, input)
      case 'run_transform':
        return await runTransform(host, input)
      case 'delete_dataset':
        return await deleteDataset(host, input)
      case 'list_runs':
        return listRuns(host)
      case 'fetch_run':
        return await fetchRun(host, input)
      case 'recipe':
        return recipe(input)
      case 'read_run':
        return await readRun(host, input)
      case 'diagnose':
        return await diagnose(host, input)
      case 'tell_story':
        return await tellStory(host, input)
      default:
        return err(`Unknown tool "${name}"`)
    }
  } catch (e) {
    return e instanceof Invalid ? err(e.message, 'invalid input') : err(`The tool failed: ${(e as Error).message ?? String(e)}`, 'failed')
  }
}

const BY_NAME = new Map([...CARDS_TOOLS, ...DATASETS_TOOLS, ...DIAGNOSE_TOOLS, ...QUERY_TOOLS, ...RECIPE_TOOLS, ...STORY_TOOLS, ...WEB_TOOLS, ...WORKSPACE_TOOLS].map((t) => [t.name, t]))
/** Every tool the assistant has, in the order it sees them. */
export const TOOLS: ToolSpec[] = ['get_workspace', 'list_datasets', 'ask_user', 'propose_plan', 'pick_source', 'propose_frame', 'add_builtin', 'send_scout', 'send_scraper', 'list_runs', 'fetch_run', 'recipe', 'read_run', 'diagnose', 'query_sql', 'str_replace_based_edit_tool', 'apply_workspace', 'visualization_stats', 'run_transform', 'delete_dataset', 'tell_story'].map((n) => BY_NAME.get(n)!)

export * from './host'
export { Invalid, workspaceVersion } from './common'
export { notDescribed, forgetChat, readVisualization } from './workspace'
export { valueStats } from './query'
export { IMPORTABLE, webFileDescription, readCap, briefWithNeeds } from './web'
