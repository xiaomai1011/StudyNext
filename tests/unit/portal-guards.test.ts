import { describe, expect, it } from 'vitest'
import { isProtectedWorkUrl } from '../../src/main/portal/guards'

describe('Portal 作业编辑保护 URL 判断', () => {
  it('识别顶层作业页与嵌套作业页', () => {
    expect(isProtectedWorkUrl('https://mooc1.chaoxing.com/mooc2/work/dowork?workId=1')).toBe(true)
    expect(isProtectedWorkUrl('https://mooc1.chaoxing.com/work/task?workId=1')).toBe(true)
    expect(isProtectedWorkUrl('https://mooc1.chaoxing.com/mooc2/work')).toBe(true)
    expect(isProtectedWorkUrl('https://mooc1.chaoxing.com/mooc-ans/work/prompt?workId=1')).toBe(
      true
    )
  })

  it('不误判普通课程、章节和资料页', () => {
    expect(isProtectedWorkUrl('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1')).toBe(
      false
    )
    expect(
      isProtectedWorkUrl('https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=1')
    ).toBe(false)
    expect(
      isProtectedWorkUrl('https://mooc2-ans.chaoxing.com/mooc2-ans/coursedata/stu-datalist')
    ).toBe(false)
    expect(isProtectedWorkUrl('https://i.chaoxing.com/base')).toBe(false)
  })
})
