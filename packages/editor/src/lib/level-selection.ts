import type { AnyNodeId, BuildingNode, LevelNode } from '@pascal-app/core'
import { useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { deleteLevelWithTypicalDetach } from './level-batch-actions'

function getAdjacentLevelIdForDeletion(levelId: AnyNodeId): LevelNode['id'] | null {
  const { nodes } = useScene.getState()
  const level = nodes[levelId]
  if (level?.type !== 'level' || !level.parentId) return null

  const building = nodes[level.parentId as AnyNodeId]
  if (building?.type !== 'building') return null

  const siblingLevelIds = (building as BuildingNode).children.filter(
    (childId): childId is LevelNode['id'] => nodes[childId as AnyNodeId]?.type === 'level',
  )
  const currentIndex = siblingLevelIds.indexOf(level.id)
  if (currentIndex === -1) return null

  return siblingLevelIds[currentIndex - 1] ?? siblingLevelIds[currentIndex + 1] ?? null
}

/**
 * Deletes a level and moves the viewer's selection to a surviving neighbour.
 *
 * Deleting a typical-floor master also detaches its instances — they become
 * ordinary levels instead of pointing at a master that no longer exists. Both
 * the detach and the deletion share one undo step, so a single undo brings
 * the master back *with* its instances still linked.
 */
export function deleteLevelWithFallbackSelection(levelId: AnyNodeId) {
  const isSelectedLevel = useViewer.getState().selection.levelId === levelId
  const nextLevelId = getAdjacentLevelIdForDeletion(levelId)

  deleteLevelWithTypicalDetach(levelId)

  if (isSelectedLevel) {
    useViewer.getState().setSelection({ levelId: nextLevelId })
  }
}
