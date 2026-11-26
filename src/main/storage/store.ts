import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BUILTIN_ENTRIES,
  COURSE_COLORS,
  DEFAULT_SETTINGS,
  REMINDER_MAX_MINUTES
} from '@shared/constants'
import { normalizeReminderOffsets } from '@shared/domain'
import { resolveNoticeCourseName } from '@shared/notice-course'
import type {
  AppNotice,
  AppSettings,
  Chapter,
  ChapterSection,
  Course,
  CourseSession,
  DataSource,
  Exam,
  Material,
  MaterialLocalFile,
  OfficialEntry,
  OfficialEntryInput,
  PlatformStatusKind,
  PortalDownload,
  ReminderRule,
  StudyPoint,
  StudyPointKind,
  Task,
  TaskAttachment,
  TaskChange,
  TaskCompletionSource,
  TaskField,
  TaskUpsertInput
} from '@shared/types'
import { UserFacingError } from '../lib/errors'
import { localDateWithOffset } from '../lib/time'

type SqlValue = string | number | null

interface CourseRow {
  id: string
  external_id: string | null
  name: string
  code: string
  teacher: string
  semester: string
  category: string
  color: string
  favorite: number
  clazz_id: string | null
  class_name: string | null
  schedule_json: string
  semester_start: string | null
  max_week: number
  source: string
  source_url: string | null
  created_at: string
  updated_at: string
}

interface ExamRow {
  id: string
  external_id: string
  title: string
  course_name: string | null
  start_at: string | null
  end_at: string | null
  duration_minutes: number | null
  exam_status: string
  answer_status: string
  score: string | null
  mode: string | null
  source_url: string | null
  source: string
  updated_at: string
}

interface MaterialRow {
  id: string
  course_id: string
  external_id: string
  name: string
  kind: string
  file_type: string | null
  size: string | null
  url: string | null
  source_url: string | null
  source: string
  updated_at: string
}

interface DownloadRow {
  id: string
  filename: string
  url: string
  state: string
  received_bytes: number
  total_bytes: number
  started_at: string
  completed_at: string | null
  save_path: string | null
  material_id: string | null
  attachment_task_id: string | null
  attachment_object_id: string | null
  attachment_file_name: string | null
  attachment_index: number | null
}

interface TaskRow {
  id: string
  title: string
  description: string
  course_id: string | null
  priority: string
  kind: string
  status: string
  due_at: string
  completed_at: string | null
  completion_source: string | null
  source: string
  external_id: string | null
  source_updated_at: string | null
  source_url: string | null
  platform_status: string | null
  platform_status_kind: string
  submitted_at: string | null
  score: string | null
  full_score: string | null
  teacher_feedback: string | null
  attachments_json: string
  manual_fields_json: string
  field_sources_json: string
  created_at: string
  updated_at: string
}

interface TaskChangeRow {
  id: string
  task_id: string
  changed_at: string
  origin: string
  summary: string
  changes_json: string
}

export interface ImportedTaskUpsertResult {
  task: Task
  action: 'created' | 'updated' | 'unchanged'
  deadlineChanged: boolean
  conflicts: TaskField[]
}

interface ReminderRow {
  id: string
  task_id: string
  offset_minutes: number
  enabled: number
  created_at: string
}

export interface NotificationDeliveryFailure {
  dedupeKey: string
  taskId: string
  ruleId: string
  dueAt: string
  scheduledFor: string
  attemptCount: number
  lastError: string
  lastAttemptAt: string
  nextRetryAt: string | null
}

interface DeliveryFailureRow {
  dedupe_key: string
  task_id: string
  rule_id: string
  due_at: string
  scheduled_for: string
  attempt_count: number
  last_error: string
  last_attempt_at: string
  next_retry_at: string | null
}

function mapDeliveryFailure(row: DeliveryFailureRow): NotificationDeliveryFailure {
  return {
    dedupeKey: row.dedupe_key,
    taskId: row.task_id,
    ruleId: row.rule_id,
    dueAt: row.due_at,
    scheduledFor: row.scheduled_for,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    nextRetryAt: row.next_retry_at
  }
}

interface EntryRow {
  id: string
  label: string
  description: string
  url: string
  kind: string
  enabled: number
  sort_order: number
  is_builtin: number
}

interface ChapterRow {
  id: string
  course_id: string
  external_id: string | null
  title: string
  sort_order: number
  progress: number
  last_studied_at: string | null
  source_url: string | null
  sections_json: string
  source: string
  created_at: string
  updated_at: string
}

interface StudyPointRow {
  id: string
  chapter_id: string
  course_id: string
  external_id: string | null
  title: string
  kind: string
  status: string
  duration_minutes: number | null
  sort_order: number
  source: string
  created_at: string
  updated_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  teacher TEXT NOT NULL DEFAULT '',
  semester TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '其他',
  color TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  clazz_id TEXT,
  class_name TEXT,
  schedule_json TEXT NOT NULL DEFAULT '[]',
  semester_start TEXT,
  max_week INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS course_chapters (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  external_id TEXT,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  last_studied_at TEXT,
  source_url TEXT,
  sections_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chapters_course ON course_chapters(course_id, sort_order);

CREATE TABLE IF NOT EXISTS study_points (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES course_chapters(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  external_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('video', 'reading', 'quiz', 'discussion', 'assignment', 'other')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done')),
  duration_minutes INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_points_chapter ON study_points(chapter_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_external
  ON course_chapters(course_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_points_external
  ON study_points(course_id, source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  kind TEXT NOT NULL CHECK (kind IN ('homework', 'exam', 'reading', 'activity', 'other')),
  status TEXT NOT NULL CHECK (status IN ('todo', 'done')),
  due_at TEXT NOT NULL,
  completed_at TEXT,
  completion_source TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  source_updated_at TEXT,
  source_url TEXT,
  platform_status TEXT,
  platform_status_kind TEXT NOT NULL DEFAULT 'unknown',
  submitted_at TEXT,
  score TEXT,
  full_score TEXT,
  teacher_feedback TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  field_sources_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external
  ON tasks(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_at);

CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  course_name TEXT,
  start_at TEXT,
  end_at TEXT,
  duration_minutes INTEGER,
  exam_status TEXT NOT NULL DEFAULT '',
  answer_status TEXT NOT NULL DEFAULT '',
  score TEXT,
  mode TEXT,
  source_url TEXT,
  source TEXT NOT NULL DEFAULT 'chaoxing',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exams_external ON exams(source, external_id);
CREATE INDEX IF NOT EXISTS idx_exams_start ON exams(start_at);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  file_type TEXT,
  size TEXT,
  url TEXT,
  source_url TEXT,
  source TEXT NOT NULL DEFAULT 'chaoxing',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_external ON materials(course_id, external_id);
CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id, kind, name);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  save_path TEXT,
  material_id TEXT,
  attachment_task_id TEXT,
  attachment_object_id TEXT,
  attachment_file_name TEXT,
  attachment_index INTEGER
);
CREATE INDEX IF NOT EXISTS idx_downloads_started ON downloads(started_at DESC);

CREATE TABLE IF NOT EXISTS material_local_files (
  material_id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  download_id TEXT,
  filename TEXT NOT NULL,
  save_path TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  downloaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_material_local_course ON material_local_files(course_id);

CREATE TABLE IF NOT EXISTS app_notices (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'notice',
  sender TEXT,
  course_name TEXT,
  published_at TEXT NOT NULL,
  is_read INTEGER,
  url TEXT,
  source TEXT NOT NULL DEFAULT 'chaoxing',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notices_external ON app_notices(source, external_id);
CREATE INDEX IF NOT EXISTS idx_notices_published ON app_notices(published_at DESC);

CREATE TABLE IF NOT EXISTS task_change_log (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL,
  origin TEXT NOT NULL,
  summary TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_task_changes_task ON task_change_log(task_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS task_reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL CHECK (offset_minutes >= 5),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(task_id, offset_minutes)
);
CREATE INDEX IF NOT EXISTS idx_task_reminders_task ON task_reminders(task_id);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  dedupe_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES task_reminders(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  delivered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_task ON notification_deliveries(task_id);

CREATE TABLE IF NOT EXISTS notification_delivery_failures (
  dedupe_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES task_reminders(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  last_error TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  next_retry_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delivery_failure_retry
  ON notification_delivery_failures(next_retry_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS official_entries (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1))
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const DEMO_COURSES = [
  {
    name: '数据结构与算法',
    code: 'CS201',
    teacher: '王砚秋',
    category: '必修',
    color: COURSE_COLORS[0],
    sessions: [
      {
        weekday: 1,
        startTime: '08:00',
        endTime: '09:40',
        location: '逸夫楼 A302',
        weeks: '1-16 周'
      },
      {
        weekday: 3,
        startTime: '10:00',
        endTime: '11:40',
        location: '逸夫楼 A302',
        weeks: '1-16 周'
      }
    ]
  },
  {
    name: '计算机网络',
    code: 'CS302',
    teacher: '李明远',
    category: '必修',
    color: COURSE_COLORS[1],
    sessions: [
      {
        weekday: 2,
        startTime: '10:00',
        endTime: '11:40',
        location: '博学楼 B201',
        weeks: '1-16 周'
      },
      {
        weekday: 4,
        startTime: '14:00',
        endTime: '15:40',
        location: '博学楼 B201',
        weeks: '1-16 周'
      }
    ]
  },
  {
    name: '中国近现代史纲要',
    code: 'HIS101',
    teacher: '周璐',
    category: '通识',
    color: COURSE_COLORS[2],
    sessions: [
      { weekday: 3, startTime: '14:00', endTime: '15:40', location: '博学楼 101', weeks: '1-12 周' }
    ]
  },
  {
    name: '概率论与数理统计',
    code: 'MATH204',
    teacher: '陈嘉禾',
    category: '必修',
    color: COURSE_COLORS[3],
    sessions: [
      {
        weekday: 4,
        startTime: '08:00',
        endTime: '09:40',
        location: '理学楼 205',
        weeks: '1-16 周'
      },
      { weekday: 5, startTime: '10:00', endTime: '11:40', location: '理学楼 205', weeks: '1-16 周' }
    ]
  },
  {
    name: '数字媒体设计',
    code: 'ART210',
    teacher: '林知夏',
    category: '选修',
    color: COURSE_COLORS[4],
    sessions: [
      {
        weekday: 5,
        startTime: '15:00',
        endTime: '16:40',
        location: '创意工坊 3F',
        weeks: '1-14 周'
      }
    ]
  }
] as const

const DEMO_TASKS: ReadonlyArray<{
  title: string
  description: string
  courseIndex: number | null
  priority: 'high' | 'medium' | 'low'
  kind: 'homework' | 'exam' | 'reading' | 'activity' | 'other'
  status?: 'todo' | 'done'
  days: number
  hour: number
  minute?: number
  offsets: number[]
}> = [
  {
    title: '实验三：图的最短路径',
    description: '完成 Dijkstra 与 Bellman-Ford 的对比实验，提交代码、实验报告和运行截图。',
    courseIndex: 0,
    priority: 'high',
    kind: 'homework',
    days: 0,
    hour: 23,
    minute: 59,
    offsets: [1440, 180, 60]
  },
  {
    title: '第三章课后练习',
    description: '完成二叉树遍历与平衡树相关的 8 道课后题。',
    courseIndex: 0,
    priority: 'medium',
    kind: 'homework',
    status: 'done',
    days: -2,
    hour: 18,
    offsets: [1440, 180]
  },
  {
    title: '期中复习提纲',
    description: '整理第 1-6 章的知识点，补充复杂度分析例题。',
    courseIndex: 0,
    priority: 'medium',
    kind: 'reading',
    days: 4,
    hour: 20,
    offsets: [4320, 1440, 180]
  },
  {
    title: 'Wireshark 抓包分析',
    description: '分析 TCP 三次握手与 HTTP 请求过程，提交 pcapng 文件和 2 页说明。',
    courseIndex: 1,
    priority: 'high',
    kind: 'homework',
    days: 2,
    hour: 22,
    offsets: [1440, 180, 60]
  },
  {
    title: '第二章小测',
    description: '网络体系结构与物理层在线小测，限时 30 分钟。',
    courseIndex: 1,
    priority: 'high',
    kind: 'exam',
    days: -1,
    hour: 23,
    minute: 59,
    offsets: [1440, 60]
  },
  {
    title: '小组汇报：边缘计算',
    description: '整理边缘计算在校园网络中的应用案例，准备 8 分钟展示。',
    courseIndex: 1,
    priority: 'medium',
    kind: 'activity',
    days: 6,
    hour: 10,
    offsets: [4320, 1440]
  },
  {
    title: '辛亥革命史料整理',
    description: '从指定档案中选取三则史料，撰写 800 字分析。',
    courseIndex: 2,
    priority: 'medium',
    kind: 'reading',
    days: 3,
    hour: 23,
    minute: 59,
    offsets: [1440, 180]
  },
  {
    title: '线上讨论：近代化道路',
    description: '在讨论区回复两个同学的观点，并补充一条史料。',
    courseIndex: 2,
    priority: 'low',
    kind: 'activity',
    status: 'done',
    days: -1,
    hour: 20,
    offsets: [180]
  },
  {
    title: '第五章测验',
    description: '复习教材第五章，测验开放时间为 19:00-19:40。',
    courseIndex: 2,
    priority: 'high',
    kind: 'exam',
    days: 5,
    hour: 19,
    offsets: [4320, 1440, 180, 60]
  },
  {
    title: '习题 4.1-4.6',
    description: '完成期望与方差章节习题，重点订正第 4.5 题。',
    courseIndex: 3,
    priority: 'medium',
    kind: 'homework',
    days: 0,
    hour: 21,
    offsets: [180, 60]
  },
  {
    title: '概率论期中考试',
    description: '考场：理学楼 205。可携带一张 A4 手写公式纸。',
    courseIndex: 3,
    priority: 'high',
    kind: 'exam',
    days: 7,
    hour: 9,
    offsets: [4320, 1440, 180, 60]
  },
  {
    title: '海报概念提案',
    description: '提交 3 个视觉方向草案，每个方向包含配色、字体和参考图。',
    courseIndex: 4,
    priority: 'high',
    kind: 'homework',
    days: 1,
    hour: 15,
    offsets: [1440, 180, 60]
  },
  {
    title: 'Figma 动效练习',
    description: '完成 Smart Animate 交互原型，导出演示视频。',
    courseIndex: 4,
    priority: 'low',
    kind: 'homework',
    status: 'done',
    days: -3,
    hour: 12,
    offsets: [1440]
  },
  {
    title: '期末项目组队',
    description: '确认 4 人小组与选题方向，在课程页提交组队信息。',
    courseIndex: 4,
    priority: 'medium',
    kind: 'activity',
    days: 8,
    hour: 18,
    offsets: [4320, 1440]
  },
  {
    title: '图书馆还书',
    description: '归还《设计中的设计》和《算法导论》。',
    courseIndex: null,
    priority: 'medium',
    kind: 'other',
    days: 1,
    hour: 17,
    offsets: [180]
  }
]

export interface StudyNextStoreOptions {
  readOnly?: boolean
  workspaceId?: string
  accountId?: string
}

export class StudyNextStore {
  readonly db: DatabaseSync
  readonly readOnly: boolean
  readonly workspaceId: string | null
  readonly accountId: string | null
  private transactionDepth = 0

  constructor(
    readonly filePath: string,
    options: StudyNextStoreOptions = {}
  ) {
    this.readOnly = options.readOnly === true
    this.workspaceId = options.workspaceId ?? null
    this.accountId = options.accountId ?? null
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true })
    }
    this.db = this.readOnly
      ? new DatabaseSync(filePath, { readOnly: true })
      : new DatabaseSync(filePath)
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    if (this.readOnly) {
      this.db.exec('PRAGMA query_only = ON;')
      return
    }
    if (filePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;')
    }
    this.db.exec(SCHEMA)
    this.migrateSchema()
    this.seedDefaults()
  }

  private migrateSchema(): void {
    const columns = this.db.prepare('PRAGMA table_info(courses)').all() as unknown as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'external_id')) {
      this.db.exec('ALTER TABLE courses ADD COLUMN external_id TEXT')
    }
    const addCourseColumn = (name: string, definition: string): void => {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE courses ADD COLUMN ${name} ${definition}`)
      }
    }
    addCourseColumn('semester_start', 'TEXT')
    addCourseColumn('max_week', 'INTEGER NOT NULL DEFAULT 0')
    addCourseColumn('clazz_id', 'TEXT')
    addCourseColumn('class_name', 'TEXT')
    const chapterColumns = this.db
      .prepare('PRAGMA table_info(course_chapters)')
      .all() as unknown as Array<{
      name: string
    }>
    const addChapterColumn = (name: string, definition: string): void => {
      if (!chapterColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE course_chapters ADD COLUMN ${name} ${definition}`)
      }
    }
    addChapterColumn('source_url', 'TEXT')
    addChapterColumn('sections_json', "TEXT NOT NULL DEFAULT '[]'")
    const taskColumns = this.db.prepare('PRAGMA table_info(tasks)').all() as unknown as Array<{
      name: string
    }>
    const addTaskColumn = (name: string, definition: string): void => {
      if (!taskColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`)
      }
    }
    addTaskColumn('completion_source', 'TEXT')
    addTaskColumn('source_updated_at', 'TEXT')
    addTaskColumn('source_url', 'TEXT')
    addTaskColumn('platform_status', 'TEXT')
    addTaskColumn('platform_status_kind', "TEXT NOT NULL DEFAULT 'unknown'")
    addTaskColumn('submitted_at', 'TEXT')
    addTaskColumn('score', 'TEXT')
    addTaskColumn('full_score', 'TEXT')
    addTaskColumn('teacher_feedback', 'TEXT')
    addTaskColumn('attachments_json', "TEXT NOT NULL DEFAULT '[]'")
    // 旧版本把平台状态简化为 pending/done，升级到细粒度状态。
    this.db
      .prepare(
        "UPDATE tasks SET platform_status_kind = 'not_submitted' WHERE platform_status_kind = 'pending'"
      )
      .run()
    addTaskColumn('manual_fields_json', "TEXT NOT NULL DEFAULT '[]'")
    addTaskColumn('field_sources_json', "TEXT NOT NULL DEFAULT '{}'")
    const downloadColumns = this.db
      .prepare('PRAGMA table_info(downloads)')
      .all() as unknown as Array<{
      name: string
    }>
    if (!downloadColumns.some((column) => column.name === 'material_id')) {
      this.db.exec('ALTER TABLE downloads ADD COLUMN material_id TEXT')
    }
    if (!downloadColumns.some((column) => column.name === 'attachment_task_id')) {
      this.db.exec('ALTER TABLE downloads ADD COLUMN attachment_task_id TEXT')
    }
    if (!downloadColumns.some((column) => column.name === 'attachment_object_id')) {
      this.db.exec('ALTER TABLE downloads ADD COLUMN attachment_object_id TEXT')
    }
    if (!downloadColumns.some((column) => column.name === 'attachment_file_name')) {
      this.db.exec('ALTER TABLE downloads ADD COLUMN attachment_file_name TEXT')
    }
    if (!downloadColumns.some((column) => column.name === 'attachment_index')) {
      this.db.exec('ALTER TABLE downloads ADD COLUMN attachment_index INTEGER')
    }
    this.db.exec(`
      DROP INDEX IF EXISTS idx_chapters_external;
      DROP INDEX IF EXISTS idx_points_external;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_external
        ON courses(source, external_id) WHERE external_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_chapters_external
        ON course_chapters(course_id, source, external_id) WHERE external_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_points_external
        ON study_points(course_id, source, external_id) WHERE external_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_change_log (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        changed_at TEXT NOT NULL,
        origin TEXT NOT NULL,
        summary TEXT NOT NULL,
        changes_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_task_changes_task
        ON task_change_log(task_id, changed_at DESC);
      CREATE TABLE IF NOT EXISTS material_local_files (
        material_id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        download_id TEXT,
        filename TEXT NOT NULL,
        save_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        downloaded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_material_local_course
        ON material_local_files(course_id);
    `)
  }

  close(): void {
    this.db.close()
  }

  private seedDefaults(): void {
    const now = new Date().toISOString()
    const insertSetting = this.db.prepare(
      'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
    )
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insertSetting.run(key, JSON.stringify(value))
    }
    const insertEntry = this.db.prepare(`
      INSERT OR IGNORE INTO official_entries
        (id, label, description, url, kind, enabled, sort_order, is_builtin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const entry of BUILTIN_ENTRIES) {
      insertEntry.run(
        entry.id,
        entry.label,
        entry.description,
        entry.url,
        entry.kind,
        entry.enabled ? 1 : 0,
        entry.sortOrder,
        entry.isBuiltin ? 1 : 0
      )
    }
    const updateBuiltinUrl = this.db.prepare(
      'UPDATE official_entries SET url = ? WHERE id = ? AND is_builtin = 1'
    )
    for (const entry of BUILTIN_ENTRIES) {
      // Built-in URLs can be corrected between releases; user-created entries
      // and per-entry enabled flags are never touched here.
      updateBuiltinUrl.run(entry.url, entry.id)
    }
    this.setMetaIfMissing('schema_version', '3')
    if (this.getMeta('schema_version') === '1' || this.getMeta('schema_version') === '2') {
      this.setMeta('schema_version', '3')
    }
    this.setMetaIfMissing('demo_initialized', '0')
    if (this.getMeta('demo_initialized') === '0') {
      this.seedDemoData()
      this.setMeta('demo_initialized', '1')
    }
    this.ensureDemoCurriculum()
    this.setMetaIfMissing('last_seed_at', now)
  }

  private seedDemoData(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM notification_deliveries; DELETE FROM tasks; DELETE FROM courses;')
      const insertCourse = this.db.prepare(`
        INSERT INTO courses
          (id, external_id, name, code, teacher, semester, category, color, favorite, schedule_json,
           source, source_url, created_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', NULL, ?, ?)
      `)
      const now = new Date().toISOString()
      const semester = currentSemesterLabel()
      const courseIds = DEMO_COURSES.map((course, index) => {
        const id = randomUUID()
        const schedule: CourseSession[] = course.sessions.map((session) => ({
          ...session,
          id: randomUUID()
        }))
        insertCourse.run(
          id,
          course.name,
          course.code,
          course.teacher,
          semester,
          course.category,
          course.color,
          index === 0 || index === 1 ? 1 : 0,
          JSON.stringify(schedule),
          now,
          now
        )
        return id
      })
      const insertTask = this.db.prepare(`
        INSERT INTO tasks
          (id, title, description, course_id, priority, kind, status, due_at, completed_at,
           source, external_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', NULL, ?, ?)
      `)
      const insertReminder = this.db.prepare(`
        INSERT INTO task_reminders(id, task_id, offset_minutes, enabled, created_at)
        VALUES (?, ?, ?, 1, ?)
      `)
      for (const task of DEMO_TASKS) {
        const id = randomUUID()
        const due = localDateWithOffset(task.days, task.hour, task.minute ?? 0)
        const status = task.status ?? 'todo'
        insertTask.run(
          id,
          task.title,
          task.description,
          task.courseIndex === null ? null : (courseIds[task.courseIndex] ?? null),
          task.priority,
          task.kind,
          status,
          due.toISOString(),
          status === 'done' ? now : null,
          now,
          now
        )
        for (const offset of task.offsets) {
          insertReminder.run(randomUUID(), id, offset, now)
        }
      }
      this.insertDemoCurriculum(courseIds, now)
      this.setMeta('last_seed_at', now)
    })
  }

  private insertDemoCurriculum(courseIds: string[], now: string): void {
    const insertChapter = this.db.prepare(`
      INSERT INTO course_chapters
        (id, course_id, external_id, title, sort_order, progress, last_studied_at,
         source, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 'demo', ?, ?)
    `)
    const insertPoint = this.db.prepare(`
      INSERT INTO study_points
        (id, chapter_id, course_id, external_id, title, kind, status, duration_minutes,
         sort_order, source, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'demo', ?, ?)
    `)
    const pointTemplates: ReadonlyArray<{
      title: string
      kind: StudyPointKind
      minutes: number
    }> = [
      { title: '章节导读与学习目标', kind: 'reading', minutes: 10 },
      { title: '核心知识讲解', kind: 'video', minutes: 25 },
      { title: '章节练习', kind: 'quiz', minutes: 15 },
      { title: '拓展讨论与反思', kind: 'discussion', minutes: 10 }
    ]
    for (const [courseIndex, courseId] of courseIds.entries()) {
      for (let chapterIndex = 0; chapterIndex < 3; chapterIndex += 1) {
        const completedCount = chapterIndex === 0 ? 4 : chapterIndex === 1 ? 2 : 0
        const chapterId = randomUUID()
        const progress = (completedCount / pointTemplates.length) * 100
        const studiedAt =
          completedCount > 0
            ? new Date(Date.parse(now) - (courseIndex + 1) * 86_400_000).toISOString()
            : null
        insertChapter.run(
          chapterId,
          courseId,
          `第 ${chapterIndex + 1} 章 · ${chapterIndex === 0 ? '基础概念' : chapterIndex === 1 ? '核心方法' : '综合实践'}`,
          chapterIndex,
          progress,
          studiedAt,
          now,
          now
        )
        for (const [pointIndex, template] of pointTemplates.entries()) {
          const done = pointIndex < completedCount
          insertPoint.run(
            randomUUID(),
            chapterId,
            courseId,
            template.title,
            template.kind,
            done ? 'done' : 'todo',
            template.minutes,
            pointIndex,
            now,
            now
          )
        }
      }
    }
  }

  private ensureDemoCurriculum(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM course_chapters').get() as {
      count: number
    }
    if (Number(count.count) > 0) return
    const rows = this.db
      .prepare("SELECT id FROM courses WHERE source = 'demo' ORDER BY name COLLATE NOCASE ASC")
      .all() as unknown as Array<{ id: string }>
    if (rows.length === 0) return
    this.transaction(() => {
      this.insertDemoCurriculum(
        rows.map((row) => row.id),
        new Date().toISOString()
      )
    })
  }

  /**
   * 真实学习通数据第一次同步成功后，演示数据会与真实课程/作业混在一起，
   * 让用户误以为同步没有生效。这里只清理 source='demo' 的种子数据，
   * 手动录入、导入与学习通数据都保留。
   */
  clearDemoData(): { courses: number; tasks: number } {
    return this.transaction(() => {
      const demoTaskIds = (
        this.db.prepare("SELECT id FROM tasks WHERE source = 'demo'").all() as unknown as Array<{
          id: string
        }>
      ).map((row) => row.id)
      const demoCourseIds = (
        this.db.prepare("SELECT id FROM courses WHERE source = 'demo'").all() as unknown as Array<{
          id: string
        }>
      ).map((row) => row.id)
      for (const taskId of demoTaskIds) {
        this.db.prepare('DELETE FROM task_reminders WHERE task_id = ?').run(taskId)
        this.db.prepare('DELETE FROM notification_deliveries WHERE task_id = ?').run(taskId)
        this.db.prepare('DELETE FROM notification_delivery_failures WHERE task_id = ?').run(taskId)
        this.db.prepare('DELETE FROM task_change_log WHERE task_id = ?').run(taskId)
      }
      for (const courseId of demoCourseIds) {
        this.db.prepare('DELETE FROM study_points WHERE course_id = ?').run(courseId)
        this.db.prepare('DELETE FROM course_chapters WHERE course_id = ?').run(courseId)
      }
      this.db.prepare("DELETE FROM tasks WHERE source = 'demo'").run()
      this.db.prepare("DELETE FROM courses WHERE source = 'demo'").run()
      return { courses: demoCourseIds.length, tasks: demoTaskIds.length }
    })
  }

  resetDemoData(): void {
    this.seedDemoData()
    this.setMeta('demo_initialized', '1')
  }

  getLastSeedAt(): string | null {
    return this.getMeta('last_seed_at')
  }

  listCourses(): Course[] {
    const rows = this.db
      .prepare('SELECT * FROM courses ORDER BY favorite DESC, name COLLATE NOCASE ASC')
      .all() as unknown as CourseRow[]
    return rows.map(mapCourseRow)
  }

  listExams(): Exam[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM exams
         ORDER BY CASE WHEN start_at IS NULL THEN 1 ELSE 0 END ASC, start_at DESC, title ASC`
      )
      .all() as unknown as ExamRow[]
    return rows.map(mapExamRow)
  }

  listMaterials(): Material[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM materials
         ORDER BY course_id ASC, CASE kind WHEN 'folder' THEN 0 ELSE 1 END ASC, name COLLATE NOCASE ASC`
      )
      .all() as unknown as MaterialRow[]
    return rows.map(mapMaterialRow)
  }

  getMaterial(id: string): Material | null {
    const row = this.db
      .prepare('SELECT * FROM materials WHERE id = ? LIMIT 1')
      .get(id) as unknown as MaterialRow | undefined
    return row ? mapMaterialRow(row) : null
  }

  replaceProviderMaterials(
    courseId: string,
    items: Array<{
      externalId: string
      name: string
      kind: 'folder' | 'file' | 'link'
      fileType?: string | null
      size?: string | null
      url?: string | null
      sourceUrl?: string | null
    }>,
    source: DataSource = 'chaoxing'
  ): number {
    const now = new Date().toISOString()
    const insert = this.db.prepare(
      `INSERT INTO materials
        (id, course_id, external_id, name, kind, file_type, size, url, source_url, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(course_id, external_id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         file_type = excluded.file_type,
         size = excluded.size,
         url = excluded.url,
         source_url = excluded.source_url,
         source = excluded.source,
         updated_at = excluded.updated_at`
    )
    for (const item of items) {
      insert.run(
        randomUUID(),
        courseId,
        item.externalId,
        item.name,
        item.kind,
        item.fileType ?? null,
        item.size ?? null,
        item.url ?? null,
        item.sourceUrl ?? null,
        source,
        now
      )
    }
    return items.length
  }

  listDownloads(limit = 100): PortalDownload[] {
    const rows = this.db
      .prepare('SELECT * FROM downloads ORDER BY started_at DESC LIMIT ?')
      .all(limit) as unknown as DownloadRow[]
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      url: row.url,
      state: row.state as PortalDownload['state'],
      receivedBytes: row.received_bytes,
      totalBytes: row.total_bytes,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      ...(row.save_path ? { savePath: row.save_path } : {}),
      ...(row.material_id ? { materialId: row.material_id } : {}),
      ...(row.attachment_task_id
        ? {
            attachmentTaskId: row.attachment_task_id,
            attachmentObjectId: row.attachment_object_id,
            attachmentFileName: row.attachment_file_name,
            attachmentIndex: row.attachment_index
          }
        : {})
    }))
  }

  upsertDownload(item: PortalDownload): void {
    this.db
      .prepare(
        `INSERT INTO downloads
          (id, filename, url, state, received_bytes, total_bytes, started_at, completed_at, save_path, material_id, attachment_task_id, attachment_object_id, attachment_file_name, attachment_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           filename = excluded.filename,
           url = excluded.url,
           state = excluded.state,
           received_bytes = excluded.received_bytes,
           total_bytes = excluded.total_bytes,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           save_path = excluded.save_path,
           material_id = COALESCE(downloads.material_id, excluded.material_id),
           attachment_task_id = COALESCE(downloads.attachment_task_id, excluded.attachment_task_id),
           attachment_object_id = COALESCE(downloads.attachment_object_id, excluded.attachment_object_id),
           attachment_file_name = COALESCE(downloads.attachment_file_name, excluded.attachment_file_name),
           attachment_index = COALESCE(downloads.attachment_index, excluded.attachment_index)`
      )
      .run(
        item.id,
        item.filename,
        item.url,
        item.state,
        item.receivedBytes,
        item.totalBytes,
        item.startedAt,
        item.completedAt,
        item.savePath ?? null,
        item.materialId ?? null,
        item.attachmentTaskId ?? null,
        item.attachmentObjectId ?? null,
        item.attachmentFileName ?? null,
        item.attachmentIndex ?? null
      )
  }

  deleteFinishedDownloads(ids: string[]): void {
    if (ids.length === 0) return
    const statement = this.db.prepare('DELETE FROM downloads WHERE id = ?')
    this.transaction(() => {
      for (const id of ids) statement.run(id)
    })
  }

  deleteDownload(id: string): void {
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id)
  }

  listCompletedMaterialDownloads(): PortalDownload[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM downloads
         WHERE state = 'completed' AND material_id IS NOT NULL
         ORDER BY COALESCE(completed_at, started_at) DESC, started_at DESC`
      )
      .all() as unknown as DownloadRow[]
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      url: row.url,
      state: row.state as PortalDownload['state'],
      receivedBytes: row.received_bytes,
      totalBytes: row.total_bytes,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      ...(row.save_path ? { savePath: row.save_path } : {}),
      ...(row.material_id ? { materialId: row.material_id } : {})
    }))
  }

  listMaterialLocalFiles(): MaterialLocalFile[] {
    try {
      const rows = this.db
        .prepare('SELECT * FROM material_local_files ORDER BY downloaded_at DESC')
        .all() as unknown as Array<{
        material_id: string
        course_id: string
        download_id: string | null
        filename: string
        save_path: string
        file_size: number
        downloaded_at: string
      }>
      return rows.map((row) => ({
        materialId: row.material_id,
        courseId: row.course_id,
        downloadId: row.download_id,
        filename: row.filename,
        savePath: row.save_path,
        fileSize: row.file_size,
        downloadedAt: row.downloaded_at
      }))
    } catch {
      // Legacy read-only workspace may not contain the `material_local_files` table yet.
      return []
    }
  }

  upsertMaterialLocalFile(record: MaterialLocalFile): void {
    this.db
      .prepare(
        `INSERT INTO material_local_files
          (material_id, course_id, download_id, filename, save_path, file_size, downloaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(material_id) DO UPDATE SET
           course_id = excluded.course_id,
           download_id = excluded.download_id,
           filename = excluded.filename,
           save_path = excluded.save_path,
           file_size = excluded.file_size,
           downloaded_at = excluded.downloaded_at`
      )
      .run(
        record.materialId,
        record.courseId,
        record.downloadId ?? null,
        record.filename,
        record.savePath,
        record.fileSize,
        record.downloadedAt
      )
  }

  deleteMaterialLocalFile(materialId: string): void {
    try {
      this.db.prepare('DELETE FROM material_local_files WHERE material_id = ?').run(materialId)
    } catch {
      // Ignore if table is absent in legacy database.
    }
  }

  listNotices(limit = 50): AppNotice[] {
    const rows = this.db
      .prepare(`SELECT * FROM app_notices ORDER BY published_at DESC, title ASC LIMIT ?`)
      .all(limit) as unknown as Array<{
      id: string
      title: string
      body: string
      category: string
      sender: string | null
      course_name: string | null
      published_at: string
      is_read: number | null
      url: string | null
      source: DataSource
    }>
    const knownCourseNames = (
      this.db.prepare('SELECT name FROM courses').all() as unknown as Array<{ name: string }>
    ).map((course) => course.name)
    return rows.map((row) => {
      const courseName = resolveNoticeCourseName({
        title: row.title,
        body: row.body,
        sender: row.sender,
        currentCourseName: row.course_name,
        knownCourseNames
      })
      const category = row.category === 'system' ? 'system' : courseName ? 'course' : 'notice'
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        category,
        publishedAt: row.published_at,
        isDemo: false,
        source: row.source,
        sender: row.sender,
        courseName,
        read: row.is_read === null ? null : row.is_read === 1,
        url: row.url
      }
    })
  }

  upsertProviderNotice(
    input: {
      externalId: string
      title: string
      body: string
      category?: 'course' | 'system' | 'notice'
      sender?: string | null
      courseName?: string | null
      publishedAt: string
      read?: boolean | null
      url?: string | null
    },
    source: DataSource = 'chaoxing'
  ): { created: boolean } {
    const existing = this.db
      .prepare('SELECT id FROM app_notices WHERE source = ? AND external_id = ? LIMIT 1')
      .get(source, input.externalId) as { id: string } | undefined
    const now = new Date().toISOString()
    if (existing) {
      this.db
        .prepare(
          `UPDATE app_notices SET title = ?, body = ?, category = ?, sender = ?, course_name = ?,
             published_at = ?, is_read = ?, url = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          input.title,
          input.body,
          input.category ?? 'notice',
          input.sender ?? null,
          input.courseName ?? null,
          input.publishedAt,
          input.read === undefined || input.read === null ? null : input.read ? 1 : 0,
          input.url ?? null,
          now,
          existing.id
        )
      return { created: false }
    }
    this.db
      .prepare(
        `INSERT INTO app_notices
          (id, external_id, title, body, category, sender, course_name, published_at, is_read, url, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.externalId,
        input.title,
        input.body,
        input.category ?? 'notice',
        input.sender ?? null,
        input.courseName ?? null,
        input.publishedAt,
        input.read === undefined || input.read === null ? null : input.read ? 1 : 0,
        input.url ?? null,
        source,
        now
      )
    return { created: true }
  }

  upsertProviderExam(
    input: {
      externalId: string
      title: string
      courseName?: string | null
      startAt?: string | null
      endAt?: string | null
      durationMinutes?: number | null
      examStatus?: string
      answerStatus?: string
      score?: string | null
      mode?: string | null
      sourceUrl?: string | null
    },
    source: DataSource = 'chaoxing'
  ): { exam: Exam; created: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM exams WHERE source = ? AND external_id = ?')
      .get(source, input.externalId) as ExamRow | undefined
    const now = new Date().toISOString()
    if (existing) {
      this.db
        .prepare(
          `UPDATE exams SET title = ?, course_name = ?, start_at = ?, end_at = ?,
             duration_minutes = ?, exam_status = ?, answer_status = ?, score = ?, mode = ?,
             source_url = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.title,
          input.courseName ?? existing.course_name,
          input.startAt !== undefined ? input.startAt : existing.start_at,
          input.endAt !== undefined ? input.endAt : existing.end_at,
          input.durationMinutes !== undefined ? input.durationMinutes : existing.duration_minutes,
          input.examStatus ?? existing.exam_status,
          input.answerStatus ?? existing.answer_status,
          input.score !== undefined ? input.score : existing.score,
          input.mode !== undefined ? input.mode : existing.mode,
          input.sourceUrl !== undefined ? input.sourceUrl : existing.source_url,
          now,
          existing.id
        )
      const exam = this.db
        .prepare('SELECT * FROM exams WHERE id = ?')
        .get(existing.id) as unknown as ExamRow
      return { exam: mapExamRow(exam), created: false }
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO exams
          (id, external_id, title, course_name, start_at, end_at, duration_minutes,
           exam_status, answer_status, score, mode, source_url, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.externalId,
        input.title,
        input.courseName ?? null,
        input.startAt ?? null,
        input.endAt ?? null,
        input.durationMinutes ?? null,
        input.examStatus ?? '',
        input.answerStatus ?? '',
        input.score ?? null,
        input.mode ?? null,
        input.sourceUrl ?? null,
        source,
        now
      )
    const exam = this.db.prepare('SELECT * FROM exams WHERE id = ?').get(id) as unknown as ExamRow
    return { exam: mapExamRow(exam), created: true }
  }

  getCourse(id: string): Course | null {
    const row = this.db.prepare('SELECT * FROM courses WHERE id = ?').get(id) as
      | CourseRow
      | undefined
    return row ? mapCourseRow(row) : null
  }

  /** 按来源 + 名称查找课程；用于导入任务时限定在 import 记录内匹配。 */
  findCourseByName(name: string, source?: DataSource): Course | null {
    const row = source
      ? (this.db
          .prepare('SELECT * FROM courses WHERE name = ? COLLATE NOCASE AND source = ? LIMIT 1')
          .get(name.trim(), source) as CourseRow | undefined)
      : (this.db
          .prepare('SELECT * FROM courses WHERE name = ? COLLATE NOCASE LIMIT 1')
          .get(name.trim()) as CourseRow | undefined)
    return row ? mapCourseRow(row) : null
  }

  setCourseFavorite(id: string, favorite: boolean): Course {
    const now = new Date().toISOString()
    const result = this.db
      .prepare('UPDATE courses SET favorite = ?, updated_at = ? WHERE id = ?')
      .run(favorite ? 1 : 0, now, id)
    if (Number(result.changes) === 0) {
      throw new UserFacingError('COURSE_NOT_FOUND', '课程不存在')
    }
    const course = this.getCourse(id)
    if (!course) throw new UserFacingError('COURSE_NOT_FOUND', '课程不存在')
    return course
  }

  /** 快照任务缺少课程引用时的兜底：只复用 import 来源的同名课程，绝不认领平台课程。 */
  createImportedCourse(name: string): Course {
    const existing = this.findCourseByName(name, 'import')
    if (existing) return existing
    const id = randomUUID()
    const now = new Date().toISOString()
    const color =
      COURSE_COLORS[Math.floor(Math.random() * COURSE_COLORS.length)] ?? COURSE_COLORS[0]
    this.db
      .prepare(
        `
        INSERT INTO courses
          (id, name, code, teacher, semester, category, color, favorite, schedule_json,
           source, source_url, created_at, updated_at)
        VALUES (?, ?, '', '', ?, '导入', ?, 0, '[]', 'import', NULL, ?, ?)
      `
      )
      .run(id, name.trim(), currentSemesterLabel(), color, now, now)
    const created = this.getCourse(id)
    if (!created) throw new UserFacingError('COURSE_CREATE_FAILED', '课程创建失败')
    return created
  }

  listChapters(): Chapter[] {
    const rows = this.db
      .prepare(
        `
        SELECT chapter.* FROM course_chapters chapter
        JOIN courses course ON course.id = chapter.course_id
        ORDER BY course.name COLLATE NOCASE ASC, chapter.sort_order ASC, chapter.title ASC
      `
      )
      .all() as unknown as ChapterRow[]
    return rows.map(mapChapterRow)
  }

  listStudyPoints(): StudyPoint[] {
    const rows = this.db
      .prepare(
        `
        SELECT point.* FROM study_points point
        JOIN course_chapters chapter ON chapter.id = point.chapter_id
        ORDER BY chapter.sort_order ASC, point.sort_order ASC, point.title ASC
      `
      )
      .all() as unknown as StudyPointRow[]
    return rows.map(mapStudyPointRow)
  }

  getChapter(id: string): Chapter | null {
    const row = this.db.prepare('SELECT * FROM course_chapters WHERE id = ?').get(id) as
      | ChapterRow
      | undefined
    return row ? mapChapterRow(row) : null
  }

  findCourseByExternalId(source: DataSource, externalId: string): Course | null {
    const row = this.db
      .prepare('SELECT * FROM courses WHERE source = ? AND external_id = ? LIMIT 1')
      .get(source, externalId) as CourseRow | undefined
    return row ? mapCourseRow(row) : null
  }

  /**
   * 快照导入专用：只按 (source='import', externalId) 去重。
   * 不按名称或平台来源回退匹配，避免把真实学习通课程改写成导入课程。
   * 同名课程允许共存；导入只新增或更新自己的导入记录。
   */
  upsertSnapshotCourse(input: {
    externalId: string
    name: string
    code: string
    teacher: string
    category: string
    sourceUrl: string | null
    schedule: CourseSession[]
  }): { course: Course; created: boolean } {
    const existing = this.findCourseByExternalId('import', input.externalId)
    const now = new Date().toISOString()
    if (existing) {
      this.db
        .prepare(
          `
          UPDATE courses SET
            external_id = ?, name = ?, code = ?, teacher = ?, category = ?,
            schedule_json = ?, source = 'import', source_url = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .run(
          input.externalId,
          input.name.trim(),
          input.code.trim(),
          input.teacher.trim(),
          input.category.trim() || '学习通',
          JSON.stringify(input.schedule),
          input.sourceUrl,
          now,
          existing.id
        )
      const course = this.getCourse(existing.id)
      if (!course) throw new UserFacingError('COURSE_UPDATE_FAILED', '课程更新失败')
      return { course, created: false }
    }
    const id = randomUUID()
    const color =
      COURSE_COLORS[Math.floor(Math.random() * COURSE_COLORS.length)] ?? COURSE_COLORS[0]
    this.db
      .prepare(
        `
        INSERT INTO courses
          (id, external_id, name, code, teacher, semester, category, color, favorite,
           schedule_json, source, source_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'import', ?, ?, ?)
      `
      )
      .run(
        id,
        input.externalId,
        input.name.trim(),
        input.code.trim(),
        input.teacher.trim(),
        currentSemesterLabel(),
        input.category.trim() || '学习通',
        color,
        JSON.stringify(input.schedule),
        input.sourceUrl,
        now,
        now
      )
    const course = this.getCourse(id)
    if (!course) throw new UserFacingError('COURSE_CREATE_FAILED', '课程创建失败')
    return { course, created: true }
  }

  /**
   * 平台会话同步专用：按 (source, externalId) 去重写入课程。
   * 只更新平台可提供的字段，保留用户改过的收藏、颜色、分类与本地课表。
   */
  upsertProviderCourse(
    input: {
      externalId: string
      name: string
      teacher: string
      semester?: string
      sourceUrl: string | null
      clazzId?: string | null
      className?: string | null
      schedule?: CourseSession[]
      semesterStart?: string | null
      maxWeek?: number
    },
    source: DataSource = 'chaoxing'
  ): { course: Course; created: boolean } {
    const existing = this.findCourseByExternalId(source, input.externalId)
    const now = new Date().toISOString()
    if (existing) {
      const scheduleJson = input.schedule ? JSON.stringify(input.schedule) : existing.schedule
      const scheduleValue =
        typeof scheduleJson === 'string' ? scheduleJson : JSON.stringify(scheduleJson)
      this.db
        .prepare(
          `UPDATE courses SET name = ?, teacher = ?, semester = ?, source_url = ?,
             clazz_id = ?, class_name = ?, schedule_json = ?, semester_start = ?, max_week = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name.trim() || existing.name,
          input.teacher.trim() || existing.teacher,
          input.semester?.trim() || existing.semester,
          input.sourceUrl,
          input.clazzId !== undefined ? input.clazzId : (existing.clazzId ?? null),
          input.className !== undefined ? input.className : (existing.className ?? null),
          scheduleValue,
          input.semesterStart !== undefined
            ? input.semesterStart
            : (existing.semesterStart ?? null),
          input.maxWeek !== undefined ? input.maxWeek : (existing.maxWeek ?? 0),
          now,
          existing.id
        )
      const course = this.getCourse(existing.id)
      if (!course) throw new UserFacingError('COURSE_UPDATE_FAILED', '课程更新失败')
      return { course, created: false }
    }
    const id = randomUUID()
    const color =
      COURSE_COLORS[Math.floor(Math.random() * COURSE_COLORS.length)] ?? COURSE_COLORS[0]
    this.db
      .prepare(
        `INSERT INTO courses
          (id, external_id, name, code, teacher, semester, category, color, favorite,
           clazz_id, class_name, schedule_json, semester_start, max_week, source, source_url, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.externalId,
        input.name.trim() || '未命名课程',
        input.teacher.trim(),
        input.semester?.trim() || currentSemesterLabel(),
        '学习通',
        color,
        input.clazzId ?? null,
        input.className ?? null,
        JSON.stringify(input.schedule ?? []),
        input.semesterStart ?? null,
        input.maxWeek ?? 0,
        source,
        input.sourceUrl,
        now,
        now
      )
    const course = this.getCourse(id)
    if (!course) throw new UserFacingError('COURSE_CREATE_FAILED', '课程创建失败')
    return { course, created: true }
  }

  upsertSnapshotChapter(
    input: {
      courseId: string
      externalId: string
      title: string
      sortOrder: number
      progress: number
      sourceUrl?: string | null
      sections?: ChapterSection[]
    },
    source: DataSource = 'import'
  ): { chapter: Chapter; created: boolean } {
    const now = new Date().toISOString()
    const existing = this.db
      .prepare(
        'SELECT * FROM course_chapters WHERE course_id = ? AND source = ? AND external_id = ? LIMIT 1'
      )
      .get(input.courseId, source, input.externalId) as ChapterRow | undefined
    if (existing) {
      this.db
        .prepare(
          `
          UPDATE course_chapters SET course_id = ?, title = ?, sort_order = ?, progress = ?,
            source_url = ?, sections_json = ?, updated_at = ? WHERE id = ?
        `
        )
        .run(
          input.courseId,
          input.title.trim(),
          input.sortOrder,
          clampProgress(input.progress),
          input.sourceUrl ?? existing.source_url ?? null,
          JSON.stringify(input.sections ?? parseChapterSections(existing.sections_json)),
          now,
          existing.id
        )
      const chapter = this.getChapter(existing.id)
      if (!chapter) throw new UserFacingError('CHAPTER_UPDATE_FAILED', '章节更新失败')
      return { chapter, created: false }
    }
    const id = randomUUID()
    this.db
      .prepare(
        `
        INSERT INTO course_chapters
          (id, course_id, external_id, title, sort_order, progress, last_studied_at,
           source_url, sections_json, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.courseId,
        input.externalId,
        input.title.trim(),
        input.sortOrder,
        clampProgress(input.progress),
        input.sourceUrl ?? null,
        JSON.stringify(input.sections ?? []),
        source,
        now,
        now
      )
    const chapter = this.getChapter(id)
    if (!chapter) throw new UserFacingError('CHAPTER_CREATE_FAILED', '章节创建失败')
    return { chapter, created: true }
  }

  upsertSnapshotPoint(
    input: {
      chapterId: string
      courseId: string
      externalId: string
      title: string
      kind: StudyPointKind
      completed: boolean
      durationMinutes: number | null
      sortOrder: number
    },
    source: DataSource = 'import'
  ): { point: StudyPoint; created: boolean } {
    const now = new Date().toISOString()
    const status = input.completed ? 'done' : 'todo'
    const existing = this.db
      .prepare(
        'SELECT * FROM study_points WHERE course_id = ? AND source = ? AND external_id = ? LIMIT 1'
      )
      .get(input.courseId, source, input.externalId) as StudyPointRow | undefined
    if (existing) {
      this.db
        .prepare(
          `
          UPDATE study_points SET chapter_id = ?, course_id = ?, title = ?, kind = ?,
            status = ?, duration_minutes = ?, sort_order = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .run(
          input.chapterId,
          input.courseId,
          input.title.trim(),
          input.kind,
          status,
          input.durationMinutes,
          input.sortOrder,
          now,
          existing.id
        )
      const point = this.getStudyPoint(existing.id)
      if (!point) throw new UserFacingError('POINT_UPDATE_FAILED', '学习点更新失败')
      return { point, created: false }
    }
    const id = randomUUID()
    this.db
      .prepare(
        `
        INSERT INTO study_points
          (id, chapter_id, course_id, external_id, title, kind, status, duration_minutes,
           sort_order, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.chapterId,
        input.courseId,
        input.externalId,
        input.title.trim(),
        input.kind,
        status,
        input.durationMinutes,
        input.sortOrder,
        source,
        now,
        now
      )
    const point = this.getStudyPoint(id)
    if (!point) throw new UserFacingError('POINT_CREATE_FAILED', '学习点创建失败')
    return { point, created: true }
  }

  deleteProviderStudyPoints(courseId: string, source: DataSource = 'chaoxing'): number {
    const result = this.db
      .prepare('DELETE FROM study_points WHERE course_id = ? AND source = ?')
      .run(courseId, source)
    return Number(result.changes)
  }

  getStudyPoint(id: string): StudyPoint | null {
    const row = this.db.prepare('SELECT * FROM study_points WHERE id = ?').get(id) as
      | StudyPointRow
      | undefined
    return row ? mapStudyPointRow(row) : null
  }

  setStudyPointCompleted(id: string, completed: boolean): { point: StudyPoint; chapter: Chapter } {
    const previous = this.getStudyPoint(id)
    if (!previous) throw new UserFacingError('POINT_NOT_FOUND', '学习点不存在')
    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE study_points SET status = ?, updated_at = ? WHERE id = ?')
      .run(completed ? 'done' : 'todo', now, id)
    const chapter = this.recalculateChapterProgress(previous.chapterId)
    const point = this.getStudyPoint(id)
    if (!point) throw new UserFacingError('POINT_NOT_FOUND', '学习点不存在')
    return { point, chapter }
  }

  recalculateChapterProgress(chapterId: string): Chapter {
    const counts = this.db
      .prepare(
        `
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
        FROM study_points WHERE chapter_id = ?
      `
      )
      .get(chapterId) as { total: number; done: number | null }
    const total = Number(counts.total)
    const done = Number(counts.done ?? 0)
    const progress = total === 0 ? 0 : Math.round((done / total) * 100)
    const now = new Date().toISOString()
    this.db
      .prepare(
        `
        UPDATE course_chapters SET progress = ?,
          last_studied_at = CASE WHEN ? > 0 THEN ? ELSE last_studied_at END,
          updated_at = ?
        WHERE id = ?
      `
      )
      .run(progress, done, now, now, chapterId)
    const chapter = this.getChapter(chapterId)
    if (!chapter) throw new UserFacingError('CHAPTER_NOT_FOUND', '章节不存在')
    return chapter
  }

  listTasks(): Task[] {
    const tasks = this.db
      .prepare('SELECT * FROM tasks ORDER BY due_at ASC')
      .all() as unknown as TaskRow[]
    const reminders = this.db
      .prepare('SELECT * FROM task_reminders ORDER BY offset_minutes DESC')
      .all() as unknown as ReminderRow[]
    const grouped = new Map<string, ReminderRule[]>()
    for (const row of reminders) {
      const list = grouped.get(row.task_id) ?? []
      list.push(mapReminderRow(row))
      grouped.set(row.task_id, list)
    }
    return tasks.map((row) => mapTaskRow(row, grouped.get(row.id) ?? []))
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!row) return null
    const reminders = this.db
      .prepare('SELECT * FROM task_reminders WHERE task_id = ? ORDER BY offset_minutes DESC')
      .all(id) as unknown as ReminderRow[]
    return mapTaskRow(row, reminders.map(mapReminderRow))
  }

  findTaskByExternalId(source: DataSource, externalId: string): Task | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE source = ? AND external_id = ? LIMIT 1')
      .get(source, externalId) as TaskRow | undefined
    if (!row) return null
    return this.getTask(row.id)
  }

  createTask(
    input: TaskUpsertInput,
    options: {
      source?: DataSource
      externalId?: string | null
      sourceUpdatedAt?: string | null
      completionSource?: TaskCompletionSource | null
      platformStatus?: string | null
      platformStatusKind?: PlatformStatusKind
      submittedAt?: string | null
      score?: string | null
      fullScore?: string | null
      teacherFeedback?: string | null
      attachments?: TaskAttachment[]
      fieldSources?: Partial<Record<TaskField, DataSource>>
      manualFields?: TaskField[]
    } = {}
  ): Task {
    const id = randomUUID()
    const now = new Date().toISOString()
    const status = input.status ?? 'todo'
    const dueAt = new Date(input.dueAt).toISOString()
    const source = options.source ?? 'manual'
    const externalId = options.externalId ?? null
    const completionSource =
      status === 'done'
        ? (options.completionSource ?? (source === 'manual' ? 'local' : 'platform'))
        : null
    const fieldSources = options.fieldSources ?? fieldSourcesFor(source)
    const manualFields = options.manualFields ?? (source === 'manual' ? [...ALL_TASK_FIELDS] : [])
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO tasks
            (id, title, description, course_id, priority, kind, status, due_at, completed_at,
             completion_source, source, external_id, source_updated_at, source_url, platform_status,
             platform_status_kind, submitted_at, score, full_score, teacher_feedback,
             attachments_json, manual_fields_json, field_sources_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          id,
          input.title.trim(),
          input.description.trim(),
          input.courseId,
          input.priority,
          input.kind,
          status,
          dueAt,
          status === 'done' ? now : null,
          completionSource,
          source,
          externalId,
          options.sourceUpdatedAt ?? (source === 'import' ? now : null),
          input.sourceUrl ?? null,
          options.platformStatus ?? null,
          options.platformStatusKind ?? 'unknown',
          options.submittedAt ?? null,
          options.score ?? null,
          options.fullScore ?? null,
          options.teacherFeedback ?? null,
          JSON.stringify(options.attachments ?? []),
          JSON.stringify(manualFields),
          JSON.stringify(fieldSources),
          now,
          now
        )
      this.syncReminderRules(id, input.reminderOffsets, now)
      this.recordTaskChange(id, source, source === 'import' ? '导入任务' : '创建任务', [
        { field: 'title', from: null, to: input.title.trim() },
        { field: 'dueAt', from: null, to: dueAt }
      ])
    })
    const task = this.getTask(id)
    if (!task) throw new UserFacingError('TASK_CREATE_FAILED', '任务创建失败')
    return task
  }

  updateTask(id: string, input: TaskUpsertInput): Task {
    const previous = this.getTask(id)
    if (!previous) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    if (
      previous.source === 'chaoxing' &&
      input.status !== undefined &&
      input.status !== previous.status
    ) {
      throw new UserFacingError(
        'TASK_PLATFORM_STATUS_LOCKED',
        '学习通任务的完成状态由平台同步，不能通过本地编辑修改。'
      )
    }
    const now = new Date().toISOString()
    const status = input.status ?? previous.status
    const dueAt = new Date(input.dueAt).toISOString()
    const title = input.title.trim()
    const description = input.description.trim()
    const nextReminders = normalizeReminderOffsets(input.reminderOffsets).join(',')
    const previousReminders = previous.reminders
      .map((rule) => rule.offsetMinutes)
      .sort((a, b) => a - b)
      .join(',')
    const changes: Array<{ field: TaskField; from: string | null; to: string | null }> = []
    if (previous.title !== title) changes.push({ field: 'title', from: previous.title, to: title })
    if (previous.description !== description) {
      changes.push({ field: 'description', from: previous.description, to: description })
    }
    if (previous.courseId !== input.courseId) {
      changes.push({ field: 'courseId', from: previous.courseId, to: input.courseId })
    }
    if (previous.priority !== input.priority) {
      changes.push({ field: 'priority', from: previous.priority, to: input.priority })
    }
    if (previous.kind !== input.kind) {
      changes.push({ field: 'kind', from: previous.kind, to: input.kind })
    }
    if (previous.dueAt !== dueAt) {
      changes.push({ field: 'dueAt', from: previous.dueAt, to: dueAt })
    }
    if (previous.status !== status) {
      changes.push({ field: 'status', from: previous.status, to: status })
    }
    if (previousReminders !== nextReminders) {
      changes.push({
        field: 'reminders',
        from: previousReminders || null,
        to: nextReminders || null
      })
    }
    const manualFields = mergeTaskFields(
      previous.manualFields,
      changes.map((change) => change.field)
    )
    const fieldSources = { ...previous.fieldSources }
    for (const change of changes) fieldSources[change.field] = 'manual'
    const completionSource =
      status === 'done' ? (previous.status === 'done' ? previous.completionSource : 'local') : null
    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE tasks SET
            title = ?, description = ?, course_id = ?, priority = ?, kind = ?, status = ?,
            due_at = ?, completed_at = ?, completion_source = ?, manual_fields_json = ?,
            field_sources_json = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .run(
          title,
          description,
          input.courseId,
          input.priority,
          input.kind,
          status,
          dueAt,
          status === 'done' ? (previous.completedAt ?? now) : null,
          completionSource,
          JSON.stringify(manualFields),
          JSON.stringify(fieldSources),
          now,
          id
        )
      if (previous.dueAt !== dueAt) {
        this.db.prepare('DELETE FROM notification_deliveries WHERE task_id = ?').run(id)
      }
      this.syncReminderRules(id, input.reminderOffsets, now)
      // A retry row is only valid for the task's current deadline and one of
      // its current reminder rules. Editing either field invalidates it even
      // when the failure was recorded for an older schedule.
      if (status === 'done') {
        this.deleteTaskDeliveryFailures(id)
      } else {
        this.deleteStaleDeliveryFailures(id, dueAt)
      }
      if (changes.length > 0) {
        this.recordTaskChange(id, 'manual', '手动编辑任务', changes)
      }
    })
    const task = this.getTask(id)
    if (!task) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    return task
  }

  upsertImportedTask(
    input: TaskUpsertInput,
    options: {
      externalId: string
      source?: DataSource
      sourceUpdatedAt?: string | null
      platformStatus?: string | null
      platformStatusKind?: PlatformStatusKind
      submittedAt?: string | null
      score?: string | null
      fullScore?: string | null
      teacherFeedback?: string | null
      attachments?: TaskAttachment[]
    }
  ): ImportedTaskUpsertResult {
    const source = options.source ?? 'import'
    const existing = this.findTaskByExternalId(source, options.externalId)
    if (!existing) {
      return {
        task: this.createTask(input, {
          source,
          externalId: options.externalId,
          ...(options.sourceUpdatedAt !== undefined
            ? { sourceUpdatedAt: options.sourceUpdatedAt }
            : {}),
          ...(options.platformStatus !== undefined
            ? { platformStatus: options.platformStatus }
            : {}),
          ...(options.platformStatusKind !== undefined
            ? { platformStatusKind: options.platformStatusKind }
            : {}),
          ...(options.submittedAt !== undefined ? { submittedAt: options.submittedAt } : {}),
          ...(options.score !== undefined ? { score: options.score } : {}),
          ...(options.fullScore !== undefined ? { fullScore: options.fullScore } : {}),
          ...(options.teacherFeedback !== undefined
            ? { teacherFeedback: options.teacherFeedback }
            : {}),
          ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
          fieldSources: fieldSourcesFor(source),
          completionSource: (input.status ?? 'todo') === 'done' ? 'platform' : null
        }),
        action: 'created',
        deadlineChanged: false,
        conflicts: []
      }
    }

    const nextStatus = input.status ?? existing.status
    const nextDueAt = new Date(input.dueAt).toISOString()
    const incoming: Record<TaskField, string> = {
      title: input.title.trim(),
      description: input.description.trim(),
      courseId: input.courseId ?? '',
      priority: input.priority,
      kind: input.kind,
      status: nextStatus,
      dueAt: nextDueAt,
      reminders: normalizeReminderOffsets(input.reminderOffsets).join(',')
    }
    const current = taskFieldValueMap(existing)
    const nextValues = { ...current }
    // Platform-synced tasks own their completion status. Older builds could
    // mark `status` as a manual field after a local toggle; drop that stale
    // protection so the next platform result can repair the local state.
    const manualFields =
      source === 'chaoxing'
        ? existing.manualFields.filter((field) => field !== 'status')
        : existing.manualFields
    const manualFieldsDirty = source === 'chaoxing' && existing.manualFields.includes('status')
    const protectedFields = new Set(manualFields)
    const changes: Array<{ field: TaskField; from: string | null; to: string | null }> = []
    const conflicts: TaskField[] = []
    const fieldSources = { ...existing.fieldSources }
    for (const field of ALL_TASK_FIELDS) {
      if (field === 'reminders') continue
      if (current[field] === incoming[field]) continue
      if (protectedFields.has(field)) {
        conflicts.push(field)
        continue
      }
      nextValues[field] = incoming[field]
      changes.push({ field, from: current[field] || null, to: incoming[field] || null })
      fieldSources[field] = source
    }
    if (source === 'chaoxing') fieldSources.status = 'chaoxing'
    if (changes.length === 0 && !manualFieldsDirty) {
      const platformChanged =
        options.platformStatus !== undefined && options.platformStatus !== existing.platformStatus
      this.db
        .prepare(
          `UPDATE tasks SET source_updated_at = ?, source_url = ?, platform_status = ?,
             platform_status_kind = ?, submitted_at = ?, score = ?, full_score = ?, teacher_feedback = ?,
             attachments_json = ?
           WHERE id = ?`
        )
        .run(
          options.sourceUpdatedAt ?? new Date().toISOString(),
          input.sourceUrl !== undefined ? input.sourceUrl : existing.sourceUrl,
          options.platformStatus !== undefined ? options.platformStatus : existing.platformStatus,
          options.platformStatusKind ?? existing.platformStatusKind,
          options.submittedAt !== undefined ? options.submittedAt : existing.submittedAt,
          options.score !== undefined ? options.score : existing.score,
          options.fullScore !== undefined ? options.fullScore : existing.fullScore,
          options.teacherFeedback !== undefined
            ? options.teacherFeedback
            : existing.teacherFeedback,
          JSON.stringify(options.attachments ?? existing.attachments),
          existing.id
        )
      if (platformChanged) {
        this.recordTaskChange(existing.id, source, '平台状态更新', [])
      }
      return {
        task: this.getTask(existing.id) ?? existing,
        action: 'unchanged',
        deadlineChanged: false,
        conflicts
      }
    }
    const effectiveStatus = nextValues.status as Task['status']
    const effectiveDueAt = new Date(nextValues.dueAt).toISOString()
    const deadlineChanged = changes.some((change) => change.field === 'dueAt')
    const completionSource =
      effectiveStatus === 'done'
        ? source === 'chaoxing'
          ? 'platform'
          : existing.completionSource === 'local'
            ? 'local'
            : 'platform'
        : null
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE tasks SET
            title = ?, description = ?, course_id = ?, priority = ?, kind = ?, status = ?,
            due_at = ?, completed_at = ?, completion_source = ?, source_updated_at = ?,
            source_url = ?, platform_status = ?, platform_status_kind = ?, field_sources_json = ?,
            manual_fields_json = ?, submitted_at = ?, score = ?, full_score = ?,
            teacher_feedback = ?, attachments_json = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .run(
          nextValues.title,
          nextValues.description,
          nextValues.courseId || null,
          nextValues.priority,
          nextValues.kind,
          effectiveStatus,
          effectiveDueAt,
          effectiveStatus === 'done' ? (existing.completedAt ?? now) : null,
          completionSource,
          options.sourceUpdatedAt ?? now,
          input.sourceUrl !== undefined ? input.sourceUrl : existing.sourceUrl,
          options.platformStatus !== undefined ? options.platformStatus : existing.platformStatus,
          options.platformStatusKind ?? existing.platformStatusKind,
          JSON.stringify(fieldSources),
          JSON.stringify(manualFields),
          options.submittedAt !== undefined ? options.submittedAt : existing.submittedAt,
          options.score !== undefined ? options.score : existing.score,
          options.fullScore !== undefined ? options.fullScore : existing.fullScore,
          options.teacherFeedback !== undefined
            ? options.teacherFeedback
            : existing.teacherFeedback,
          JSON.stringify(options.attachments ?? existing.attachments),
          now,
          existing.id
        )
      if (deadlineChanged) {
        this.db.prepare('DELETE FROM notification_deliveries WHERE task_id = ?').run(existing.id)
      }
      // Imported tasks do not rewrite their reminder rules, but a platform
      // deadline change or a completed status still makes an old retry stale.
      if (effectiveStatus === 'done') {
        this.deleteTaskDeliveryFailures(existing.id)
      } else if (deadlineChanged) {
        this.deleteStaleDeliveryFailures(existing.id, effectiveDueAt)
      }
      this.recordTaskChange(
        existing.id,
        source,
        conflicts.length > 0 ? '快照更新任务（保留手动字段）' : '快照更新任务',
        changes
      )
    })
    const task = this.getTask(existing.id)
    if (!task) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    return { task, action: 'updated', deadlineChanged, conflicts }
  }

  listTaskHistory(taskId: string): TaskChange[] {
    const rows = this.db
      .prepare('SELECT * FROM task_change_log WHERE task_id = ? ORDER BY changed_at DESC')
      .all(taskId) as unknown as TaskChangeRow[]
    return rows.map(mapTaskChangeRow)
  }

  setTaskCompleted(id: string, completed: boolean): Task {
    const previous = this.getTask(id)
    if (!previous) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    if (previous.source === 'chaoxing') {
      throw new UserFacingError(
        'TASK_PLATFORM_STATUS_LOCKED',
        '学习通任务的完成状态由平台同步，不能在本地勾选或取消。'
      )
    }
    if ((previous.status === 'done') === completed) return previous
    const now = new Date().toISOString()
    const manualFields = mergeTaskFields(previous.manualFields, ['status'])
    const fieldSources = { ...previous.fieldSources, status: 'manual' as const }
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET status = ?, completed_at = ?, completion_source = ?,
             manual_fields_json = ?, field_sources_json = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          completed ? 'done' : 'todo',
          completed ? now : null,
          completed ? 'local' : null,
          JSON.stringify(manualFields),
          JSON.stringify(fieldSources),
          now,
          id
        )
      // A completed task must not keep a retry alive. Reopening starts a fresh
      // reminder lifecycle from the task's current deadline and rules.
      if (completed) this.deleteTaskDeliveryFailures(id)
      this.recordTaskChange(id, 'manual', completed ? '标记为本地完成' : '取消完成', [
        { field: 'status', from: previous.status, to: completed ? 'done' : 'todo' }
      ])
    })
    const task = this.getTask(id)
    if (!task) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    return task
  }

  deleteTask(id: string): void {
    const previous = this.getTask(id)
    if (!previous) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    if (previous.source === 'chaoxing') {
      throw new UserFacingError(
        'TASK_PLATFORM_DELETE_LOCKED',
        '学习通任务由平台同步生成，不能通过本地删除。'
      )
    }
    // Explicit cleanup keeps the failure queue correct even before the
    // foreign-key cascade runs, and never touches another task's rows.
    this.transaction(() => {
      this.deleteTaskDeliveryFailures(id)
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    })
  }

  private deleteTaskDeliveryFailures(taskId: string): void {
    this.db.prepare('DELETE FROM notification_delivery_failures WHERE task_id = ?').run(taskId)
  }

  private deleteStaleDeliveryFailures(taskId: string, dueAt: string): void {
    this.db
      .prepare(
        `
        DELETE FROM notification_delivery_failures
        WHERE task_id = ?
          AND (
            due_at <> ?
            OR rule_id NOT IN (SELECT id FROM task_reminders WHERE task_id = ?)
          )
      `
      )
      .run(taskId, dueAt, taskId)
  }

  private recordTaskChange(
    taskId: string,
    origin: DataSource | 'system',
    summary: string,
    changes: Array<{ field: TaskField; from: string | null; to: string | null }>
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_change_log(id, task_id, changed_at, origin, summary, changes_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), taskId, new Date().toISOString(), origin, summary, JSON.stringify(changes))
  }

  private syncReminderRules(taskId: string, offsets: number[], now: string): void {
    const normalized = normalizeReminderOffsets(offsets).filter(
      (value) => value <= REMINDER_MAX_MINUTES
    )
    const existing = this.db
      .prepare('SELECT id, offset_minutes FROM task_reminders WHERE task_id = ?')
      .all(taskId) as unknown as Array<{ id: string; offset_minutes: number }>
    const existingByOffset = new Map(existing.map((row) => [row.offset_minutes, row.id]))
    const wanted = new Set(normalized)
    for (const row of existing) {
      if (!wanted.has(row.offset_minutes)) {
        this.db.prepare('DELETE FROM task_reminders WHERE id = ?').run(row.id)
      }
    }
    const insert = this.db.prepare(`
      INSERT INTO task_reminders(id, task_id, offset_minutes, enabled, created_at)
      VALUES (?, ?, ?, 1, ?)
    `)
    for (const offset of normalized) {
      if (!existingByOffset.has(offset)) {
        insert.run(randomUUID(), taskId, offset, now)
      }
    }
  }

  claimDelivery(input: {
    taskId: string
    ruleId: string
    dueAt: string
    scheduledFor: string
  }): string | null {
    const key = `${input.taskId}:${input.ruleId}:${input.dueAt}`
    const result = this.db
      .prepare(
        `
        INSERT OR IGNORE INTO notification_deliveries
          (dedupe_key, task_id, rule_id, due_at, scheduled_for, delivered_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        key,
        input.taskId,
        input.ruleId,
        input.dueAt,
        input.scheduledFor,
        new Date().toISOString()
      )
    return Number(result.changes) === 1 ? key : null
  }

  releaseDelivery(key: string): void {
    this.db.prepare('DELETE FROM notification_deliveries WHERE dedupe_key = ?').run(key)
  }

  /**
   * Persist a failed delivery attempt separately from the delivery claim. The
   * claim is released so a retry can be claimed again; this row keeps the
   * failure and its bounded backoff across process exits.
   */
  recordDeliveryFailure(input: {
    dedupeKey: string
    taskId: string
    ruleId: string
    dueAt: string
    scheduledFor: string
    error: string
    at: string
    nextRetryAt: string | null
  }): number {
    const existing = this.db
      .prepare('SELECT attempt_count FROM notification_delivery_failures WHERE dedupe_key = ?')
      .get(input.dedupeKey) as { attempt_count: number } | undefined
    const attemptCount = (existing?.attempt_count ?? 0) + 1
    this.db
      .prepare(
        `
        INSERT INTO notification_delivery_failures
          (dedupe_key, task_id, rule_id, due_at, scheduled_for, attempt_count,
           last_error, last_attempt_at, next_retry_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          task_id = excluded.task_id,
          rule_id = excluded.rule_id,
          due_at = excluded.due_at,
          scheduled_for = excluded.scheduled_for,
          attempt_count = excluded.attempt_count,
          last_error = excluded.last_error,
          last_attempt_at = excluded.last_attempt_at,
          next_retry_at = excluded.next_retry_at
      `
      )
      .run(
        input.dedupeKey,
        input.taskId,
        input.ruleId,
        input.dueAt,
        input.scheduledFor,
        attemptCount,
        input.error,
        input.at,
        input.nextRetryAt
      )
    return attemptCount
  }

  getDeliveryFailure(dedupeKey: string): NotificationDeliveryFailure | null {
    const row = this.db
      .prepare('SELECT * FROM notification_delivery_failures WHERE dedupe_key = ?')
      .get(dedupeKey) as DeliveryFailureRow | undefined
    return row ? mapDeliveryFailure(row) : null
  }

  listDueDeliveryFailures(nowIso: string, limit = 50): NotificationDeliveryFailure[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM notification_delivery_failures
        WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?
        ORDER BY next_retry_at ASC
        LIMIT ?
      `
      )
      .all(nowIso, limit) as unknown as DeliveryFailureRow[]
    return rows.map(mapDeliveryFailure)
  }

  nextDeliveryRetryAt(): string | null {
    const row = this.db
      .prepare(
        'SELECT MIN(next_retry_at) AS next_retry_at FROM notification_delivery_failures WHERE next_retry_at IS NOT NULL'
      )
      .get() as { next_retry_at: string | null } | undefined
    return row?.next_retry_at ?? null
  }

  latestDeliveryError(): string | null {
    const row = this.db
      .prepare(
        'SELECT last_error FROM notification_delivery_failures ORDER BY last_attempt_at DESC LIMIT 1'
      )
      .get() as { last_error: string } | undefined
    return row?.last_error ?? null
  }

  markDeliveryFailureExhausted(dedupeKey: string): void {
    this.db
      .prepare(
        'UPDATE notification_delivery_failures SET next_retry_at = NULL WHERE dedupe_key = ?'
      )
      .run(dedupeKey)
  }

  clearDeliveryFailure(dedupeKey: string): void {
    this.db
      .prepare('DELETE FROM notification_delivery_failures WHERE dedupe_key = ?')
      .run(dedupeKey)
  }

  hasDelivery(taskId: string, ruleId: string, dueAt: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 AS found FROM notification_deliveries WHERE task_id = ? AND rule_id = ? AND due_at = ?'
      )
      .get(taskId, ruleId, dueAt)
    return Boolean(row)
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as Array<{
      key: string
      value: string
    }>
    const raw = new Map(rows.map((row) => [row.key, row.value]))
    const read = <K extends keyof AppSettings>(key: K): AppSettings[K] => {
      const value = raw.get(key)
      if (value === undefined) return DEFAULT_SETTINGS[key]
      try {
        return JSON.parse(value) as AppSettings[K]
      } catch {
        return DEFAULT_SETTINGS[key]
      }
    }
    const rawZoom = read('uiZoom')
    const uiZoom =
      typeof rawZoom === 'number' && Number.isFinite(rawZoom)
        ? Math.min(1.35, Math.max(0.75, Math.round(rawZoom * 100) / 100))
        : DEFAULT_SETTINGS.uiZoom
    return {
      theme: read('theme'),
      closeToTray: read('closeToTray'),
      launchAtLogin: read('launchAtLogin'),
      notificationsEnabled: read('notificationsEnabled'),
      defaultReminderOffsets: read('defaultReminderOffsets'),
      calendarWeekStartsOn: read('calendarWeekStartsOn'),
      catchUpMissedReminders: read('catchUpMissedReminders'),
      trustedSsoDomains: read('trustedSsoDomains'),
      downloadDirectory: read('downloadDirectory'),
      autoRefreshMinutes: read('autoRefreshMinutes'),
      uiZoom
    }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const statement = this.db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS)) continue
        statement.run(key, JSON.stringify(value))
      }
    })
    return this.getSettings()
  }

  listOfficialEntries(includeDisabled = true): OfficialEntry[] {
    const where = includeDisabled ? '' : 'WHERE enabled = 1'
    const rows = this.db
      .prepare(`SELECT * FROM official_entries ${where} ORDER BY sort_order ASC, label ASC`)
      .all() as unknown as EntryRow[]
    return rows.map(mapEntryRow)
  }

  getOfficialEntry(id: string): OfficialEntry | null {
    const row = this.db.prepare('SELECT * FROM official_entries WHERE id = ?').get(id) as
      | EntryRow
      | undefined
    return row ? mapEntryRow(row) : null
  }

  createOfficialEntry(input: OfficialEntryInput & { sortOrder?: number }): OfficialEntry {
    const id = randomUUID()
    const maxRow = this.db
      .prepare('SELECT COALESCE(MAX(sort_order), 100) AS max_order FROM official_entries')
      .get() as { max_order: number }
    this.db
      .prepare(
        `
        INSERT INTO official_entries
          (id, label, description, url, kind, enabled, sort_order, is_builtin)
        VALUES (?, ?, ?, ?, ?, 1, ?, 0)
      `
      )
      .run(
        id,
        input.label.trim(),
        input.description.trim(),
        input.url,
        input.kind,
        input.sortOrder ?? maxRow.max_order + 10
      )
    const entry = this.getOfficialEntry(id)
    if (!entry) throw new UserFacingError('ENTRY_CREATE_FAILED', '入口创建失败')
    return entry
  }

  setOfficialEntryEnabled(id: string, enabled: boolean): OfficialEntry {
    const result = this.db
      .prepare('UPDATE official_entries SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id)
    if (Number(result.changes) === 0) {
      throw new UserFacingError('ENTRY_NOT_FOUND', '入口不存在')
    }
    const entry = this.getOfficialEntry(id)
    if (!entry) throw new UserFacingError('ENTRY_NOT_FOUND', '入口不存在')
    return entry
  }

  deleteOfficialEntry(id: string): void {
    const result = this.db
      .prepare('DELETE FROM official_entries WHERE id = ? AND is_builtin = 0')
      .run(id)
    if (Number(result.changes) === 0) {
      throw new UserFacingError('ENTRY_NOT_FOUND', '内置入口不可删除或入口不存在')
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    // A read-only historical workspace may still record transient session
    // metadata in memory, but must never alter the archived database.
    if (this.readOnly) return
    this.db
      .prepare(
        `
        INSERT INTO app_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `
      )
      .run(key, value)
  }

  private setMetaIfMissing(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO app_meta(key, value) VALUES (?, ?)').run(key, value)
  }

  /**
   * Runs work inside one SQLite transaction. Existing DAO methods call this
   * recursively; nested calls use SAVEPOINTs so a higher-level sync commit can
   * atomically include all writes and still roll back the whole batch.
   */
  runInTransaction<T>(work: () => T): T {
    const depth = this.transactionDepth
    const nested = depth > 0
    const savepoint = `studynext_sp_${depth + 1}`
    if (nested) {
      this.db.exec(`SAVEPOINT ${savepoint}`)
    } else {
      this.db.exec('BEGIN IMMEDIATE')
    }
    this.transactionDepth = depth + 1
    try {
      const result = work()
      if (nested) {
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      } else {
        this.db.exec('COMMIT')
      }
      return result
    } catch (error) {
      if (nested) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      } else {
        this.db.exec('ROLLBACK')
      }
      throw error
    } finally {
      this.transactionDepth = depth
    }
  }

  private transaction<T>(work: () => T): T {
    return this.runInTransaction(work)
  }
}

function mapCourseRow(row: CourseRow): Course {
  let schedule: CourseSession[] = []
  try {
    const parsed: unknown = JSON.parse(row.schedule_json)
    if (Array.isArray(parsed)) schedule = parsed as CourseSession[]
  } catch {
    schedule = []
  }
  return {
    id: row.id,
    externalId: row.external_id,
    name: row.name,
    code: row.code,
    teacher: row.teacher,
    semester: row.semester,
    category: row.category,
    color: row.color,
    favorite: row.favorite === 1,
    clazzId: row.clazz_id,
    className: row.class_name,
    schedule,
    semesterStart: row.semester_start,
    maxWeek: row.max_week,
    source: row.source as DataSource,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapExamRow(row: ExamRow): Exam {
  return {
    id: row.id,
    externalId: row.external_id,
    title: row.title,
    courseName: row.course_name,
    startAt: row.start_at,
    endAt: row.end_at,
    durationMinutes: row.duration_minutes,
    examStatus: row.exam_status,
    answerStatus: row.answer_status,
    score: row.score,
    mode: row.mode,
    sourceUrl: row.source_url,
    source: row.source as DataSource,
    updatedAt: row.updated_at
  }
}

function mapMaterialRow(row: MaterialRow): Material {
  return {
    id: row.id,
    courseId: row.course_id,
    externalId: row.external_id,
    name: row.name,
    kind: row.kind === 'folder' || row.kind === 'link' ? row.kind : 'file',
    fileType: row.file_type,
    size: row.size,
    url: row.url,
    sourceUrl: row.source_url,
    source: row.source as DataSource,
    updatedAt: row.updated_at
  }
}

const ALL_TASK_FIELDS: TaskField[] = [
  'title',
  'description',
  'courseId',
  'priority',
  'kind',
  'status',
  'dueAt',
  'reminders'
]

const DATA_SOURCES: DataSource[] = ['demo', 'manual', 'import', 'chaoxing']

function fieldSourcesFor(source: DataSource): Partial<Record<TaskField, DataSource>> {
  return Object.fromEntries(ALL_TASK_FIELDS.map((field) => [field, source])) as Partial<
    Record<TaskField, DataSource>
  >
}

function parseTaskFields(value: string): TaskField[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is TaskField => ALL_TASK_FIELDS.includes(item as TaskField))
  } catch {
    return []
  }
}

function parseTaskAttachments(value: string): TaskAttachment[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        name: typeof item.name === 'string' ? item.name : '',
        size: typeof item.size === 'string' ? item.size : null,
        objectId: typeof item.objectId === 'string' ? item.objectId : null
      }))
      .filter((item) => item.name.length > 0)
  } catch {
    return []
  }
}

function parseTaskFieldSources(value: string): Partial<Record<TaskField, DataSource>> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const result: Partial<Record<TaskField, DataSource>> = {}
    for (const [key, source] of Object.entries(parsed)) {
      if (
        ALL_TASK_FIELDS.includes(key as TaskField) &&
        DATA_SOURCES.includes(source as DataSource)
      ) {
        result[key as TaskField] = source as DataSource
      }
    }
    return result
  } catch {
    return {}
  }
}

function mergeTaskFields(current: TaskField[], next: TaskField[]): TaskField[] {
  return [...new Set([...current, ...next])]
}

function taskFieldValueMap(task: Task): Record<TaskField, string> {
  return {
    title: task.title,
    description: task.description,
    courseId: task.courseId ?? '',
    priority: task.priority,
    kind: task.kind,
    status: task.status,
    dueAt: task.dueAt,
    reminders: task.reminders
      .map((rule) => rule.offsetMinutes)
      .sort((a, b) => a - b)
      .join(',')
  }
}

function mapTaskRow(row: TaskRow, reminders: ReminderRule[]): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    courseId: row.course_id,
    priority: row.priority as Task['priority'],
    kind: row.kind as Task['kind'],
    status: row.status as Task['status'],
    dueAt: row.due_at,
    completedAt: row.completed_at,
    completionSource: (row.completion_source as TaskCompletionSource | null) ?? null,
    source: row.source as DataSource,
    externalId: row.external_id,
    sourceUpdatedAt: row.source_updated_at,
    sourceUrl: row.source_url ?? null,
    platformStatus: row.platform_status ?? null,
    platformStatusKind: (row.platform_status_kind as PlatformStatusKind) ?? 'unknown',
    submittedAt: row.submitted_at ?? null,
    score: row.score ?? null,
    fullScore: row.full_score ?? null,
    teacherFeedback: row.teacher_feedback ?? null,
    attachments: parseTaskAttachments(row.attachments_json),
    manualFields: parseTaskFields(row.manual_fields_json),
    fieldSources: parseTaskFieldSources(row.field_sources_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reminders
  }
}

function mapTaskChangeRow(row: TaskChangeRow): TaskChange {
  let changes: TaskChange['changes'] = []
  try {
    const parsed: unknown = JSON.parse(row.changes_json)
    if (Array.isArray(parsed)) {
      changes = parsed.filter(
        (item): item is TaskChange['changes'][number] =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { field?: unknown }).field === 'string'
      )
    }
  } catch {
    changes = []
  }
  return {
    id: row.id,
    taskId: row.task_id,
    changedAt: row.changed_at,
    origin: row.origin as TaskChange['origin'],
    summary: row.summary,
    changes
  }
}

function mapReminderRow(row: ReminderRow): ReminderRule {
  return {
    id: row.id,
    taskId: row.task_id,
    offsetMinutes: row.offset_minutes,
    enabled: row.enabled === 1,
    createdAt: row.created_at
  }
}

function mapEntryRow(row: EntryRow): OfficialEntry {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    url: row.url,
    kind: row.kind as OfficialEntry['kind'],
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    isBuiltin: row.is_builtin === 1
  }
}

function mapChapterRow(row: ChapterRow): Chapter {
  return {
    id: row.id,
    courseId: row.course_id,
    externalId: row.external_id,
    title: row.title,
    sortOrder: row.sort_order,
    progress: row.progress,
    lastStudiedAt: row.last_studied_at,
    sourceUrl: row.source_url ?? null,
    sections: parseChapterSections(row.sections_json),
    source: row.source as DataSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function parseChapterSections(value: string | null | undefined): ChapterSection[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        number: typeof item.number === 'string' ? item.number : '',
        title: typeof item.title === 'string' ? item.title : '',
        completed: item.completed === true,
        pendingCount: typeof item.pendingCount === 'number' ? item.pendingCount : 0,
        locked: item.locked === true,
        chapterId: typeof item.chapterId === 'string' ? item.chapterId : null,
        sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : null,
        resources: Array.isArray(item.resources)
          ? item.resources
              .filter(
                (resource): resource is Record<string, unknown> =>
                  Boolean(resource) && typeof resource === 'object'
              )
              .map((resource) => ({
                name: typeof resource.name === 'string' ? resource.name : '',
                size: typeof resource.size === 'string' ? resource.size : null,
                type: typeof resource.type === 'string' ? resource.type : null,
                url: typeof resource.url === 'string' ? resource.url : null,
                objectId: typeof resource.objectId === 'string' ? resource.objectId : null
              }))
              .filter((resource) => resource.name.length > 0)
          : []
      }))
      .filter((item) => item.title.length > 0)
  } catch {
    return []
  }
}

function mapStudyPointRow(row: StudyPointRow): StudyPoint {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    courseId: row.course_id,
    externalId: row.external_id,
    title: row.title,
    kind: row.kind as StudyPointKind,
    status: row.status as StudyPoint['status'],
    durationMinutes: row.duration_minutes,
    sortOrder: row.sort_order,
    source: row.source as DataSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function currentSemesterLabel(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  return month >= 8 ? `${year}-${year + 1} 秋季学期` : `${year - 1}-${year} 春季学期`
}
