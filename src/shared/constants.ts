import type { AppSettings, QuestionSource, StudyPointKind, TaskKind, TaskPriority } from './types'

export const APP_NAME = 'StudyNext'
export const APP_ID = 'com.studynext.desktop'

export const REMINDER_PRESETS = [
  { minutes: 4320, label: '提前 3 天' },
  { minutes: 1440, label: '提前 1 天' },
  { minutes: 180, label: '提前 3 小时' },
  { minutes: 60, label: '提前 1 小时' }
] as const

export const REMINDER_MIN_MINUTES = 5
export const REMINDER_MAX_MINUTES = 60 * 24 * 30

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  closeToTray: true,
  launchAtLogin: false,
  notificationsEnabled: true,
  defaultReminderOffsets: [4320, 1440, 180, 60],
  calendarWeekStartsOn: 1,
  catchUpMissedReminders: true,
  trustedSsoDomains: []
}

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: '高优先级',
  medium: '普通',
  low: '低优先级'
}

export const STUDY_POINT_LABEL: Record<StudyPointKind, string> = {
  video: '视频',
  reading: '阅读',
  quiz: '测验',
  discussion: '讨论',
  assignment: '作业',
  other: '学习任务'
}

export const QUESTION_SOURCE_LABEL: Record<QuestionSource, string> = {
  manual: '手动整理',
  ai: 'AI 生成',
  import: '快照导入'
}

export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_AI_MODEL = 'gpt-4o-mini'

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  homework: '作业',
  exam: '考试',
  reading: '阅读',
  activity: '活动',
  other: '其他'
}

export const COURSE_COLORS = [
  '#5B6CFF',
  '#2BB8A3',
  '#F59E5B',
  '#EC6E9E',
  '#8B6CF6',
  '#45A3E5',
  '#E05D5D'
] as const

export const BUILTIN_ENTRIES = [
  {
    id: 'entry-home',
    label: '学习通首页',
    description: '进入个人空间与课程总览',
    url: 'https://i.chaoxing.com/',
    kind: 'home' as const,
    enabled: true,
    sortOrder: 10,
    isBuiltin: true
  },
  {
    id: 'entry-courses',
    label: '我的课程',
    description: '官方课程列表与班级空间',
    url: 'https://mooc1.chaoxing.com/visit/interaction',
    kind: 'course' as const,
    enabled: true,
    sortOrder: 20,
    isBuiltin: true
  },
  {
    id: 'entry-homework',
    label: '我的作业',
    description: '查看全部课程作业与提交状态',
    url: 'https://mooc1-api.chaoxing.com/mooc-ans/mooc2/work/all-task',
    kind: 'task' as const,
    enabled: true,
    sortOrder: 30,
    isBuiltin: true
  },
  {
    id: 'entry-exams',
    label: '考试列表',
    description: '查看考试安排与作答入口',
    url: 'https://mooc1-2.chaoxing.com/exam-ans/exam/test/examcode/examlist',
    kind: 'exam' as const,
    enabled: true,
    sortOrder: 40,
    isBuiltin: true
  },
  {
    id: 'entry-notices',
    label: '收件箱',
    description: '课程通知与系统消息',
    url: 'https://notice.chaoxing.com/pc/notice/myNotice',
    kind: 'notice' as const,
    enabled: true,
    sortOrder: 50,
    isBuiltin: true
  },
  {
    id: 'entry-calendar',
    label: '课表',
    description: '官方课表页面',
    url: 'https://kb.chaoxing.com/res/pc/curriculum/schedule.html',
    kind: 'calendar' as const,
    enabled: true,
    sortOrder: 60,
    isBuiltin: true
  }
]

export const ALLOWED_PORTAL_HOSTS = ['chaoxing.com', 'xuexitong.com'] as const

export const PORTAL_PARTITION = 'persist:studynext-portal'
