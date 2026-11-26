import type { Material } from '@shared/types'
import type { StudyNextStore } from '../storage/store'
import { UserFacingError } from '../lib/errors'
import { isAllowedPortalUrl, upgradePortalHttpUrl } from '../portal/security'

export const MATERIAL_DOWNLOAD_REFERER = 'https://pan-yz.chaoxing.com/'

export interface MaterialDownloadSource {
  materialId: string
  materialName: string
  url: string
  referer: string
  sourceKind: 'platform_file' | 'url_file' | 'link'
}

export function platformMaterialFileId(externalId: string | null | undefined): string | null {
  return externalId?.match(/^material:(\d+)$/)?.[1] ?? null
}

function readMaterialUrl(material: Material): string | null {
  const candidate =
    material.kind === 'link' ? (material.url ?? material.sourceUrl) : material.sourceUrl
  const trimmed = candidate?.trim()
  return trimmed ? trimmed : null
}

function ensureAllowedDownloadUrl(raw: string): string {
  const upgraded = upgradePortalHttpUrl(raw) ?? raw
  let parsed: URL
  try {
    parsed = new URL(upgraded)
  } catch {
    throw new UserFacingError('MATERIAL_URL_BLOCKED', '资料下载地址无效')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443') ||
    !isAllowedPortalUrl(upgraded)
  ) {
    throw new UserFacingError('MATERIAL_URL_BLOCKED', '资料下载地址不在学习通官方域名内')
  }
  return upgraded
}

function buildPlatformFileSource(
  store: StudyNextStore,
  material: Material,
  dataId: string
): MaterialDownloadSource {
  const course = store.getCourse(material.courseId)
  if (!course?.externalId || !course.clazzId) {
    throw new UserFacingError('MATERIAL_NO_COURSE', '资料所属课程信息不完整，请重新同步')
  }
  let cpi = ''
  try {
    cpi = new URL(course.sourceUrl ?? '').searchParams.get('cpi') ?? ''
  } catch {
    cpi = ''
  }
  if (!cpi) throw new UserFacingError('MATERIAL_NO_CPI', '课程页面缺少 cpi 参数，请重新同步课程')
  const params = new URLSearchParams({
    dataId,
    classId: course.clazzId,
    cpi,
    courseId: course.externalId.split(':')[0] ?? course.externalId,
    ut: 's'
  })
  return {
    materialId: material.id,
    materialName: material.name,
    url: `https://mooc1.chaoxing.com/coursedata/downloadData?${params.toString()}`,
    referer: course.sourceUrl ?? MATERIAL_DOWNLOAD_REFERER,
    sourceKind: 'platform_file'
  }
}

/**
 * Resolves a material into a fresh download request.
 *
 * This is intentionally shared by the first download, retry, restart recovery
 * and "download again" paths. It reads only the current workspace Store and
 * never reuses a temporary URL captured by an earlier download attempt.
 */
export function resolveMaterialDownloadSource(
  store: StudyNextStore,
  materialId: string
): MaterialDownloadSource {
  const material = store.listMaterials().find((item) => item.id === materialId)
  if (!material) {
    throw new UserFacingError('MATERIAL_NOT_FOUND', '资料不存在或已从当前账号工作区移除')
  }
  if (material.kind === 'folder') {
    throw new UserFacingError('MATERIAL_FOLDER', '文件夹不能直接下载，请打开官方页面浏览')
  }

  const dataId = platformMaterialFileId(material.externalId)
  if (material.kind === 'link') {
    const link = readMaterialUrl(material)
    if (!link) {
      throw new UserFacingError('MATERIAL_NO_DOWNLOAD_URL', '该链接没有可用的下载地址')
    }
    return {
      materialId: material.id,
      materialName: material.name,
      url: ensureAllowedDownloadUrl(link),
      referer: MATERIAL_DOWNLOAD_REFERER,
      sourceKind: 'link'
    }
  }
  if (dataId) return buildPlatformFileSource(store, material, dataId)

  const remote = readMaterialUrl(material)
  if (!remote) {
    throw new UserFacingError(
      'MATERIAL_NO_DOWNLOAD_URL',
      '该资料缺少平台文件 ID，也没有可用的下载地址，请在官方页面打开'
    )
  }
  return {
    materialId: material.id,
    materialName: material.name,
    url: ensureAllowedDownloadUrl(remote),
    referer: MATERIAL_DOWNLOAD_REFERER,
    sourceKind: 'url_file'
  }
}
