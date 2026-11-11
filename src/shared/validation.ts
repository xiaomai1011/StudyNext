import { z } from 'zod'

const isoTimestamp = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), '时间格式无效')

const taskTitle = z.string().trim().min(1, '请输入任务标题').max(120, '任务标题不能超过 120 字')
const description = z.string().max(4000, '任务描述不能超过 4000 字').default('')
const courseId = z.string().uuid().nullable()
const reminderOffsets = z
  .array(
    z
      .number()
      .int()
      .min(5)
      .max(60 * 24 * 30)
  )
  .max(12, '每个任务最多设置 12 条提醒')
  .default([])

export const taskUpsertSchema = z
  .object({
    title: taskTitle,
    description,
    courseId,
    priority: z.enum(['high', 'medium', 'low']),
    kind: z.enum(['homework', 'exam', 'reading', 'activity', 'other']),
    dueAt: isoTimestamp,
    reminderOffsets,
    status: z.enum(['todo', 'done']).optional()
  })
  .strict()

export const taskIdSchema = z.string().uuid()

export const settingsPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    closeToTray: z.boolean().optional(),
    launchAtLogin: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    defaultReminderOffsets: z.array(z.number().int().min(5).max(43200)).max(12).optional(),
    calendarWeekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
    catchUpMissedReminders: z.boolean().optional()
  })
  .strict()

export const favoriteSchema = z.object({ id: z.string().uuid(), favorite: z.boolean() }).strict()

export const importPayloadSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    content: z
      .string()
      .min(1, '文件为空')
      .max(2 * 1024 * 1024, '导入文件不能超过 2 MB')
  })
  .strict()

export const studyPointStatusSchema = z
  .object({ id: z.string().uuid(), completed: z.boolean() })
  .strict()

export const questionInputSchema = z
  .object({
    question: z.string().trim().min(1, '请输入题目').max(4000, '题目不能超过 4000 字'),
    answer: z.string().trim().max(8000, '答案不能超过 8000 字'),
    explanation: z.string().trim().max(8000, '解析不能超过 8000 字'),
    courseId: z.string().uuid().nullable(),
    tags: z.array(z.string().trim().min(1).max(24)).max(10, '最多添加 10 个标签').default([])
  })
  .strict()

export const questionSourceSchema = z.enum(['manual', 'ai', 'import']).default('manual')

export const aiConfigInputSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().trim().min(1, '请输入 API 地址').max(2048),
    model: z.string().trim().min(1, '请输入模型名称').max(120),
    apiKey: z.string().trim().max(512).optional(),
    clearApiKey: z.boolean().optional()
  })
  .strict()

export const aiAskInputSchema = z
  .object({
    question: z.string().trim().min(2, '请输入至少 2 个字的题目').max(6000, '题目不能超过 6000 字'),
    courseId: z.string().uuid().nullable()
  })
  .strict()

export const entryInputSchema = z
  .object({
    label: z.string().trim().min(1, '请输入入口名称').max(40),
    description: z.string().trim().max(120).default(''),
    url: z.string().trim().url('请输入有效 URL').max(2048),
    kind: z.enum(['home', 'course', 'task', 'exam', 'notice', 'calendar', 'custom'])
  })
  .strict()

export type ParsedTaskUpsert = z.infer<typeof taskUpsertSchema>
