// Where an item's card and editor open. In the desktop setup mode the page
// has a column on the right (#setup-detail) and editors, the graph's open
// item and Explore teleport there; everywhere else (explore mode, phones)
// they open in place. Lists read it with useDetailTarget().
import { inject, provide, ref, type Ref } from 'vue'

const KEY = Symbol('detailTarget')
export const DETAIL_ID = 'setup-detail'

/** The selector editors teleport to, or null to open in place. */
export const provideDetailTarget = (target: Readonly<Ref<string | null>>) => provide(KEY, target)
export const useDetailTarget = (): Readonly<Ref<string | null>> => inject(KEY, ref(null))
