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
import type {
  AppSettings,
  Chapter,
  Course,
  CourseSession,
  DataSource,
  OfficialEntry,
  OfficialEntryInput,
  QuestionCard,
  QuestionInput,
  QuestionSource,
  ReminderRule,
  StudyPoint,
  StudyPointKind,
  Task,
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
  schedule_json: string
  source: string
  source_url: string | null
  created_at: string
  updated_at: string
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
  source: string
  external_id: string | null
  created_at: string
  updated_at: string
}

interface ReminderRow {
  id: string
  task_id: string
  offset_minutes: number
  enabled: number
  created_at: string
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

interface QuestionRow {
  id: string
  question: string
  answer: string
  explanation: string
  course_id: string | null
  tags_json: string
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
  schedule_json TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai', 'import')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at DESC);

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
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external
  ON tasks(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_at);

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

export class StudyNextStore {
  readonly db: DatabaseSync

  constructor(readonly filePath: string) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true })
    }
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
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
    this.db.exec(`
      DROP INDEX IF EXISTS idx_chapters_external;
      DROP INDEX IF EXISTS idx_points_external;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_external
        ON courses(source, external_id) WHERE external_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_chapters_external
        ON course_chapters(course_id, source, external_id) WHERE external_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_points_external
        ON study_points(course_id, source, external_id) WHERE external_id IS NOT NULL;
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
    this.setMetaIfMissing('schema_version', '2')
    if (this.getMeta('schema_version') === '1') this.setMeta('schema_version', '2')
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

  getCourse(id: string): Course | null {
    const row = this.db.prepare('SELECT * FROM courses WHERE id = ?').get(id) as
      | CourseRow
      | undefined
    return row ? mapCourseRow(row) : null
  }

  findCourseByName(name: string): Course | null {
    const row = this.db
      .prepare('SELECT * FROM courses WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(name.trim()) as CourseRow | undefined
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

  createImportedCourse(name: string): Course {
    const existing = this.findCourseByName(name)
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

  upsertSnapshotCourse(input: {
    externalId: string
    name: string
    code: string
    teacher: string
    category: string
    sourceUrl: string | null
    schedule: CourseSession[]
  }): { course: Course; created: boolean } {
    const existing =
      this.findCourseByExternalId('import', input.externalId) ??
      this.findCourseByExternalId('chaoxing', input.externalId) ??
      this.findCourseByName(input.name)
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

  upsertSnapshotChapter(input: {
    courseId: string
    externalId: string
    title: string
    sortOrder: number
    progress: number
  }): { chapter: Chapter; created: boolean } {
    const now = new Date().toISOString()
    const existing = this.db
      .prepare(
        "SELECT * FROM course_chapters WHERE course_id = ? AND source = 'import' AND external_id = ? LIMIT 1"
      )
      .get(input.courseId, input.externalId) as ChapterRow | undefined
    if (existing) {
      this.db
        .prepare(
          `
          UPDATE course_chapters SET course_id = ?, title = ?, sort_order = ?, progress = ?,
            updated_at = ? WHERE id = ?
        `
        )
        .run(
          input.courseId,
          input.title.trim(),
          input.sortOrder,
          clampProgress(input.progress),
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
           source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 'import', ?, ?)
      `
      )
      .run(
        id,
        input.courseId,
        input.externalId,
        input.title.trim(),
        input.sortOrder,
        clampProgress(input.progress),
        now,
        now
      )
    const chapter = this.getChapter(id)
    if (!chapter) throw new UserFacingError('CHAPTER_CREATE_FAILED', '章节创建失败')
    return { chapter, created: true }
  }

  upsertSnapshotPoint(input: {
    chapterId: string
    courseId: string
    externalId: string
    title: string
    kind: StudyPointKind
    completed: boolean
    durationMinutes: number | null
    sortOrder: number
  }): { point: StudyPoint; created: boolean } {
    const now = new Date().toISOString()
    const status = input.completed ? 'done' : 'todo'
    const existing = this.db
      .prepare(
        "SELECT * FROM study_points WHERE course_id = ? AND source = 'import' AND external_id = ? LIMIT 1"
      )
      .get(input.courseId, input.externalId) as StudyPointRow | undefined
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)
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
        now,
        now
      )
    const point = this.getStudyPoint(id)
    if (!point) throw new UserFacingError('POINT_CREATE_FAILED', '学习点创建失败')
    return { point, created: true }
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

  listQuestions(): QuestionCard[] {
    const rows = this.db
      .prepare('SELECT * FROM questions ORDER BY updated_at DESC, created_at DESC')
      .all() as unknown as QuestionRow[]
    return rows.map(mapQuestionRow)
  }

  createQuestion(input: QuestionInput, source: QuestionSource = 'manual'): QuestionCard {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        `
        INSERT INTO questions
          (id, question, answer, explanation, course_id, tags_json, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.question.trim(),
        input.answer.trim(),
        input.explanation.trim(),
        input.courseId,
        JSON.stringify(input.tags),
        source,
        now,
        now
      )
    const question = this.getQuestion(id)
    if (!question) throw new UserFacingError('QUESTION_CREATE_FAILED', '题目保存失败')
    return question
  }

  getQuestion(id: string): QuestionCard | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | QuestionRow
      | undefined
    return row ? mapQuestionRow(row) : null
  }

  updateQuestion(id: string, input: QuestionInput): QuestionCard {
    const existing = this.getQuestion(id)
    if (!existing) throw new UserFacingError('QUESTION_NOT_FOUND', '题目不存在')
    this.db
      .prepare(
        `
        UPDATE questions SET question = ?, answer = ?, explanation = ?, course_id = ?,
          tags_json = ?, updated_at = ? WHERE id = ?
      `
      )
      .run(
        input.question.trim(),
        input.answer.trim(),
        input.explanation.trim(),
        input.courseId,
        JSON.stringify(input.tags),
        new Date().toISOString(),
        id
      )
    const question = this.getQuestion(id)
    if (!question) throw new UserFacingError('QUESTION_NOT_FOUND', '题目不存在')
    return question
  }

  deleteQuestion(id: string): void {
    const result = this.db.prepare('DELETE FROM questions WHERE id = ?').run(id)
    if (Number(result.changes) === 0) {
      throw new UserFacingError('QUESTION_NOT_FOUND', '题目不存在')
    }
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
    options: { source?: DataSource; externalId?: string | null } = {}
  ): Task {
    const id = randomUUID()
    const now = new Date().toISOString()
    const status = input.status ?? 'todo'
    const dueAt = new Date(input.dueAt).toISOString()
    const source = options.source ?? 'manual'
    const externalId = options.externalId ?? null
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO tasks
            (id, title, description, course_id, priority, kind, status, due_at, completed_at,
             source, external_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          source,
          externalId,
          now,
          now
        )
      this.syncReminderRules(id, input.reminderOffsets, now)
    })
    const task = this.getTask(id)
    if (!task) throw new UserFacingError('TASK_CREATE_FAILED', '任务创建失败')
    return task
  }

  updateTask(id: string, input: TaskUpsertInput): Task {
    const previous = this.getTask(id)
    if (!previous) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    const now = new Date().toISOString()
    const status = input.status ?? previous.status
    const dueAt = new Date(input.dueAt).toISOString()
    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE tasks SET
            title = ?, description = ?, course_id = ?, priority = ?, kind = ?, status = ?,
            due_at = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .run(
          input.title.trim(),
          input.description.trim(),
          input.courseId,
          input.priority,
          input.kind,
          status,
          dueAt,
          status === 'done' ? (previous.completedAt ?? now) : null,
          now,
          id
        )
      if (previous.dueAt !== dueAt) {
        this.db.prepare('DELETE FROM notification_deliveries WHERE task_id = ?').run(id)
      }
      this.syncReminderRules(id, input.reminderOffsets, now)
    })
    const task = this.getTask(id)
    if (!task) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    return task
  }

  setTaskCompleted(id: string, completed: boolean): Task {
    const previous = this.getTask(id)
    if (!previous) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(completed ? 'done' : 'todo', completed ? now : null, now, id)
    const task = this.getTask(id)
    if (!task) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    return task
  }

  deleteTask(id: string): void {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    if (Number(result.changes) === 0) {
      throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
    }
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
    return {
      theme: read('theme'),
      closeToTray: read('closeToTray'),
      launchAtLogin: read('launchAtLogin'),
      notificationsEnabled: read('notificationsEnabled'),
      defaultReminderOffsets: read('defaultReminderOffsets'),
      calendarWeekStartsOn: read('calendarWeekStartsOn'),
      catchUpMissedReminders: read('catchUpMissedReminders')
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

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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
    schedule,
    source: row.source as DataSource,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
    source: row.source as DataSource,
    externalId: row.external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reminders
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
    source: row.source as DataSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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

function mapQuestionRow(row: QuestionRow): QuestionCard {
  let tags: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.tags_json)
    if (Array.isArray(parsed))
      tags = parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    tags = []
  }
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    explanation: row.explanation,
    courseId: row.course_id,
    tags,
    source: row.source as QuestionSource,
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
