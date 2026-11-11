import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importTasksFromFile,
  parseCsvTasks,
  parseIcsTasks
} from '../../src/main/integrations/import'
import { StudyNextStore } from '../../src/main/storage/store'

let store: StudyNextStore

beforeEach(() => {
  store = new StudyNextStore(':memory:')
})

afterEach(() => {
  store.close()
})

describe('CSV / ICS 手动导入', () => {
  it('解析 CSV 的中英文字段、优先级、类型与提醒时长', () => {
    const result = parseCsvTasks(
      '\uFEFF标题,截止时间,所属课程,优先级,类型,提醒,描述\n"第三章 作业",2026-12-01 22:00,数据结构,高,作业,"1d;3h;30m","包含,逗号"\n',
      [1440]
    )
    expect(result.fatal).toBeUndefined()
    expect(result.tasks).toHaveLength(1)
    const task = result.tasks[0]!
    expect(task.title).toBe('第三章 作业')
    expect(task.courseName).toBe('数据结构')
    expect(task.priority).toBe('high')
    expect(task.kind).toBe('homework')
    expect(task.description).toBe('包含,逗号')
    expect(task.reminderOffsets).toEqual([1440, 180, 30])
    expect(task.dueAt.getHours()).toBe(22)
  })

  it('CSV 缺少标题或截止时间时给出致命错误', () => {
    expect(parseCsvTasks('课程,标题\n高数,作业', []).fatal).toContain('标题')
    expect(parseCsvTasks('标题,截止时间\n', []).fatal).toContain('至少需要')
  })

  it('导入 CSV 时自动创建课程、写入任务并按 externalId 去重', () => {
    const csv = [
      '标题,截止时间,所属课程,优先级,类型',
      '概率论习题,2026-12-03 18:00,概率论,中,作业',
      '概率论复习,2026-12-05 20:00,概率论,低,阅读'
    ].join('\n')
    const first = importTasksFromFile(store, { fileName: 'tasks.csv', content: csv })
    expect(first.state).toBe('success')
    expect(first.importedTasks).toBe(2)
    expect(first.importedCourses).toBe(1)
    expect(store.listCourses().some((course) => course.name === '概率论')).toBe(true)

    const second = importTasksFromFile(store, { fileName: 'tasks.csv', content: csv })
    expect(second.state).toBe('failure')
    expect(second.importedTasks).toBe(0)
    expect(second.skipped).toBe(2)
  })

  it('解析 ICS 的 TZID、全天事件与折叠行', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:exam-001',
      'SUMMARY:数据库期末考试',
      'DESCRIPTION:闭卷考试\\n请携带学生证',
      'CATEGORIES:数据库原理',
      'DTSTART;TZID=Asia/Shanghai:20261220T090000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:reading-001',
      'SUMMARY:阅读课程',
      ' 长',
      ' 摘要',
      'DTSTART;VALUE=DATE:20261221',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n')
    const result = parseIcsTasks(ics, [60, 180])
    expect(result.tasks).toHaveLength(2)
    const exam = result.tasks[0]!
    expect(exam.title).toBe('数据库期末考试')
    expect(exam.courseName).toBe('数据库原理')
    expect(exam.dueAt.toISOString()).toBe('2026-12-20T01:00:00.000Z')
    expect(exam.description).toContain('闭卷考试\n请携带学生证')
    expect(exam.reminderOffsets).toEqual([60, 180])
    const allDay = result.tasks[1]!
    expect(allDay.title).toBe('阅读课程长摘要')
    expect(allDay.kind).toBe('reading')
  })

  it('导入失败时返回 failure，不虚报成功', () => {
    const result = importTasksFromFile(store, { fileName: 'bad.csv', content: 'foo,bar\n1,2' })
    expect(result.state).toBe('failure')
    expect(result.importedTasks).toBe(0)
    expect(result.message).toContain('表头')
  })
})
