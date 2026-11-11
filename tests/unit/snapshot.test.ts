import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importStudySnapshot, parseStudySnapshot } from '../../src/main/integrations/snapshot'
import { StudyNextStore } from '../../src/main/storage/store'

let store: StudyNextStore

beforeEach(() => {
  store = new StudyNextStore(':memory:')
})

afterEach(() => {
  store.close()
})

const snapshot = JSON.stringify({
  source: 'fixture-snapshot',
  courses: [
    {
      id: 'course-a',
      name: '课程 A',
      code: 'A-101',
      chapters: [
        {
          id: 'chapter-1',
          title: '第一章',
          points: [
            { id: 'point-1', title: '导学视频', type: 'video', completed: 'false' },
            { id: 'point-2', title: '章节测验', type: 'quiz', status: 'done' }
          ]
        }
      ],
      homeworks: [
        {
          id: 'homework-1',
          title: '课程 A 作业',
          deadline: '2026-12-10T18:00:00+08:00',
          courseId: 'course-a'
        }
      ]
    },
    {
      id: 'course-b',
      name: '课程 B',
      chapters: [
        {
          id: 'chapter-1',
          title: '同名章节 ID',
          points: [{ id: 'point-1', title: '课程 B 阅读', type: 'reading' }]
        }
      ]
    }
  ],
  homeworks: [
    {
      id: 'homework-1',
      title: '课程 A 作业',
      deadline: '2026-12-10T18:00:00+08:00',
      courseId: 'course-a'
    }
  ]
})

describe('学习快照导入', () => {
  it('解析嵌套章节、学习点与任务，并按课程隔离重复的外部 ID', () => {
    const parsed = parseStudySnapshot(snapshot)
    expect(parsed.courses).toHaveLength(2)
    expect(parsed.courses[0]?.chapters).toHaveLength(1)
    expect(parsed.courses[1]?.chapters[0]?.externalId).toBe('chapter-1')
    expect(parsed.courses[0]?.chapters[0]?.points[0]?.completed).toBe(false)
    expect(parsed.courses[0]?.chapters[0]?.points[1]?.completed).toBe(true)
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.tasks[0]?.externalId).toBe('course-a:homework-1')
  })

  it('导入后写入章节与学习点、计算进度并去重任务', () => {
    const first = importStudySnapshot(store, { fileName: 'snapshot.json', content: snapshot })
    expect(first.state).toBe('success')
    expect(first.importedCourses).toBe(2)
    expect(first.importedChapters).toBe(2)
    expect(first.importedPoints).toBe(3)
    expect(first.importedTasks).toBe(1)
    expect(store.listCourses().some((course) => course.externalId === 'course-a')).toBe(true)
    const courseA = store.listCourses().find((course) => course.externalId === 'course-a')
    expect(courseA).toBeDefined()
    const chapters = store.listChapters().filter((chapter) => chapter.courseId === courseA!.id)
    expect(chapters).toHaveLength(1)
    expect(chapters[0]?.progress).toBe(50)
    const points = store.listStudyPoints().filter((point) => point.courseId === courseA!.id)
    expect(points.find((point) => point.title === '导学视频')?.status).toBe('todo')
    expect(points.find((point) => point.title === '章节测验')?.status).toBe('done')

    const second = importStudySnapshot(store, { fileName: 'snapshot.json', content: snapshot })
    expect(second.skipped).toBe(1)
    expect(second.importedTasks).toBe(0)
    expect(store.listTasks().filter((task) => task.title === '课程 A 作业')).toHaveLength(1)
  })

  it('把 0–1 小数和显式百分号分别规范化为 0–100 进度', () => {
    const parsed = parseStudySnapshot(
      JSON.stringify({
        courses: [
          {
            id: 'course-progress',
            name: '进度课程',
            chapters: [
              { id: 'fraction', title: '小数进度', progress: 0.5, points: [] },
              { id: 'percent', title: '百分号进度', progress: '25%', points: [] }
            ]
          }
        ]
      })
    )
    expect(parsed.courses[0]?.chapters[0]?.progress).toBe(50)
    expect(parsed.courses[0]?.chapters[1]?.progress).toBe(25)
  })

  it('非法 JSON 与空快照会返回明确错误', () => {
    expect(() => parseStudySnapshot('{')).toThrow('JSON 格式无效')
    expect(() => parseStudySnapshot('{}')).toThrow('没有找到')
  })
})
