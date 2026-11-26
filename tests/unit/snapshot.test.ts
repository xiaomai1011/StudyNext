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

  it('同名平台课程不会被快照导入改写来源或 externalId，且关联数据保持独立', () => {
    const platform = store.upsertProviderCourse({
      externalId: '266936191:154266737',
      name: '计算机导论',
      teacher: '李老师',
      sourceUrl: 'https://mooc1.chaoxing.com/course/266936191'
    })
    store.upsertImportedTask(
      {
        title: '平台作业',
        description: '平台作业说明',
        courseId: platform.course.id,
        priority: 'medium',
        kind: 'homework',
        dueAt: '2026-12-01T12:00:00.000Z',
        reminderOffsets: [60],
        status: 'todo'
      },
      { externalId: '266936191:154266737:work-1', source: 'chaoxing' }
    )
    const platformChapter = store.upsertSnapshotChapter({
      courseId: platform.course.id,
      externalId: 'platform-chapter',
      title: '平台章节',
      sortOrder: 1,
      progress: 100
    })

    const importSnapshot = JSON.stringify({
      courses: [
        {
          id: 'import-course-1',
          name: '计算机导论',
          code: 'CS-101',
          chapters: [{ id: 'import-chapter', title: '导入章节', points: [] }],
          homeworks: [{ id: 'hw-1', title: '导入作业', deadline: '2026-12-20T18:00:00+08:00' }]
        }
      ]
    })
    const first = importStudySnapshot(store, {
      fileName: 'same-name.json',
      content: importSnapshot
    })
    expect(first.state).toBe('success')
    expect(first.importedCourses).toBe(1)

    const platformAfter = store.getCourse(platform.course.id)
    expect(platformAfter?.source).toBe('chaoxing')
    expect(platformAfter?.externalId).toBe('266936191:154266737')
    expect(platformAfter?.name).toBe('计算机导论')

    const sameNameCourses = store.listCourses().filter((course) => course.name === '计算机导论')
    expect(sameNameCourses).toHaveLength(2)
    const importedCourse = sameNameCourses.find((course) => course.source === 'import')
    expect(importedCourse?.externalId).toBe('import-course-1')
    expect(importedCourse?.id).not.toBe(platform.course.id)

    const platformTasks = store.listTasks().filter((task) => task.courseId === platform.course.id)
    expect(platformTasks.map((task) => task.title)).toEqual(['平台作业'])
    const importedTasks = store.listTasks().filter((task) => task.courseId === importedCourse?.id)
    expect(importedTasks.map((task) => task.title)).toEqual(['导入作业'])

    const platformChapters = store
      .listChapters()
      .filter((chapter) => chapter.courseId === platform.course.id)
    expect(platformChapters.map((chapter) => chapter.title)).toEqual(['平台章节'])
    expect(platformChapters[0]?.id).toBe(platformChapter.chapter.id)

    const second = importStudySnapshot(store, {
      fileName: 'same-name.json',
      content: importSnapshot
    })
    expect(second.importedCourses).toBe(0)
    expect(second.updatedCourses).toBe(1)
    expect(store.listCourses().filter((course) => course.name === '计算机导论')).toHaveLength(2)
    expect(store.listTasks().filter((task) => task.title === '导入作业')).toHaveLength(1)

    const resync = store.upsertProviderCourse({
      externalId: '266936191:154266737',
      name: '计算机导论',
      teacher: '李老师',
      sourceUrl: 'https://mooc1.chaoxing.com/course/266936191'
    })
    expect(resync.created).toBe(false)
    expect(resync.course.id).toBe(platform.course.id)
    expect(store.listCourses().filter((course) => course.name === '计算机导论')).toHaveLength(2)
  })
})
