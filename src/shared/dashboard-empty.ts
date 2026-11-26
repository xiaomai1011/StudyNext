import type { ChaoxingSessionStatus, SyncStatus } from './types'

export type DashboardEmptyKind = 'todo' | 'review' | 'upcoming' | 'notices'

export type DashboardDataCondition =
  | 'success'
  | 'failure'
  | 'partial'
  | 'syncing'
  | 'expired'
  | 'not_connected'
  | 'import'
  | 'not_synced'
  | 'unknown'

export interface DashboardEmptyContext {
  syncStatus: Pick<SyncStatus, 'state' | 'source' | 'lastSuccessAt'>
  chaoxing: Pick<ChaoxingSessionStatus, 'authState' | 'lastSyncAt'>
  autoSyncError?: string | null
}

export interface DashboardEmptyCopy {
  condition: DashboardDataCondition
  title: string
  description: string
  summary: string
}

function resolveCondition(context: DashboardEmptyContext): DashboardDataCondition {
  if (context.syncStatus.state === 'syncing') return 'syncing'
  if (context.syncStatus.state === 'failure' || context.autoSyncError) return 'failure'
  if (context.syncStatus.state === 'partial') return 'partial'
  if (context.chaoxing.authState === 'expired') return 'expired'
  if (context.chaoxing.authState === 'logged_out') return 'not_connected'
  if (context.syncStatus.source === 'import') return 'import'
  if (context.syncStatus.state === 'success') return 'success'
  if (context.chaoxing.authState === 'authenticated' && !context.chaoxing.lastSyncAt) {
    return 'not_synced'
  }
  return 'unknown'
}

const SUMMARY: Record<DashboardDataCondition, string> = {
  // 共享 SyncStatus 没有结构化的同步范围。单课程重试成功也会写 success，
  // 因此这里只能描述本地已加载的数据，不能推断平台全量数据为空。
  success: '本地已加载数据中暂无记录',
  failure: '最近同步失败，数据可能不是最新',
  partial: '部分平台数据可能未更新',
  syncing: '正在同步平台数据',
  expired: '学习通登录已过期',
  not_connected: '尚未连接学习通',
  import: '当前使用本地快照',
  not_synced: '尚未完成平台同步',
  unknown: '平台同步状态未知'
}

function staleDescription(context: DashboardEmptyContext): string {
  return context.syncStatus.lastSuccessAt || context.chaoxing.lastSyncAt
    ? '仍保留上次成功同步的数据，但可能不是最新。'
    : '当前没有可确认的平台同步结果。'
}

function todoCopy(
  condition: DashboardDataCondition,
  context: DashboardEmptyContext
): DashboardEmptyCopy {
  switch (condition) {
    case 'failure':
      return {
        condition,
        title: '当前本地暂无待办',
        description: `平台任务可能尚未更新。${staleDescription(context)}`,
        summary: SUMMARY[condition]
      }
    case 'partial':
      return {
        condition,
        title: '当前本地暂无待办',
        description: '部分平台数据未更新，请以学习通为准。',
        summary: SUMMARY[condition]
      }
    case 'syncing':
      return {
        condition,
        title: '正在同步待办',
        description: '同步完成后，新任务会自动出现在这里。',
        summary: SUMMARY[condition]
      }
    case 'expired':
      return {
        condition,
        title: '当前本地暂无待办',
        description: '学习通登录已过期；本地任务仍会显示，重新连接后可同步平台任务。',
        summary: SUMMARY[condition]
      }
    case 'not_connected':
      return {
        condition,
        title: '当前本地暂无待办',
        description: '本地手动任务会显示在这里；连接学习通后可同步平台任务。',
        summary: '本地任务可用'
      }
    case 'import':
      return {
        condition,
        title: '当前本地暂无待办',
        description: '当前显示本地快照中的记录；连接学习通后可同步平台任务。',
        summary: SUMMARY[condition]
      }
    case 'not_synced':
      return {
        condition,
        title: '当前本地暂无待办',
        description: '学习通已连接，但平台任务尚未完成一次同步。',
        summary: SUMMARY[condition]
      }
    case 'success':
      return {
        condition,
        title: '当前本地暂无待办',
        description: '本地已加载的任务中暂无待办；平台任务可能尚未全部同步。',
        summary: '本地已加载的待办为空'
      }
    default:
      return {
        condition,
        title: '当前本地暂无待办',
        description: '平台数据尚未同步，无法确认是否有新任务。',
        summary: SUMMARY[condition]
      }
  }
}

function reviewCopy(
  condition: DashboardDataCondition,
  context: DashboardEmptyContext
): DashboardEmptyCopy {
  switch (condition) {
    case 'failure':
      return {
        condition,
        title: '平台提交状态暂不可用',
        description: `无法确认是否有待审核或已提交作业。${staleDescription(context)}`,
        summary: '提交状态可能不是最新'
      }
    case 'partial':
      return {
        condition,
        title: '提交状态可能不是最新',
        description: '部分平台数据未更新，请以学习通为准。',
        summary: SUMMARY[condition]
      }
    case 'syncing':
      return {
        condition,
        title: '正在同步提交状态',
        description: '同步完成后，待审核与已提交作业会显示在这里。',
        summary: SUMMARY[condition]
      }
    case 'expired':
      return {
        condition,
        title: '学习通登录已过期',
        description: '重新连接后，待审核与已提交作业会继续更新。',
        summary: SUMMARY[condition]
      }
    case 'not_connected':
      return {
        condition,
        title: '连接学习通后显示',
        description: '平台提交状态仅在连接学习通并完成同步后显示。',
        summary: SUMMARY[condition]
      }
    case 'import':
      return {
        condition,
        title: '本地快照不含提交状态',
        description: '连接学习通并完成同步后，待审核与已提交作业会显示在这里。',
        summary: SUMMARY[condition]
      }
    case 'not_synced':
      return {
        condition,
        title: '提交状态尚未同步',
        description: '学习通已连接，但还没有完成过一次作业状态同步。',
        summary: SUMMARY[condition]
      }
    case 'success':
      return {
        condition,
        title: '当前本地暂无待审核或已提交记录',
        description: '本地已加载的作业中暂无相关记录；平台提交状态可能尚未全部同步。',
        summary: '本地暂无待审核或已提交记录'
      }
    default:
      return {
        condition,
        title: '当前本地暂无提交记录',
        description: '平台状态尚未同步，无法确认是否有待处理提交。',
        summary: SUMMARY[condition]
      }
  }
}

function upcomingCopy(
  condition: DashboardDataCondition,
  context: DashboardEmptyContext
): DashboardEmptyCopy {
  switch (condition) {
    case 'failure':
      return {
        condition,
        title: '截止信息可能不是最新',
        description: `当前仅显示本地已有记录。${staleDescription(context)}`,
        summary: '截止信息可能不是最新'
      }
    case 'partial':
      return {
        condition,
        title: '截止信息可能未完整更新',
        description: '部分平台数据未更新，请以学习通为准。',
        summary: SUMMARY[condition]
      }
    case 'syncing':
      return {
        condition,
        title: '正在更新截止信息',
        description: '同步完成后，新的截止任务会显示在这里。',
        summary: SUMMARY[condition]
      }
    case 'expired':
      return {
        condition,
        title: '学习通登录已过期',
        description: '本地任务仍会显示；重新连接后平台截止信息会继续更新。',
        summary: SUMMARY[condition]
      }
    case 'not_connected':
      return {
        condition,
        title: '当前本地暂无截止任务',
        description: '本地任务仍会显示；连接学习通后可同步平台作业。',
        summary: '本地任务可用'
      }
    case 'import':
      return {
        condition,
        title: '本地快照暂无近期截止任务',
        description: '当前显示导入快照中的本地记录。',
        summary: SUMMARY[condition]
      }
    case 'not_synced':
      return {
        condition,
        title: '截止信息尚未同步',
        description: '学习通已连接，但还没有完成过一次作业同步。',
        summary: SUMMARY[condition]
      }
    case 'success':
      return {
        condition,
        title: '当前本地暂无符合条件的近期截止任务',
        description:
          '仅表示本地已加载的数据中，未来七天内没有符合条件的任务；平台数据可能尚未全部更新。',
        summary: '本地暂无符合条件的近期截止任务'
      }
    default:
      return {
        condition,
        title: '当前本地暂无近期截止任务',
        description: '平台数据尚未同步，无法确认是否有新的截止任务。',
        summary: SUMMARY[condition]
      }
  }
}

function noticesCopy(
  condition: DashboardDataCondition,
  context: DashboardEmptyContext
): DashboardEmptyCopy {
  switch (condition) {
    case 'failure':
      return {
        condition,
        title: '通知状态暂不可用',
        description: `无法确认平台是否有新通知。${staleDescription(context)}`,
        summary: '通知可能不是最新'
      }
    case 'partial':
      return {
        condition,
        title: '通知可能未完整更新',
        description: '部分平台数据未更新，当前列表可能缺少新通知。',
        summary: SUMMARY[condition]
      }
    case 'syncing':
      return {
        condition,
        title: '正在同步通知',
        description: '同步完成后，新通知会显示在这里。',
        summary: SUMMARY[condition]
      }
    case 'expired':
      return {
        condition,
        title: '学习通登录已过期',
        description: '重新连接学习通后，通知会继续更新。',
        summary: SUMMARY[condition]
      }
    case 'not_connected':
      return {
        condition,
        title: '连接学习通后显示通知',
        description: '通知仅来自学习通 Web Session，不读取本地任务。',
        summary: SUMMARY[condition]
      }
    case 'import':
      return {
        condition,
        title: '本地快照不含通知',
        description: '连接学习通并完成同步后，通知会显示在这里。',
        summary: SUMMARY[condition]
      }
    case 'not_synced':
      return {
        condition,
        title: '通知尚未同步',
        description: '学习通已连接，但还没有完成过一次通知同步。',
        summary: SUMMARY[condition]
      }
    case 'success':
      return {
        condition,
        title: '当前本地暂无通知记录',
        description: '平台通知可能尚未更新；这里只展示本地已加载的通知。',
        summary: '当前本地暂无通知记录，平台通知可能尚未更新'
      }
    default:
      return {
        condition,
        title: '当前本地暂无通知',
        description: '平台通知尚未同步，无法确认是否有新通知。',
        summary: SUMMARY[condition]
      }
  }
}

export function getDashboardEmptyCopy(
  kind: DashboardEmptyKind,
  context: DashboardEmptyContext
): DashboardEmptyCopy {
  const condition = resolveCondition(context)
  switch (kind) {
    case 'todo':
      return todoCopy(condition, context)
    case 'review':
      return reviewCopy(condition, context)
    case 'upcoming':
      return upcomingCopy(condition, context)
    case 'notices':
      return noticesCopy(condition, context)
  }
}
