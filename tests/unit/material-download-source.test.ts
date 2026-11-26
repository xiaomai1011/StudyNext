import { afterEach, describe, expect, it } from 'vitest'
import { StudyNextStore } from '../../src/main/storage/store'
import {
  platformMaterialFileId,
  resolveMaterialDownloadSource
} from '../../src/main/materials/download-source'

const stores: StudyNextStore[] = []

function createStore(): StudyNextStore {
  const store = new StudyNextStore(':memory:')
  stores.push(store)
  return store
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
})

function seedCourse(store: StudyNextStore): string {
  const { course } = store.upsertProviderCourse({
    externalId: '1001:2001',
    name: '数据结构',
    teacher: '张老师',
    sourceUrl:
      'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=1001&clazzid=2001&cpi=3001',
    clazzId: '2001'
  })
  return course.id
}

function addMaterial(
  store: StudyNextStore,
  courseId: string,
  input: {
    externalId: string
    name: string
    kind: 'folder' | 'file' | 'link'
    sourceUrl?: string | null
    url?: string | null
  }
): string {
  store.replaceProviderMaterials(courseId, [
    {
      externalId: input.externalId,
      name: input.name,
      kind: input.kind,
      fileType: input.kind === 'file' ? 'pdf' : 'url',
      size: '1 MB',
      url: input.url ?? null,
      sourceUrl: input.sourceUrl ?? null
    }
  ])
  const material = store
    .listMaterials()
    .find((item) => item.courseId === courseId && item.externalId === input.externalId)
  if (!material) throw new Error('material missing')
  return material.id
}

describe('资料下载来源解析', () => {
  it('URL 型文件在没有数字平台 ID 时使用资料记录中的实际 URL', () => {
    const store = createStore()
    const courseId = seedCourse(store)
    const materialId = addMaterial(store, courseId, {
      externalId: 'material:url:abc123',
      name: '课程讲义.pdf',
      kind: 'file',
      sourceUrl: 'https://p.ananas.chaoxing.com/star3/origin/abc123.pdf'
    })

    const source = resolveMaterialDownloadSource(store, materialId)
    expect(source.sourceKind).toBe('url_file')
    expect(source.url).toBe('https://p.ananas.chaoxing.com/star3/origin/abc123.pdf')
    expect(source.materialId).toBe(materialId)
    expect(source.materialName).toBe('课程讲义.pdf')
  })

  it('数字平台 ID 构造 downloadData，并携带课程 cpi 与教学班', () => {
    const store = createStore()
    const courseId = seedCourse(store)
    const materialId = addMaterial(store, courseId, {
      externalId: 'material:987654',
      name: '平台文件.docx',
      kind: 'file'
    })

    expect(platformMaterialFileId('material:987654')).toBe('987654')
    expect(platformMaterialFileId('material:url:987654')).toBeNull()
    const source = resolveMaterialDownloadSource(store, materialId)
    const url = new URL(source.url)
    expect(source.sourceKind).toBe('platform_file')
    expect(url.pathname).toBe('/coursedata/downloadData')
    expect(url.searchParams.get('dataId')).toBe('987654')
    expect(url.searchParams.get('classId')).toBe('2001')
    expect(url.searchParams.get('courseId')).toBe('1001')
    expect(url.searchParams.get('cpi')).toBe('3001')
    expect(source.referer).toContain('stucoursemiddle')
  })

  it('不受信协议或域名在创建下载任务前拒绝', () => {
    const store = createStore()
    const courseId = seedCourse(store)
    const materialId = addMaterial(store, courseId, {
      externalId: 'material:url:evil',
      name: '危险文件.pdf',
      kind: 'file',
      sourceUrl: 'https://evil.example/file.pdf'
    })
    expect(() => resolveMaterialDownloadSource(store, materialId)).toThrowError(/学习通官方域名/)
  })

  it('资料不存在、文件夹或没有下载地址时返回具体错误', () => {
    const store = createStore()
    const courseId = seedCourse(store)
    expect(() => resolveMaterialDownloadSource(store, 'missing')).toThrowError(/资料不存在/)

    const folderId = addMaterial(store, courseId, {
      externalId: 'material:folder:1',
      name: '课件',
      kind: 'folder'
    })
    expect(() => resolveMaterialDownloadSource(store, folderId)).toThrowError(/文件夹不能直接下载/)

    const noSourceId = addMaterial(store, courseId, {
      externalId: 'material:url:no-source',
      name: '无地址文件.pdf',
      kind: 'file'
    })
    expect(() => resolveMaterialDownloadSource(store, noSourceId)).toThrowError(
      /没有可用的下载地址/
    )
  })

  it('不同工作区中相同 externalId 的资料只解析当前工作区记录', () => {
    const storeA = createStore()
    const storeB = createStore()
    const courseA = seedCourse(storeA)
    const courseB = seedCourse(storeB)
    const a = addMaterial(storeA, courseA, {
      externalId: 'material:url:same',
      name: 'A 讲义.pdf',
      kind: 'file',
      sourceUrl: 'https://p.ananas.chaoxing.com/star3/origin/a.pdf'
    })
    const b = addMaterial(storeB, courseB, {
      externalId: 'material:url:same',
      name: 'B 讲义.pdf',
      kind: 'file',
      sourceUrl: 'https://p.ananas.chaoxing.com/star3/origin/b.pdf'
    })

    expect(resolveMaterialDownloadSource(storeA, a).materialName).toBe('A 讲义.pdf')
    expect(resolveMaterialDownloadSource(storeB, b).materialName).toBe('B 讲义.pdf')
    expect(() => resolveMaterialDownloadSource(storeB, a)).toThrowError(/资料不存在/)
  })
})
