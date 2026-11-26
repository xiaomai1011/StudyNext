/**
 * 学习通作业标识工具。
 *
 * 平台列表页并不总是提供稳定的作业 ID（workid / answerid）。此时历史实现
 * 用标题哈希兜底，同一教学班内两个同名作业会得到相同 externalId，随后在
 * 同步去重阶段被 Map 静默覆盖，导致其中一条作业消失。
 *
 * 这里的策略：
 * 1. 优先使用平台提供的稳定作业 ID 或稳定页面参数；
 * 2. 身份绝不依赖提交状态、成绩、列表顺序或 enc/t/token 等临时签名；
 * 3. 无法可靠区分时保留已有记录、跳过不确定的新记录并显式报告；
 * 4. 落库前保证 externalId 唯一。
 */

/** URL 中随请求变化、不能作为长期标识的参数。 */
const VOLATILE_PARAMS = new Set([
  'enc',
  't',
  'v',
  'ut',
  'openc',
  'stuenc',
  '_t',
  'time',
  'timestamp',
  'token',
  'sign',
  'signature',
  'nonce',
  'rnd',
  'random',
  'isdisplaytable',
  'num',
  'mooc2',
  'hidetype',
  'fanyaVersion'
])

/** 平台作业稳定 ID 的候选参数，按可信度排序。 */
const STABLE_ID_PARAMS = ['workid', 'answerid', 'taskrefid', 'jobid', 'workrefid', 'id']

export interface TaskIdentityRecord {
  externalId: string
  title: string
  sourceUrl: string | null
  /** 仅用于展示/兼容，不参与身份判断。 */
  platformStatus?: string
}

export interface ExistingTaskIdentity {
  externalId: string
  sourceUrl: string | null
  platformStatus?: string
}

export interface IdentityConflictResult<T extends TaskIdentityRecord> {
  records: T[]
  /** 需要写入同步提示的冲突说明；为空表示没有无法区分的同名记录。 */
  warnings: string[]
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

export function buildTaskExternalId(
  courseExternalId: string,
  homeworkId: string | null,
  title: string
): string {
  const suffix = homeworkId ?? `t${hashString(title)}`
  return `${courseExternalId}:${suffix}`
}

/**
 * 提取页面稳定参数指纹：保留路径与去除易变签名后的查询参数。
 * 没有稳定查询参数时返回 null，避免所有作业退化成同一个路径。
 */
export function stableUrlKey(rawUrl: string | null): string | null {
  if (!rawUrl) return null
  const withoutHash = rawUrl.split('#')[0] ?? ''
  const queryIndex = withoutHash.indexOf('?')
  const path = (queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)).trim()
  if (!path) return null
  if (queryIndex === -1) return null
  const query = withoutHash.slice(queryIndex + 1)
  const kept: string[] = []
  for (const pair of query.split('&')) {
    if (!pair) continue
    const [rawKey, rawValue] = pair.split('=')
    if (!rawKey) continue
    const key = decodeURIComponent(rawKey).toLowerCase()
    if (VOLATILE_PARAMS.has(key)) continue
    if (!rawValue) continue
    kept.push(`${key}=${rawValue}`)
  }
  kept.sort()
  return kept.length > 0 ? `${path}?${kept.join('&')}` : null
}

/** 从作业 URL 中读取平台稳定 ID（workid / answerid 等）。 */
export function readStableWorkId(rawUrl: string | null): string | null {
  if (!rawUrl) return null
  const queryIndex = rawUrl.indexOf('?')
  if (queryIndex === -1) return null
  const query = rawUrl.slice(queryIndex + 1).split('#')[0] ?? ''
  const params = new Map<string, string>()
  for (const pair of query.split('&')) {
    if (!pair) continue
    const [rawKey, rawValue] = pair.split('=')
    if (!rawKey) continue
    params.set(decodeURIComponent(rawKey).toLowerCase(), decodeURIComponent(rawValue ?? ''))
  }
  for (const key of STABLE_ID_PARAMS) {
    const value = params.get(key)
    if (value) return value
  }
  return null
}

/** 尝试从平台 ID 或稳定 URL 参数得到可长期使用的 identity key。 */
export function stableIdentityKey(sourceUrl: string | null): string | null {
  return readStableWorkId(sourceUrl) ?? stableUrlKey(sourceUrl)
}

function suffixFor(baseId: string, key: string): string {
  return `${baseId}:s${hashString(key)}`
}

/**
 * 处理同一批次内 externalId 冲突的作业记录。
 *
 * 关键约束：
 * - 不使用状态/成绩/标题/列表位置判断身份；
 * - 同平台 ID 的重复渲染可安全去重；
 * - 稳定参数可一一区分时按稳定参数分配 ID，并优先沿用已有 ID；
 * - 无法可靠区分时跳过不确定记录、保留已有记录并写入 identity_conflict 警告；
 * - 最后保证外部 ID 唯一，绝不把两条记录写进同一个 externalId。
 */
export function resolveTaskIdentityConflicts<T extends TaskIdentityRecord>(
  records: T[],
  findExistingCandidates: (baseId: string) => ExistingTaskIdentity[]
): IdentityConflictResult<T> {
  const groups = new Map<string, T[]>()
  const order: string[] = []
  for (const record of records) {
    const bucket = groups.get(record.externalId)
    if (bucket) {
      bucket.push(record)
    } else {
      groups.set(record.externalId, [record])
      order.push(record.externalId)
    }
  }

  const output: T[] = []
  const warnings: string[] = []
  const usedExternalIds = new Set<string>()
  const addUnique = (record: T, externalId: string): boolean => {
    if (usedExternalIds.has(externalId)) {
      warnings.push(`作业「${record.title}」的标识冲突未解决，已跳过该记录以避免覆盖`)
      return false
    }
    usedExternalIds.add(externalId)
    output.push({ ...record, externalId })
    return true
  }

  for (const baseId of order) {
    const group = groups.get(baseId) ?? []
    const existing = findExistingCandidates(baseId).filter(
      (item) => item.externalId === baseId || item.externalId.startsWith(`${baseId}:`)
    )
    const platformIds = group.map((item) => readStableWorkId(item.sourceUrl))
    const firstPlatformId = platformIds[0] ?? null
    const allSamePlatformId =
      group.length > 1 &&
      firstPlatformId !== null &&
      platformIds.every((id) => id === firstPlatformId)

    // 平台稳定 ID 相同：同一作业的重复渲染可安全去重。平台 ID 是可靠身份，
    // 不依赖标题、状态或完整 URL。
    if (allSamePlatformId) {
      addUnique(group[0] as T, baseId)
      continue
    }

    const keys = group.map((item) => stableIdentityKey(item.sourceUrl))
    const uniqueKeys = new Set(keys.filter((key): key is string => key !== null))

    if (group.length === 1) {
      const record = group[0] as T
      const key = keys[0] ?? null
      if (existing.length === 0) {
        addUnique(record, baseId)
        continue
      }
      if (key) {
        const match = existing.find((item) => stableIdentityKey(item.sourceUrl) === key)
        if (match) {
          addUnique(record, match.externalId)
          continue
        }
        // 当前记录有可靠独立身份，但与历史单候选的稳定身份不同：
        // 不能因为“本次只返回一条”就把 B 当作 A。为 B 生成独立后缀 ID，
        // 保留旧记录，并明确提示身份冲突。
        const existingHasStableIdentity = existing.some(
          (item) => stableIdentityKey(item.sourceUrl) !== null
        )
        const candidate = suffixFor(baseId, key)
        if (existing.some((item) => item.externalId === candidate)) {
          warnings.push(
            `identity_conflict：作业「${record.title}」的候选标识与历史记录冲突，已保留旧记录并跳过本次更新`
          )
          continue
        }
        addUnique(record, candidate)
        warnings.push(
          existingHasStableIdentity
            ? `identity_conflict：作业「${record.title}」本次返回的记录与历史同名作业的稳定身份不一致，已保留旧记录并生成独立标识`
            : `identity_conflict：作业「${record.title}」的历史记录缺少可靠身份，无法确认是否为同一作业；已保留旧记录并生成独立标识`
        )
        continue
      }
      // 当前记录没有可靠独立身份。历史已有记录时不得猜测对应关系，
      // 否则一条同名作业就可能覆盖旧任务。
      warnings.push(
        `作业「${record.title}」本次只返回一条记录，但缺少可靠平台 ID 或稳定参数，无法确认它对应哪条历史记录；identity_unknown，已保留旧记录并跳过本次更新`
      )
      continue
    }

    // 多条记录：只有每个记录都有唯一且非空的稳定 identity key 时才允许分配新 ID。
    if (uniqueKeys.size !== group.length || keys.some((key) => key === null)) {
      warnings.push(
        `作业「${group[0]?.title ?? '未命名作业'}」有 ${group.length} 条同名记录，缺少可靠平台 ID 或稳定参数，identity_unknown，已保留旧记录并跳过本次不确定记录`
      )
      continue
    }

    const byKey = new Map<string, T>()
    group.forEach((item, index) => {
      byKey.set(keys[index] as string, item)
    })
    const sortedKeys = [...byKey.keys()].sort()
    const existingByKey = new Map<string, ExistingTaskIdentity>()
    for (const item of existing) {
      const key = stableIdentityKey(item.sourceUrl)
      if (key && !existingByKey.has(key)) existingByKey.set(key, item)
    }
    const existingBaseOwner = existing.find((item) => item.externalId === baseId)
    const baseOwnerKey = existingBaseOwner ? stableIdentityKey(existingBaseOwner.sourceUrl) : null
    const canAssignBaseId = !existingBaseOwner || Boolean(baseOwnerKey && byKey.has(baseOwnerKey))
    const baseKey = canAssignBaseId
      ? baseOwnerKey && byKey.has(baseOwnerKey)
        ? baseOwnerKey
        : sortedKeys[0]!
      : null
    for (const key of sortedKeys) {
      const record = byKey.get(key) as T
      const existingMatch = existingByKey.get(key)
      let externalId = existingMatch?.externalId ?? ''
      if (!externalId) {
        externalId = key === baseKey ? baseId : suffixFor(baseId, key)
        if (existing.some((item) => item.externalId === externalId)) {
          warnings.push(
            `identity_conflict：作业「${record.title}」的候选标识与历史记录冲突，已跳过该记录`
          )
          continue
        }
      }
      addUnique(record, externalId)
    }
    warnings.push(
      `作业「${group[0]?.title ?? '未命名作业'}」缺少平台作业 ID，检测到 ${group.length} 条同名记录，已按稳定页面参数区分，请核对`
    )
    if (existingBaseOwner && !canAssignBaseId) {
      warnings.push(
        `identity_conflict：作业「${group[0]?.title ?? '未命名作业'}」的已有记录只有易变页面参数，无法可靠复用原 identity，本次使用稳定后缀并保留旧记录`
      )
    }
  }
  return { records: output, warnings }
}
