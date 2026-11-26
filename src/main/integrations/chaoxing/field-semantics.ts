/**
 * 平台字段更新语义（DATA-012）。
 *
 * 同步层过去用 `record.x ?? existing.x` 保护旧值。这对“页面没读到”是对的，
 * 但平台明确把成绩改成 0、把批语清空、把附件全部删除时，本地会一直显示旧值。
 *
 * 这里把“读到什么”拆成三种状态，供 Parser / Normalizer / SyncService 共用：
 *
 * - `unread`：字段没有被可靠读取（页面没加载、请求失败、没有该区块）→ 不更新旧值。
 * - `present`：读到了确定的值（包括 0、空字符串这类有效值）→ 用新值覆盖。
 * - `confirmed_absent`：页面完整渲染且明确显示该字段为空 → 按平台事实清空。
 */

export type FieldReadState = 'unread' | 'present' | 'confirmed_absent'

export interface ObservedField<T> {
  state: FieldReadState
  value: T | null
}

export function unread<T>(): ObservedField<T> {
  return { state: 'unread', value: null }
}

export function present<T>(value: T | null): ObservedField<T> {
  return { state: 'present', value }
}

export function confirmedAbsent<T>(): ObservedField<T> {
  return { state: 'confirmed_absent', value: null }
}

/**
 * 计算要写入 Store 的字段值。
 *
 * 返回 `undefined` 表示“不要动这个字段”，Store 的 `options.x !== undefined ? x : existing.x`
 * 语义会保留旧值；返回 `null` 表示按平台事实清空。
 */
export function resolveObservedField<T>(
  observed: ObservedField<T> | undefined,
  fallback: T | null | undefined
): T | null | undefined {
  if (!observed) return undefined
  if (observed.state === 'unread') return undefined
  if (observed.state === 'confirmed_absent') return null
  return observed.value
}

/**
 * 附件列表的写入值。
 *
 * 附件是列表：完整扫描且为空才允许清空；扫描不完整时必须保留旧列表，
 * 否则一次失败的详情请求就会把用户已经看到的附件抹掉。
 */
export function resolveObservedAttachments<T>(
  observed: ObservedField<T[]> | undefined,
  fallback: T[] | undefined
): T[] | undefined {
  if (!observed) return undefined
  if (observed.state === 'unread') return undefined
  if (observed.state === 'confirmed_absent') return []
  return observed.value ?? []
}
