import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import {
  BellRing,
  BookMarked,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Compass,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  History,
  Link2,
  Lock,
  MapPin,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  UserRound,
  X
} from 'lucide-react'
import type {
  AppNotice,
  Chapter,
  ChapterResource,
  Course,
  Exam,
  Material,
  MaterialLocalFile,
  PortalDownload,
  StudyPoint,
  Task
} from '@shared/types'
import { STUDY_POINT_LABEL, TASK_KIND_LABEL } from '@shared/constants'
import {
  examsForCourse,
  findUniqueCourseByName,
  getCourseOfficialUrl,
  isAmbiguousCourseName,
  sortCourseWorkspaceTasks
} from '@shared/course-context'
import { getCourseClassLabel } from '@shared/course-identity'
import {
  courseNeedsAttention,
  getChapterWorkflowSummary,
  parseStudyResumeStorage,
  resolveChapterOfficialDestination,
  resolveCourseResumeTarget,
  resolveGlobalLastStudiedCourse,
  STUDY_RESUME_STORAGE_KEY,
  upsertStudyResumeRecord,
  type ChapterFilterMode,
  type ChapterOfficialDestination,
  type ChapterWorkflowSummary,
  type StudyResumeMap
} from '@shared/course-workflow'
import { dueBucket, formatRemainingCompact } from '@shared/domain'
import {
  canDownloadMaterial,
  chunkBatchRetryDownloadIds,
  countFailedDownloads,
  downloadInlineText,
  downloadStateLabel,
  filterCourseMaterials,
  formatDownloadBytes,
  materialFolderOpenUrl,
  materialPreviewKind,
  materialTarget,
  materialTypeLabel,
  mergeBatchRetryResults,
  planBatchMaterialDownload,
  resolveMaterialDownloadState,
  summarizeBatchTransferSession,
  summarizeCourseDownloads,
  type BatchDispatchFailure,
  type BatchTrackedItem,
  type MaterialDownloadState,
  type MaterialDownloadStatusFilter,
  type MaterialKindFilter
} from '@shared/materials'
import { normalizePortalTargetUrl } from '@shared/portal-url'
import { getCourseSemester, listSemesterOptions } from '@shared/semesters'
import { getCourseProgress } from '@shared/study-progress'
import {
  getTaskPortalAction,
  getTaskScoreView,
  getTaskStatusView,
  isPlatformTask,
  isTaskActionable
} from '@shared/task-state'
import { DownloadQueue } from '../components/DownloadQueue'
import {
  errorMessage,
  formatDateTime,
  formatMinutes,
  formatOptionalDateTime,
  relativeTime
} from '../lib/format'
import { Badge, Button, EmptyState } from '../ui/primitives'
import { platformStatusTone } from '../ui/status'
import type { ToastKind } from '../components/ToastStack'

export type CourseWorkspaceTab = 'chapters' | 'tasks' | 'materials' | 'updates'

interface CourseWorkspaceProps {
  courses: Course[]
  chapters: Chapter[]
  points: StudyPoint[]
  tasks: Task[]
  materials: Material[]
  exams: Exam[]
  notices: AppNotice[]
  downloads: PortalDownload[]
  localFiles?: readonly MaterialLocalFile[] | undefined
  onOpenLocalMaterial?: ((materialId: string) => void) | undefined
  onRevealLocalMaterial?: ((materialId: string) => void) | undefined
  onRefreshLocalFiles?: (() => void) | undefined
  onRecordDownload?: ((download: PortalDownload) => void) | undefined
  selectedCourseId: string | null
  onSelectCourse: (courseId: string) => void
  focusCourseId?: string | null
  focusChapterId?: string | null
  focusTab?: CourseWorkspaceTab | null
  onFocusHandled?: () => void
  onFocusChapterHandled?: () => void
  onFocusTabHandled?: () => void
  downloadPanelOpen: boolean
  onDownloadPanelHandled: () => void
  onToggleFavorite: (course: Course) => Promise<void>
  onOpenOfficial: (course: Course) => void
  onOpenPortalUrl?: (url: string, successMessage?: string) => void
  onRetryCourse: (course: Course) => Promise<void>
  onTogglePoint: (point: StudyPoint, completed: boolean) => Promise<void>
  onOpenChapter: (course: Course, chapter: Chapter) => Promise<void>
  onOpenResource: (resource: ChapterResource) => Promise<void>
  onOpenTask: (task: Task) => void
  onOpenTaskInPortal: (task: Task) => void
  onToggleTask: (task: Task) => void
  onCreateTaskForCourse?: (courseId: string) => void
  onDownloadMaterial: (material: Material) => void
  onPreviewMaterial: (material: Material) => void
  onOpenDownload: (download: PortalDownload) => void
  onRevealDownload: (download: PortalDownload) => void
  onCancelDownload: (download: PortalDownload) => void
  onRetryDownload: (download: PortalDownload) => void
  onDeleteDownload: (download: PortalDownload) => void
  onClearDownloads: () => void
  onViewAllExams?: () => void
  onViewAllNotices?: () => void
  notify: (kind: ToastKind, message: string) => void
}

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function CourseWorkspace({
  courses,
  chapters,
  points,
  tasks,
  materials,
  exams,
  notices,
  downloads,
  localFiles = [],
  onOpenLocalMaterial,
  onRevealLocalMaterial,
  onRefreshLocalFiles,
  onRecordDownload,
  selectedCourseId,
  onSelectCourse,
  focusCourseId,
  focusChapterId,
  focusTab,
  onFocusHandled,
  onFocusChapterHandled,
  onFocusTabHandled,
  downloadPanelOpen,
  onDownloadPanelHandled,
  onToggleFavorite,
  onOpenOfficial,
  onOpenPortalUrl,
  onRetryCourse,
  onTogglePoint,
  onOpenChapter,
  onOpenResource,
  onOpenTask,
  onOpenTaskInPortal,
  onToggleTask,
  onCreateTaskForCourse,
  onDownloadMaterial,
  onPreviewMaterial,
  onOpenDownload,
  onRevealDownload,
  onCancelDownload,
  onRetryDownload,
  onDeleteDownload,
  onClearDownloads,
  onViewAllExams,
  onViewAllNotices,
  notify
}: CourseWorkspaceProps): JSX.Element {
  const [courseQuery, setCourseQuery] = useState('')
  const [semester, setSemester] = useState('全部学期')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [activeTab, setActiveTab] = useState<CourseWorkspaceTab>('chapters')
  const [chapterQuery, setChapterQuery] = useState('')
  const [chapterFilter, setChapterFilter] = useState<ChapterFilterMode>('all')
  const [materialQuery, setMaterialQuery] = useState('')
  const [materialKindFilter, setMaterialKindFilter] = useState<MaterialKindFilter>('all')
  const [materialDownloadFilter, setMaterialDownloadFilter] =
    useState<MaterialDownloadStatusFilter>('all')
  const [materialSelectMode, setMaterialSelectMode] = useState(false)
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<Set<string>>(() => new Set())
  const [batchDownloading, setBatchDownloading] = useState(false)
  const [batchSession, setBatchSession] = useState<{
    courseId: string
    trackedDownloads: BatchTrackedItem[]
    dispatchFailed: BatchDispatchFailure[]
    skippedCompletedCount: number
    skippedInProgressCount: number
  } | null>(null)
  const [focusedMaterialId, setFocusedMaterialId] = useState<string | null>(null)
  const materialFocusTimerRef = useRef<number | null>(null)
  const [downloadDirectory, setDownloadDirectory] = useState<string | null>(null)
  const [taskFilter, setTaskFilter] = useState<'all' | 'open' | 'done'>('all')
  const [expandedChapterIds, setExpandedChapterIds] = useState<Set<string>>(() => new Set())
  const [focusedChapterId, setFocusedChapterId] = useState<string | null>(null)
  const focusTimerRef = useRef<number | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [pendingPointId, setPendingPointId] = useState<string | null>(null)
  const [showDownloads, setShowDownloads] = useState(false)
  const [resumeMap, setResumeMap] = useState<StudyResumeMap>(() => {
    try {
      return parseStudyResumeStorage(window.localStorage.getItem(STUDY_RESUME_STORAGE_KEY))
    } catch {
      return {}
    }
  })

  const recordStudyActivity = (
    courseId: string,
    chapterId: string,
    section?: { number?: string | null; title?: string | null } | null
  ): void => {
    const nextRecord = {
      courseId,
      chapterId,
      sectionNumber: section?.number?.trim() || null,
      sectionTitle: section?.title?.trim() || null,
      updatedAt: new Date().toISOString()
    }
    setResumeMap((prev) => {
      const next = upsertStudyResumeRecord(prev, nextRecord)
      try {
        window.localStorage.setItem(STUDY_RESUME_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage may be unavailable in restricted contexts; keep in-memory state.
      }
      return next
    })
  }

  const semesterOptions = useMemo(() => listSemesterOptions(courses), [courses])

  const attentionCourseIds = useMemo(() => {
    const ids = new Set<string>()
    for (const course of courses) {
      if (courseNeedsAttention(course.id, chapters, points, tasks)) {
        ids.add(course.id)
      }
    }
    return ids
  }, [chapters, courses, points, tasks])

  const lastStudiedCourse = useMemo(
    () => resolveGlobalLastStudiedCourse(courses, chapters, resumeMap),
    [chapters, courses, resumeMap]
  )

  const filteredCourses = useMemo(() => {
    const q = courseQuery.trim().toLocaleLowerCase()
    return courses
      .filter((course) => {
        if (favoritesOnly && !course.favorite) return false
        if (attentionOnly && !attentionCourseIds.has(course.id)) return false
        if (semester !== '全部学期' && getCourseSemester(course) !== semester) return false
        if (!q) return true
        return `${course.name} ${course.code} ${course.teacher} ${course.className ?? ''} ${course.clazzId ?? ''}`
          .toLocaleLowerCase()
          .includes(q)
      })
      .sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN')
      })
  }, [attentionCourseIds, attentionOnly, courses, courseQuery, favoritesOnly, semester])

  const activeCourse = useMemo(() => {
    if (selectedCourseId) {
      const exact = courses.find((course) => course.id === selectedCourseId)
      if (exact) return exact
    }
    return filteredCourses[0] ?? courses[0] ?? null
  }, [courses, filteredCourses, selectedCourseId])

  useEffect(() => {
    if (!focusCourseId) return
    onSelectCourse(focusCourseId)
    setCourseQuery('')
    setSemester('全部学期')
    setFavoritesOnly(false)
    setAttentionOnly(false)
    onFocusHandled?.()
  }, [focusCourseId, onFocusHandled, onSelectCourse])

  useEffect(() => {
    if (!focusTab) return
    setActiveTab(focusTab)
    onFocusTabHandled?.()
  }, [focusTab, onFocusTabHandled])

  useEffect(() => {
    if (!downloadPanelOpen) return
    setShowDownloads(true)
    onDownloadPanelHandled()
  }, [downloadPanelOpen, onDownloadPanelHandled])

  const clearChapterFocus = (): void => {
    if (focusTimerRef.current !== null) {
      window.clearTimeout(focusTimerRef.current)
      focusTimerRef.current = null
    }
    setFocusedChapterId(null)
  }

  const handleSelectCourse = (courseId: string): void => {
    clearChapterFocus()
    setShowDownloads(false)
    onSelectCourse(courseId)
  }

  useEffect(() => {
    setChapterQuery('')
    setChapterFilter('all')
    setMaterialQuery('')
    setMaterialKindFilter('all')
    setMaterialDownloadFilter('all')
    setMaterialSelectMode(false)
    setSelectedMaterialIds(new Set())
    setTaskFilter('all')
  }, [activeCourse?.id])

  const onRefreshLocalFilesRef = useRef(onRefreshLocalFiles)
  onRefreshLocalFilesRef.current = onRefreshLocalFiles

  const activeCourseId = activeCourse?.id ?? null
  useEffect(() => {
    if (activeTab === 'materials' && activeCourseId) {
      onRefreshLocalFilesRef.current?.()
    }
  }, [activeCourseId, activeTab])

  useEffect(() => {
    if (!showDownloads) return
    let cancelled = false
    void window.studynext?.portal
      ?.downloadDirectory?.()
      .then((dir) => {
        if (!cancelled && dir) setDownloadDirectory(dir)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [showDownloads])

  const focusAndRevealChapter = (chapterId: string): void => {
    setActiveTab('chapters')
    setChapterQuery('')
    setChapterFilter('all')
    setExpandedChapterIds((prev) => new Set([...prev, chapterId]))
    setFocusedChapterId(chapterId)
    if (focusTimerRef.current !== null) {
      window.clearTimeout(focusTimerRef.current)
    }
    focusTimerRef.current = window.setTimeout(() => {
      setFocusedChapterId(null)
      focusTimerRef.current = null
    }, 2600)
    window.requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(
        `.chapter-card[data-chapter-id="${CSS.escape(chapterId)}"]`
      )
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }

  useEffect(() => {
    if (!focusChapterId) return
    focusAndRevealChapter(focusChapterId)
    onFocusChapterHandled?.()
  }, [focusChapterId, onFocusChapterHandled])

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current)
        focusTimerRef.current = null
      }
      if (materialFocusTimerRef.current !== null) {
        window.clearTimeout(materialFocusTimerRef.current)
        materialFocusTimerRef.current = null
      }
    }
  }, [])

  const courseStatsMap = useMemo(() => {
    const map = new Map<
      string,
      { progress: number | null; pendingTasks: number; chapterCount: number; materialCount: number }
    >()
    for (const course of courses) {
      const prog = getCourseProgress(course.id, chapters, points)
      const pendingTasks = tasks.filter(
        (task) =>
          task.courseId === course.id &&
          task.status !== 'done' &&
          !['submitted', 'pending_review', 'reviewed', 'done'].includes(task.platformStatusKind)
      ).length
      const materialCount = materials.filter((item) => item.courseId === course.id).length
      map.set(course.id, {
        progress: prog.percent,
        pendingTasks,
        chapterCount: prog.chapterCount,
        materialCount
      })
    }
    return map
  }, [chapters, courses, materials, points, tasks])

  const courseChapters = useMemo(() => {
    if (!activeCourse) return []
    return chapters
      .filter((chapter) => chapter.courseId === activeCourse.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [activeCourse, chapters])

  useEffect(() => {
    if (courseChapters.length === 0) return
    const first = courseChapters[0]
    if (!first) return
    setExpandedChapterIds((prev) => {
      if (courseChapters.some((ch) => prev.has(ch.id))) return prev
      return new Set([...prev, first.id])
    })
  }, [courseChapters])

  const pointsByChapter = useMemo(() => {
    const map = new Map<string, StudyPoint[]>()
    for (const point of points) {
      const list = map.get(point.chapterId) ?? []
      list.push(point)
      map.set(point.chapterId, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return map
  }, [points])

  const chapterSummaryMap = useMemo(() => {
    const map = new Map<string, ChapterWorkflowSummary>()
    for (const chapter of courseChapters) {
      map.set(chapter.id, getChapterWorkflowSummary(chapter, pointsByChapter.get(chapter.id) ?? []))
    }
    return map
  }, [courseChapters, pointsByChapter])

  const unfinishedChapterCount = useMemo(
    () =>
      courseChapters.filter((chapter) => chapterSummaryMap.get(chapter.id)?.status === 'incomplete')
        .length,
    [chapterSummaryMap, courseChapters]
  )

  const filteredChapters = useMemo(() => {
    const q = chapterQuery.trim().toLowerCase()
    return courseChapters.filter((chapter) => {
      if (
        chapterFilter === 'incomplete' &&
        chapterSummaryMap.get(chapter.id)?.status !== 'incomplete'
      ) {
        return false
      }
      if (!q) return true
      if (chapter.title.toLowerCase().includes(q)) return true
      if (
        chapter.sections.some(
          (sec) =>
            sec.title.toLowerCase().includes(q) ||
            sec.resources.some((res) => res.name.toLowerCase().includes(q))
        )
      ) {
        return true
      }
      const chPoints = pointsByChapter.get(chapter.id) ?? []
      return chPoints.some((pt) => pt.title.toLowerCase().includes(q))
    })
  }, [chapterFilter, chapterQuery, chapterSummaryMap, courseChapters, pointsByChapter])

  const activeResumeTarget = useMemo(() => {
    if (!activeCourse) return null
    return resolveCourseResumeTarget(
      activeCourse,
      courseChapters,
      pointsByChapter,
      resumeMap[activeCourse.id]
    )
  }, [activeCourse, courseChapters, pointsByChapter, resumeMap])

  const chapterIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    courseChapters.forEach((chapter, index) => map.set(chapter.id, index + 1))
    return map
  }, [courseChapters])

  const courseTasks = useMemo(() => {
    if (!activeCourse) return []
    return sortCourseWorkspaceTasks(tasks.filter((task) => task.courseId === activeCourse.id))
  }, [activeCourse, tasks])

  const openCourseTaskCount = useMemo(
    () => courseTasks.filter((task) => isTaskActionable(task)).length,
    [courseTasks]
  )
  const doneCourseTaskCount = courseTasks.length - openCourseTaskCount

  const visibleCourseTasks = useMemo(() => {
    if (taskFilter === 'open') return courseTasks.filter((task) => isTaskActionable(task))
    if (taskFilter === 'done') return courseTasks.filter((task) => !isTaskActionable(task))
    return courseTasks
  }, [courseTasks, taskFilter])

  const allCourseMaterials = useMemo(() => {
    if (!activeCourse) return []
    return filterCourseMaterials(materials, activeCourse.id)
  }, [activeCourse, materials])

  const materialKindCounts = useMemo(() => {
    let file = 0
    let folder = 0
    let link = 0
    for (const item of allCourseMaterials) {
      if (item.kind === 'folder') folder += 1
      else if (item.kind === 'link') link += 1
      else file += 1
    }
    return { file, folder, link, activeKinds: [file, folder, link].filter((n) => n > 0).length }
  }, [allCourseMaterials])

  const materialDownloadStateMap = useMemo(() => {
    const map = new Map<string, MaterialDownloadState>()
    for (const item of allCourseMaterials) {
      map.set(item.id, resolveMaterialDownloadState(item, downloads, localFiles))
    }
    return map
  }, [allCourseMaterials, downloads, localFiles])

  const courseDownloadSummary = useMemo(
    () => summarizeCourseDownloads(allCourseMaterials, downloads, localFiles),
    [allCourseMaterials, downloads, localFiles]
  )

  const courseMaterials = useMemo(() => {
    if (!activeCourse) return []
    return filterCourseMaterials(materials, activeCourse.id, {
      query: materialQuery,
      kind: materialKindFilter,
      downloadStatus: materialDownloadFilter,
      downloads,
      localFiles
    })
  }, [
    activeCourse,
    downloads,
    localFiles,
    materialDownloadFilter,
    materialKindFilter,
    materialQuery,
    materials
  ])

  const visibleDownloadableMaterials = useMemo(
    () => courseMaterials.filter((item) => canDownloadMaterial(item)),
    [courseMaterials]
  )

  const visibleUndownloadedMaterials = useMemo(
    () =>
      visibleDownloadableMaterials.filter((item) => {
        const state = materialDownloadStateMap.get(item.id)
        return !state?.hasCompleted && !state?.isDownloading
      }),
    [materialDownloadStateMap, visibleDownloadableMaterials]
  )

  const batchPlan = useMemo(
    () =>
      planBatchMaterialDownload(allCourseMaterials, selectedMaterialIds, downloads, {
        localFiles
      }),
    [allCourseMaterials, downloads, localFiles, selectedMaterialIds]
  )

  // Preserve observed terminal states on batch-tracked downloads so clearing the queue
  // never causes completed/failed/cancelled items to regress back to "transferring".
  useEffect(() => {
    if (!batchSession || batchSession.trackedDownloads.length === 0) return
    const byId = new Map(downloads.map((item) => [item.id, item]))
    let changed = false
    const updatedTracked = batchSession.trackedDownloads.map((entry) => {
      const record = byId.get(entry.downloadId)
      if (!record || record.state === 'progressing') return entry
      if (entry.terminalState === record.state) return entry
      changed = true
      return { ...entry, terminalState: record.state }
    })
    if (changed) {
      setBatchSession((prev) => (prev ? { ...prev, trackedDownloads: updatedTracked } : prev))
    }
  }, [batchSession, downloads])

  const activeBatchSummary = useMemo(() => {
    if (!batchSession || !activeCourse || batchSession.courseId !== activeCourse.id) return null
    return summarizeBatchTransferSession(
      batchSession.trackedDownloads,
      batchSession.dispatchFailed,
      downloads,
      {
        courseId: activeCourse.id,
        materials: allCourseMaterials,
        localFiles
      }
    )
  }, [activeCourse, allCourseMaterials, batchSession, downloads, localFiles])

  const toggleMaterialSelected = (materialId: string): void => {
    setSelectedMaterialIds((prev) => {
      const next = new Set(prev)
      if (next.has(materialId)) next.delete(materialId)
      else next.add(materialId)
      return next
    })
  }

  const dispatchBatchMaterials = async (
    targets: Material[],
    meta: { skippedCompletedCount: number; skippedInProgressCount: number }
  ): Promise<void> => {
    if (!activeCourse || targets.length === 0 || batchDownloading) return
    setBatchDownloading(true)
    const dispatchFailed: BatchDispatchFailure[] = []
    const trackedDownloads: BatchTrackedItem[] = []
    try {
      const downloadApi = window.studynext?.materials?.download
      for (const item of targets) {
        try {
          if (downloadApi) {
            const record = await downloadApi(item.id)
            if (record?.id) {
              onRecordDownload?.(record)
              trackedDownloads.push({
                downloadId: record.id,
                materialId: item.id,
                name: item.name
              })
            }
          } else {
            onDownloadMaterial(item)
          }
        } catch (error) {
          dispatchFailed.push({
            materialId: item.id,
            name: item.name,
            error: errorMessage(error)
          })
        }
      }

      setBatchSession({
        courseId: activeCourse.id,
        trackedDownloads,
        dispatchFailed,
        skippedCompletedCount: meta.skippedCompletedCount,
        skippedInProgressCount: meta.skippedInProgressCount
      })

      const skippedParts: string[] = []
      if (meta.skippedCompletedCount > 0) {
        skippedParts.push(`跳过 ${meta.skippedCompletedCount} 项已下载`)
      }
      if (meta.skippedInProgressCount > 0) {
        skippedParts.push(`跳过 ${meta.skippedInProgressCount} 项下载中`)
      }
      const skipSuffix = skippedParts.length > 0 ? `（${skippedParts.join('，')}）` : ''
      if (dispatchFailed.length === 0) {
        notify(
          'info',
          `已提交 ${trackedDownloads.length || targets.length} 项资料至下载队列${skipSuffix}，实时传输结果见下方批次状态`
        )
        setSelectedMaterialIds(new Set())
        setMaterialSelectMode(false)
      } else if (trackedDownloads.length > 0) {
        notify(
          'error',
          `已提交 ${trackedDownloads.length} 项至下载队列，${dispatchFailed.length} 项发起失败：${dispatchFailed[0]?.error ?? '请检查登录状态'}`
        )
        setSelectedMaterialIds(new Set(dispatchFailed.map((item) => item.materialId)))
      } else {
        notify(
          'error',
          `批量下载发起失败（${dispatchFailed.length} 项）：${dispatchFailed[0]?.error ?? '请检查登录状态'}`
        )
        setSelectedMaterialIds(new Set(dispatchFailed.map((item) => item.materialId)))
      }
    } finally {
      setBatchDownloading(false)
    }
  }

  const handleBatchDownload = async (includeCompleted = false): Promise<void> => {
    if (batchDownloading) return
    const plan = planBatchMaterialDownload(allCourseMaterials, selectedMaterialIds, downloads, {
      includeCompleted,
      localFiles
    })
    if (plan.toDownload.length === 0) {
      if (plan.skippedInProgress.length > 0) {
        notify('info', '所选资料均已在下载队列中')
      } else if (plan.skippedCompleted.length > 0) {
        notify('info', '所选资料均已有可用本地副本，可直接打开或点击「重新下载所选」')
      }
      return
    }
    await dispatchBatchMaterials(plan.toDownload, {
      skippedCompletedCount: includeCompleted ? 0 : plan.skippedCompleted.length,
      skippedInProgressCount: plan.skippedInProgress.length
    })
  }

  const handleRetryBatchFailed = async (): Promise<void> => {
    if (!activeCourse || !activeBatchSummary || batchDownloading) return
    const downloadsById = new Map(downloads.map((item) => [item.id, item]))
    const transferRetryIds = activeBatchSummary.retryableTransferFailed
      .filter((item) => downloadsById.has(item.downloadId))
      .map((item) => item.downloadId)
    const clearedTransferMaterialIds = activeBatchSummary.retryableTransferFailed
      .filter((item) => !downloadsById.has(item.downloadId))
      .map((item) => item.materialId)
    const dispatchRetryMaterialIds = [
      ...activeBatchSummary.retryableDispatchFailed.map((item) => item.materialId),
      ...clearedTransferMaterialIds
    ]

    if (transferRetryIds.length === 0 && dispatchRetryMaterialIds.length === 0) {
      notify('info', '本批失败资料已恢复、已有可用本地副本或正在下载中，无需重复下载')
      return
    }

    setBatchDownloading(true)
    const nextTracked: BatchTrackedItem[] = []
    const nextDispatchFailed: BatchDispatchFailure[] = []
    const alreadyHandledMaterialIds = new Set<string>()
    let skippedCompletedCount = 0
    let skippedInProgressCount = 0

    try {
      // 1. Transfer failures still in queue: strictly go through main-process retryFailedDownloads()
      const batchRetryApi = window.studynext?.portal?.retryFailedDownloads
      if (transferRetryIds.length > 0 && batchRetryApi) {
        const retryResults = []
        for (const chunk of chunkBatchRetryDownloadIds(transferRetryIds)) {
          retryResults.push(
            await batchRetryApi({
              courseId: activeCourse.id,
              downloadIds: chunk
            })
          )
        }
        const result = mergeBatchRetryResults(retryResults)
        const materialById = new Map(allCourseMaterials.map((item) => [item.id, item]))
        for (const started of result.startedItems) {
          if (started.materialId) alreadyHandledMaterialIds.add(started.materialId)
          nextTracked.push({
            downloadId: started.downloadId,
            materialId: started.materialId ?? started.downloadId,
            name:
              (started.materialId ? materialById.get(started.materialId)?.name : null) ??
              started.filename
          })
        }
        for (const fail of result.failed) {
          if (fail.materialId) alreadyHandledMaterialIds.add(fail.materialId)
          nextDispatchFailed.push({
            materialId: fail.materialId ?? fail.id,
            name: fail.filename,
            error: fail.error
          })
        }
        for (const skip of result.skipped) {
          if (skip.reason === 'already_local' || skip.reason === 'already_recovered') {
            skippedCompletedCount += 1
          } else if (skip.reason === 'in_progress') {
            skippedInProgressCount += 1
          }
        }
      }

      // 2. Dispatch failures (and cleared-queue failures): re-plan against current verified localFiles & downloads
      const remainingDispatchIds = dispatchRetryMaterialIds.filter(
        (id) => !alreadyHandledMaterialIds.has(id)
      )
      if (remainingDispatchIds.length > 0) {
        const plan = planBatchMaterialDownload(
          allCourseMaterials,
          remainingDispatchIds,
          downloads,
          {
            localFiles
          }
        )
        skippedCompletedCount += plan.skippedCompleted.length
        skippedInProgressCount += plan.skippedInProgress.length
        const downloadApi = window.studynext?.materials?.download
        for (const item of plan.toDownload) {
          try {
            if (downloadApi) {
              const record = await downloadApi(item.id)
              if (record?.id) {
                onRecordDownload?.(record)
                nextTracked.push({
                  downloadId: record.id,
                  materialId: item.id,
                  name: item.name
                })
              }
            } else {
              onDownloadMaterial(item)
            }
          } catch (error) {
            nextDispatchFailed.push({
              materialId: item.id,
              name: item.name,
              error: errorMessage(error)
            })
          }
        }
      }

      if (nextTracked.length === 0 && nextDispatchFailed.length === 0) {
        notify('info', '本批失败资料已恢复、已有可用本地副本或正在下载中，无需重复下载')
        return
      }

      setBatchSession({
        courseId: activeCourse.id,
        trackedDownloads: nextTracked,
        dispatchFailed: nextDispatchFailed,
        skippedCompletedCount,
        skippedInProgressCount
      })

      if (nextDispatchFailed.length === 0) {
        notify('info', `已重新发起 ${nextTracked.length} 项失败下载`)
      } else if (nextTracked.length > 0) {
        notify(
          'error',
          `已重试 ${nextTracked.length} 项，${nextDispatchFailed.length} 项发起失败：${nextDispatchFailed[0]?.error ?? ''}`
        )
      } else {
        notify('error', `重试发起失败：${nextDispatchFailed[0]?.error ?? '请检查登录状态'}`)
      }
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBatchDownloading(false)
    }
  }

  const handleLocateDownloadedMaterial = (courseId: string, materialId: string): void => {
    setShowDownloads(false)
    setCourseQuery('')
    setSemester('全部学期')
    setFavoritesOnly(false)
    setAttentionOnly(false)
    handleSelectCourse(courseId)
    setActiveTab('materials')
    setMaterialQuery('')
    setMaterialKindFilter('all')
    setMaterialDownloadFilter('all')
    setFocusedMaterialId(materialId)
    if (materialFocusTimerRef.current !== null) {
      window.clearTimeout(materialFocusTimerRef.current)
    }
    materialFocusTimerRef.current = window.setTimeout(() => {
      setFocusedMaterialId(null)
      materialFocusTimerRef.current = null
    }, 2600)
    window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `.materials-item[data-material-id="${CSS.escape(materialId)}"]`
      )
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }

  const handleRetryAllFailed = async (
    courseId: string | null,
    failedItems: PortalDownload[]
  ): Promise<void> => {
    if (failedItems.length === 0) return
    const batchRetryApi = window.studynext?.portal?.retryFailedDownloads
    if (batchRetryApi) {
      try {
        const result = await batchRetryApi({
          courseId,
          downloadIds: failedItems.map((item) => item.id)
        })
        const started = result.startedDownloadIds.length
        const failed = result.failed.length
        const skipped = result.skipped.length
        if (started === 0 && failed === 0) {
          notify('info', '没有需要重试的失败任务（已排除进行中、已恢复或已有本地副本的记录）')
        } else if (failed === 0) {
          notify(
            'info',
            `已重新发起 ${started} 项失败下载${skipped > 0 ? `（跳过 ${skipped} 项无需重试）` : ''}`
          )
        } else if (started > 0) {
          notify(
            'error',
            `已重试 ${started} 项，仍有 ${failed} 项发起失败：${result.failed[0]?.error ?? ''}`
          )
        } else {
          notify('error', `重试发起失败：${result.failed[0]?.error ?? '请稍后再试'}`)
        }
      } catch (error) {
        notify('error', errorMessage(error))
      }
      return
    }
    for (const item of failedItems) {
      onRetryDownload(item)
    }
  }

  const ambiguousCourse = useMemo(
    () => (activeCourse ? isAmbiguousCourseName(activeCourse, courses) : false),
    [activeCourse, courses]
  )

  const courseExams = useMemo(() => {
    if (!activeCourse) return []
    return examsForCourse(activeCourse, courses, exams)
  }, [activeCourse, courses, exams])

  const courseNotices = useMemo(() => {
    if (!activeCourse) return []
    const unique = findUniqueCourseByName(courses, activeCourse.name)
    if (unique?.id !== activeCourse.id) return []
    return notices.filter((notice) => notice.courseName?.trim() === activeCourse.name.trim())
  }, [activeCourse, courses, notices])

  const activeProgress = useMemo(
    () => (activeCourse ? getCourseProgress(activeCourse.id, chapters, points) : null),
    [activeCourse, chapters, points]
  )

  const activeDownloads = downloads.filter((item) => item.state === 'progressing').length
  const failedDownloads = countFailedDownloads(downloads)

  const nextUrgentTask = useMemo(
    () => courseTasks.find((task) => isTaskActionable(task)) ?? null,
    [courseTasks]
  )

  const toggleChapter = (id: string): void => {
    setExpandedChapterIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        if (activeCourse) recordStudyActivity(activeCourse.id, id)
      }
      return next
    })
  }

  const openOfficialDestination = async (
    course: Course,
    chapter: Chapter,
    destination: ChapterOfficialDestination
  ): Promise<void> => {
    if (!destination.url || destination.kind === 'none') return
    const persistedSection = destination.kind === 'section' ? destination.section : null
    recordStudyActivity(course.id, chapter.id, persistedSection)
    if (onOpenPortalUrl) {
      let message: string
      if (destination.kind === 'section' && destination.section) {
        const label = `${destination.section.number} ${destination.section.title}`.trim()
        message = `已在学习通打开小节「${label}」`
      } else if (destination.kind === 'chapter') {
        message = `已在学习通打开章节「${chapter.title}」`
      } else {
        message = `当前章节暂无直达地址，已在学习通打开课程页「${course.name}」`
      }
      onOpenPortalUrl(destination.url, message)
    } else {
      await onOpenChapter(course, chapter)
    }
  }

  const handleOpenChapterWorkflow = async (
    course: Course,
    chapter: Chapter,
    destination: ChapterOfficialDestination
  ): Promise<void> => {
    await openOfficialDestination(course, chapter, destination)
  }

  const handleOpenSectionWorkflow = (
    course: Course,
    chapter: Chapter,
    section: Chapter['sections'][number],
    sectionUrl: string
  ): void => {
    void openOfficialDestination(course, chapter, {
      kind: 'section',
      url: sectionUrl,
      section
    })
  }

  const handleResumeOfficial = (): void => {
    if (!activeCourse || !activeResumeTarget?.chapter) return
    void openOfficialDestination(
      activeCourse,
      activeResumeTarget.chapter,
      activeResumeTarget.destination
    )
  }

  const handleTogglePoint = async (point: StudyPoint): Promise<void> => {
    if (point.source === 'chaoxing') {
      notify('info', '学习通章节任务点进度由平台同步，请点击「去学习通学习」完成。')
      return
    }
    setPendingPointId(point.id)
    try {
      await onTogglePoint(point, point.status !== 'done')
      recordStudyActivity(point.courseId, point.chapterId)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setPendingPointId(null)
    }
  }

  const handleRetryActive = async (): Promise<void> => {
    if (!activeCourse || retrying) return
    setRetrying(true)
    try {
      await onRetryCourse(activeCourse)
    } finally {
      setRetrying(false)
    }
  }

  const officialUrl = activeCourse ? getCourseOfficialUrl(activeCourse) : null

  return (
    <div className="studio-course-shell">
      <aside className="course-rail" aria-label="课程列表">
        <div className="course-rail-top">
          <label className="course-rail-search">
            <Search size={13} />
            <input
              value={courseQuery}
              onChange={(event) => setCourseQuery(event.target.value)}
              placeholder="筛选课程…"
              aria-label="筛选课程"
            />
            {courseQuery ? (
              <button
                type="button"
                className="course-rail-clear"
                aria-label="清除搜索"
                onClick={() => setCourseQuery('')}
              >
                <X size={12} />
              </button>
            ) : null}
          </label>
          <div className="course-rail-filters">
            {semesterOptions.length > 1 ? (
              <select
                className="course-rail-select"
                aria-label="筛选课程学期"
                value={semester}
                onChange={(event) => setSemester(event.target.value)}
              >
                <option value="全部学期">全部学期</option>
                {semesterOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="course-rail-count">{filteredCourses.length} 门课程</span>
            )}
            <button
              type="button"
              className={favoritesOnly ? 'rail-pill active' : 'rail-pill'}
              aria-pressed={favoritesOnly}
              onClick={() => setFavoritesOnly((value) => !value)}
            >
              <Star size={11} fill={favoritesOnly ? 'currentColor' : 'none'} />
              收藏
            </button>
            <button
              type="button"
              className={attentionOnly ? 'rail-pill active' : 'rail-pill'}
              aria-pressed={attentionOnly}
              title="仅显示有未完成章节或待交作业的课程"
              onClick={() => setAttentionOnly((value) => !value)}
            >
              待处理
            </button>
          </div>
          {lastStudiedCourse && lastStudiedCourse.course.id !== activeCourse?.id ? (
            <button
              type="button"
              className="course-rail-resume"
              title={`回到上次学习的课程：${lastStudiedCourse.course.name}`}
              onClick={() => {
                setCourseQuery('')
                setSemester('全部学期')
                setFavoritesOnly(false)
                setAttentionOnly(false)
                handleSelectCourse(lastStudiedCourse.course.id)
                focusAndRevealChapter(lastStudiedCourse.record.chapterId)
              }}
            >
              <History size={12} aria-hidden="true" />
              <span className="course-rail-resume-name">
                继续上次：{lastStudiedCourse.course.name}
              </span>
            </button>
          ) : null}
        </div>

        <div className="course-rail-list">
          {filteredCourses.length === 0 ? (
            <div className="course-rail-empty">没有匹配的课程</div>
          ) : (
            filteredCourses.map((course) => {
              const stats = courseStatsMap.get(course.id)
              const isSelected = activeCourse?.id === course.id
              const isLastStudied = lastStudiedCourse?.course.id === course.id
              return (
                <button
                  key={course.id}
                  type="button"
                  data-course-id={course.id}
                  className={isSelected ? 'course-rail-item active' : 'course-rail-item'}
                  style={{ '--course-color': course.color } as CSSProperties}
                  onClick={() => handleSelectCourse(course.id)}
                >
                  <span className="course-rail-dot" aria-hidden="true" />
                  <span className="course-rail-info">
                    <span className="course-rail-name">
                      {course.name}
                      {course.favorite ? (
                        <Star size={10} className="course-rail-star" fill="currentColor" />
                      ) : null}
                    </span>
                    <span className="course-rail-sub">
                      {course.className
                        ? getCourseClassLabel(course)
                        : course.teacher || '未标注教师'}
                      {stats && stats.chapterCount > 0 && stats.progress !== null
                        ? ` · ${stats.progress}%`
                        : ''}
                      {isLastStudied ? (
                        <span className="course-rail-recent-tag"> · 上次学习</span>
                      ) : null}
                    </span>
                    {stats && stats.chapterCount > 0 && stats.progress !== null ? (
                      <span className="course-rail-progress" aria-hidden="true">
                        <span
                          className="course-rail-progress-fill"
                          style={{ width: `${stats.progress}%`, background: course.color }}
                        />
                      </span>
                    ) : null}
                  </span>
                  {stats && stats.pendingTasks > 0 ? (
                    <span className="course-rail-badge" title={`${stats.pendingTasks} 项待交作业`}>
                      {stats.pendingTasks}
                    </span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>

        <div className="course-rail-foot">
          <button
            type="button"
            className={showDownloads ? 'rail-downloads-btn active' : 'rail-downloads-btn'}
            onClick={() => setShowDownloads((open) => !open)}
          >
            <Download size={13} />
            <span>下载管理</span>
            {activeDownloads > 0 ? (
              <span className="course-rail-badge" title={`${activeDownloads} 项正在下载`}>
                {activeDownloads}
              </span>
            ) : failedDownloads > 0 ? (
              <span
                className="course-rail-badge danger"
                title={`${failedDownloads} 项下载失败或中断`}
              >
                {failedDownloads}
              </span>
            ) : downloads.length > 0 ? (
              <span className="rail-downloads-total">{downloads.length}</span>
            ) : null}
          </button>
        </div>
      </aside>

      <section
        className="course-stage"
        aria-label="课程工作台"
        style={
          activeCourse ? ({ '--course-color': activeCourse.color } as CSSProperties) : undefined
        }
      >
        {showDownloads ? (
          <div className="course-downloads-sheet">
            <div className="course-downloads-head">
              <h3>下载管理</h3>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setShowDownloads(false)}
              >
                <X size={13} /> 返回课程
              </button>
            </div>
            <DownloadQueue
              downloads={downloads}
              localFiles={localFiles}
              courses={courses}
              materials={materials}
              activeCourseId={activeCourse?.id ?? null}
              downloadDirectory={downloadDirectory}
              onLocateMaterial={handleLocateDownloadedMaterial}
              onRetryAllFailed={(courseId, items) => void handleRetryAllFailed(courseId, items)}
              onOpen={onOpenDownload}
              onReveal={onRevealDownload}
              onCancel={onCancelDownload}
              onRetry={onRetryDownload}
              onDelete={onDeleteDownload}
              onClear={onClearDownloads}
            />
          </div>
        ) : !activeCourse ? (
          <div className="course-stage-empty">
            <EmptyState
              icon={<BookOpen size={22} />}
              title="还没有课程数据"
              description="登录并同步学习通账号后，你的全部课程、章节进度、作业与课件会集中在这里。"
            />
          </div>
        ) : (
          <>
            <header
              className="course-hero"
              style={{ '--course-color': activeCourse.color } as CSSProperties}
            >
              <div className="course-hero-main">
                <div className="course-hero-title-row">
                  <span className="course-hero-swatch" aria-hidden="true" />
                  <h1 className="page-title course-hero-title">{activeCourse.name}</h1>
                  <button
                    type="button"
                    className={
                      activeCourse.favorite ? 'course-fav-toggle active' : 'course-fav-toggle'
                    }
                    aria-label={
                      activeCourse.favorite
                        ? `取消收藏 ${activeCourse.name}`
                        : `收藏 ${activeCourse.name}`
                    }
                    aria-pressed={activeCourse.favorite}
                    onClick={() => void onToggleFavorite(activeCourse)}
                  >
                    <Star size={14} fill={activeCourse.favorite ? 'currentColor' : 'none'} />
                  </button>
                </div>

                <div className="course-hero-meta">
                  <span>
                    <UserRound size={12} /> {activeCourse.teacher || '未标注教师'}
                  </span>
                  {activeCourse.semester ? <span>{activeCourse.semester}</span> : null}
                  {activeCourse.className ? <span>{activeCourse.className}</span> : null}
                  {activeCourse.schedule.slice(0, 2).map((session) => (
                    <span key={session.id} className="course-hero-slot">
                      <MapPin size={11} />
                      {WEEKDAY_LABELS[session.weekday]} {session.startTime}–{session.endTime}
                      {session.location ? ` · ${session.location}` : ''}
                    </span>
                  ))}
                </div>
              </div>

              <div className="course-hero-actions">
                {activeCourse.source === 'chaoxing' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleRetryActive()}
                    disabled={retrying}
                  >
                    <RefreshCw size={13} className={retrying ? 'spin' : undefined} />
                    {retrying ? '同步中…' : '刷新本课'}
                  </Button>
                ) : null}
                <Button
                  variant={officialUrl ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={!officialUrl}
                  title={
                    officialUrl ? '在应用内打开学习通课程页面' : '该课程暂无可靠的学习通官方入口'
                  }
                  onClick={() => onOpenOfficial(activeCourse)}
                >
                  <ExternalLink size={13} />
                  进入学习通课堂
                </Button>
              </div>
            </header>

            {activeResumeTarget &&
            (activeResumeTarget.chapter !== null || nextUrgentTask !== null) ? (
              <div className="course-resume-banner" role="region" aria-label="继续学习与下一步">
                <div className="course-resume-main">
                  <div className="course-resume-line">
                    <span
                      className={
                        activeResumeTarget.kind === 'all_done'
                          ? 'course-resume-tag done'
                          : activeResumeTarget.kind === 'browse_only' ||
                              activeResumeTarget.kind === 'locked_only' ||
                              activeResumeTarget.kind === 'empty'
                            ? 'course-resume-tag neutral'
                            : 'course-resume-tag'
                      }
                    >
                      {activeResumeTarget.kind === 'resume_recent'
                        ? '继续上次学习'
                        : activeResumeTarget.kind === 'resume_platform'
                          ? '继续学习'
                          : activeResumeTarget.kind === 'next_unfinished'
                            ? '下一未完成'
                            : activeResumeTarget.kind === 'locked_only'
                              ? '章节未解锁'
                              : activeResumeTarget.kind === 'all_done'
                                ? '已同步章节完成'
                                : '章节目录'}
                    </span>
                    {activeResumeTarget.chapter ? (
                      <span className="course-resume-title">
                        第 {String(activeResumeTarget.chapterIndex ?? 1).padStart(2, '0')} 章{' '}
                        {activeResumeTarget.chapter.title}
                        {activeResumeTarget.destination.kind === 'section' &&
                        activeResumeTarget.destination.section
                          ? ` · ${activeResumeTarget.destination.section.number ? `${activeResumeTarget.destination.section.number} ` : ''}${activeResumeTarget.destination.section.title}`
                          : ''}
                      </span>
                    ) : nextUrgentTask ? (
                      <span className="course-resume-title">待交作业：{nextUrgentTask.title}</span>
                    ) : null}
                  </div>
                  <div className="course-resume-sub">
                    {activeResumeTarget.lastActivityAt &&
                    (activeResumeTarget.kind === 'resume_recent' ||
                      activeResumeTarget.kind === 'resume_platform') ? (
                      <span>上次学习 {relativeTime(activeResumeTarget.lastActivityAt)}</span>
                    ) : null}
                    {activeResumeTarget.remainingPoints > 0 ? (
                      <span>
                        剩余 {activeResumeTarget.remainingPoints} 个任务点
                        {activeResumeTarget.remainingMinutes > 0
                          ? `（约 ${formatMinutes(activeResumeTarget.remainingMinutes)}）`
                          : ''}
                      </span>
                    ) : activeResumeTarget.sectionPendingCount > 0 ? (
                      <span>小节待完成 {activeResumeTarget.sectionPendingCount} 项</span>
                    ) : activeResumeTarget.kind === 'locked_only' ? (
                      <span>
                        仍有 {activeResumeTarget.lockedChapterCount} 章未解锁
                        {activeResumeTarget.lockedPendingCount > 0
                          ? `（含 ${activeResumeTarget.lockedPendingCount} 项待开放任务）`
                          : ''}
                      </span>
                    ) : activeResumeTarget.kind === 'browse_only' ? (
                      <span>暂无已识别的未完成任务点，可查看章节目录或进入官方课堂</span>
                    ) : activeResumeTarget.kind === 'all_done' ? (
                      <span>已同步的章节学习任务均已完成，可随时回顾</span>
                    ) : null}
                    {activeResumeTarget.unfinishedChapterCount > 1 ? (
                      <span>共 {activeResumeTarget.unfinishedChapterCount} 章未完成</span>
                    ) : null}
                    {activeResumeTarget.kind !== 'locked_only' &&
                    activeResumeTarget.lockedChapterCount > 0 ? (
                      <span>另有 {activeResumeTarget.lockedChapterCount} 章未解锁</span>
                    ) : null}
                    {activeResumeTarget.destination.kind === 'course' &&
                    activeResumeTarget.chapter ? (
                      <span>当前章节暂无直达链接，将打开所属课程页</span>
                    ) : null}
                    {nextUrgentTask ? (
                      <button
                        type="button"
                        className="course-resume-task-link"
                        onClick={() => onOpenTask(nextUrgentTask)}
                      >
                        <Clock3 size={11} aria-hidden="true" />
                        待交：{nextUrgentTask.title}（{formatRemainingCompact(nextUrgentTask.dueAt)}
                        ）
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="course-resume-actions">
                  {activeResumeTarget.chapter ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        recordStudyActivity(
                          activeCourse.id,
                          activeResumeTarget.chapter!.id,
                          activeResumeTarget.destination.kind === 'section'
                            ? activeResumeTarget.destination.section
                            : null
                        )
                        focusAndRevealChapter(activeResumeTarget.chapter!.id)
                      }}
                    >
                      <Compass size={12} /> 定位章节
                    </Button>
                  ) : null}
                  {activeResumeTarget.chapter ? (
                    <Button
                      variant={activeResumeTarget.officialUrl ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={!activeResumeTarget.officialUrl}
                      title={
                        activeResumeTarget.destination.kind === 'section'
                          ? '在学习通官方页面继续该小节'
                          : activeResumeTarget.destination.kind === 'chapter'
                            ? '在学习通官方页面打开该章节'
                            : activeResumeTarget.destination.kind === 'course'
                              ? '当前章节缺少直达地址，将在学习通打开所属课程页'
                              : '该章节及所属课程均缺少可用的学习通官方入口'
                      }
                      onClick={handleResumeOfficial}
                    >
                      <Play size={12} />{' '}
                      {activeResumeTarget.kind === 'locked_only'
                        ? activeResumeTarget.destination.kind === 'course'
                          ? '进入课程页查看'
                          : '去学习通查看'
                        : activeResumeTarget.destination.kind === 'course'
                          ? '打开课程页继续'
                          : '去学习通继续'}
                    </Button>
                  ) : nextUrgentTask ? (
                    <Button variant="secondary" size="sm" onClick={() => setActiveTab('tasks')}>
                      查看课程作业
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="course-tabs" role="tablist" aria-label="课程内容视图">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'chapters'}
                className={activeTab === 'chapters' ? 'course-tab active' : 'course-tab'}
                onClick={() => setActiveTab('chapters')}
              >
                <BookMarked size={13} />
                章节学习
                <span className="course-tab-count">{courseChapters.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'tasks'}
                className={activeTab === 'tasks' ? 'course-tab active' : 'course-tab'}
                onClick={() => setActiveTab('tasks')}
              >
                <FileText size={13} />
                课程作业
                <span className="course-tab-count">{courseTasks.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'materials'}
                className={activeTab === 'materials' ? 'course-tab active' : 'course-tab'}
                onClick={() => setActiveTab('materials')}
              >
                <Folder size={13} />
                课件资料
                <span className="course-tab-count">{allCourseMaterials.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'updates'}
                className={activeTab === 'updates' ? 'course-tab active' : 'course-tab'}
                onClick={() => setActiveTab('updates')}
              >
                <BellRing size={13} />
                考试与通知
                <span className="course-tab-count">
                  {courseExams.length + courseNotices.length}
                </span>
              </button>
            </div>

            <div className="course-tab-panel">
              {activeTab === 'chapters' ? (
                <div className="course-chapters-pane">
                  <div className="course-pane-bar">
                    <div className="course-progress-summary">
                      <span className="course-progress-pct">
                        {activeProgress?.percent !== null && activeProgress?.percent !== undefined
                          ? `${activeProgress.percent}%`
                          : activeProgress?.state === 'no_tasks'
                            ? '暂无任务点'
                            : '—'}
                      </span>
                      <div className="course-progress-bar">
                        <div
                          className="course-progress-fill"
                          style={{
                            width: `${activeProgress?.percent ?? 0}%`,
                            background: activeCourse.color
                          }}
                        />
                      </div>
                      <span className="course-progress-caption">
                        {activeProgress && activeProgress.total > 0
                          ? `已完成 ${activeProgress.done} / ${activeProgress.total} 个任务点${
                              unfinishedChapterCount > 0
                                ? ` · 剩余 ${unfinishedChapterCount} 章未完成`
                                : activeResumeTarget && activeResumeTarget.lockedChapterCount > 0
                                  ? ` · 另有 ${activeResumeTarget.lockedChapterCount} 章未解锁`
                                  : ''
                            }${
                              activeResumeTarget && activeResumeTarget.remainingMinutes > 0
                                ? ` · 约 ${formatMinutes(activeResumeTarget.remainingMinutes)}`
                                : ''
                            }`
                          : courseChapters.length > 0
                            ? `共 ${courseChapters.length} 章 · 暂无任务点${
                                activeResumeTarget && activeResumeTarget.sectionPendingCount > 0
                                  ? ` · 小节待完成 ${activeResumeTarget.sectionPendingCount} 项`
                                  : ''
                              }${
                                activeResumeTarget && activeResumeTarget.lockedChapterCount > 0
                                  ? ` · ${activeResumeTarget.lockedChapterCount} 章未解锁`
                                  : ''
                              }`
                            : '暂无章节'}
                      </span>
                    </div>
                    <div className="course-pane-tools">
                      {courseChapters.length > 0 ? (
                        <div className="course-filter-pills" role="group" aria-label="筛选章节状态">
                          <button
                            type="button"
                            className={chapterFilter === 'all' ? 'rail-pill active' : 'rail-pill'}
                            aria-pressed={chapterFilter === 'all'}
                            onClick={() => setChapterFilter('all')}
                          >
                            全部
                          </button>
                          <button
                            type="button"
                            className={
                              chapterFilter === 'incomplete' ? 'rail-pill active' : 'rail-pill'
                            }
                            aria-pressed={chapterFilter === 'incomplete'}
                            onClick={() => setChapterFilter('incomplete')}
                          >
                            未完成 {unfinishedChapterCount}
                          </button>
                        </div>
                      ) : null}
                      <label className="mini-search">
                        <Search size={12} />
                        <input
                          value={chapterQuery}
                          onChange={(event) => setChapterQuery(event.target.value)}
                          placeholder="搜索章节、小节或附件…"
                          aria-label="搜索章节"
                        />
                        {chapterQuery ? (
                          <button
                            type="button"
                            className="course-rail-clear"
                            aria-label="清除章节搜索"
                            onClick={() => setChapterQuery('')}
                          >
                            <X size={11} />
                          </button>
                        ) : null}
                      </label>
                      {courseChapters.length > 0 ? (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => {
                            const allOpen = courseChapters.every((ch) =>
                              expandedChapterIds.has(ch.id)
                            )
                            setExpandedChapterIds(
                              allOpen ? new Set() : new Set(courseChapters.map((ch) => ch.id))
                            )
                          }}
                        >
                          {courseChapters.every((ch) => expandedChapterIds.has(ch.id))
                            ? '全部折叠'
                            : '全部展开'}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {filteredChapters.length === 0 ? (
                    <EmptyState
                      compact
                      icon={<BookMarked size={18} />}
                      title={
                        courseChapters.length === 0
                          ? '该课程暂无同步章节'
                          : chapterFilter === 'incomplete' && !chapterQuery.trim()
                            ? activeResumeTarget?.kind === 'all_done'
                              ? '当前没有未完成章节'
                              : activeResumeTarget?.kind === 'locked_only'
                                ? '当前没有可继续的未完成章节'
                                : '当前没有已识别的未完成章节'
                            : '没有匹配的章节内容'
                      }
                      description={
                        courseChapters.length === 0
                          ? '可以直接点击右上角「进入学习通课堂」查看官方章节，或刷新本课同步。'
                          : chapterFilter === 'incomplete' && !chapterQuery.trim()
                            ? activeResumeTarget?.kind === 'all_done'
                              ? '已同步的章节学习任务都已完成，切换到「全部」可随时回顾。'
                              : activeResumeTarget?.kind === 'locked_only'
                                ? '当前仍有未解锁章节，尚未全部完成；切换到「全部」可查看锁定状态。'
                                : '已同步章节暂无未完成任务点或小节任务统计，切换到「全部」可查看完整目录。'
                            : '换一个关键词或切换章节筛选试试。'
                      }
                      action={
                        chapterQuery.trim() || chapterFilter !== 'all' ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setChapterQuery('')
                              setChapterFilter('all')
                            }}
                          >
                            {chapterFilter === 'incomplete' && !chapterQuery.trim()
                              ? '查看全部章节'
                              : '重置筛选'}
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <div className="studio-chapter-list">
                      {filteredChapters.map((chapter, idx) => {
                        const expanded =
                          chapterQuery.trim().length > 0 || expandedChapterIds.has(chapter.id)
                        const chPoints = pointsByChapter.get(chapter.id) ?? []
                        const donePoints = chPoints.filter((pt) => pt.status === 'done').length
                        const chPercent =
                          chPoints.length > 0
                            ? Math.round((donePoints / chPoints.length) * 100)
                            : null
                        const chSummary = chapterSummaryMap.get(chapter.id)
                        const hasChildren = chapter.sections.length > 0 || chPoints.length > 0
                        const chapterNumber = chapterIndexMap.get(chapter.id) ?? idx + 1
                        const chapterDestination = resolveChapterOfficialDestination(
                          activeCourse,
                          chapter,
                          {
                            chapterPoints: chPoints,
                            mode:
                              chSummary?.status === 'incomplete'
                                ? 'resume'
                                : chSummary?.status === 'locked'
                                  ? 'chapter_only'
                                  : 'review'
                          }
                        )
                        const chapterUrl = chapterDestination.url
                        return (
                          <div
                            key={chapter.id}
                            data-chapter-id={chapter.id}
                            className={[
                              'chapter-card',
                              'studio-chapter',
                              expanded ? 'expanded' : '',
                              focusedChapterId === chapter.id ? 'focused' : ''
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            <div className="studio-chapter-head">
                              <button
                                type="button"
                                className="chapter-toggle studio-chapter-toggle"
                                onClick={() => toggleChapter(chapter.id)}
                                aria-expanded={expanded}
                              >
                                <span className="studio-chapter-chev">
                                  {expanded ? (
                                    <ChevronDown size={14} />
                                  ) : (
                                    <ChevronRight size={14} />
                                  )}
                                </span>
                                <span className="studio-chapter-idx">
                                  {String(chapterNumber).padStart(2, '0')}
                                </span>
                                <span className="studio-chapter-title">{chapter.title}</span>
                              </button>
                              <div className="studio-chapter-right">
                                {chPoints.length > 0 ? (
                                  <span className="studio-chapter-meta-chip">
                                    {donePoints}/{chPoints.length}
                                  </span>
                                ) : chSummary && chSummary.sectionTotal > 0 ? (
                                  <span className="studio-chapter-meta-chip">
                                    {chSummary.sectionDone}/{chSummary.sectionTotal} 节
                                  </span>
                                ) : null}
                                <div className="progress-track studio-chapter-track">
                                  <div
                                    className="progress-fill"
                                    style={{
                                      width: `${chPercent ?? 0}%`,
                                      background: activeCourse.color
                                    }}
                                  />
                                </div>
                                <span className="studio-chapter-pct">
                                  {chPercent !== null ? `${chPercent}%` : '无任务点'}
                                </span>
                                <button
                                  type="button"
                                  className={
                                    chapterUrl
                                      ? 'chapter-open studio-action-pill'
                                      : 'chapter-open studio-action-pill is-disabled'
                                  }
                                  disabled={!chapterUrl}
                                  aria-disabled={!chapterUrl}
                                  title={
                                    chapterDestination.kind === 'section' &&
                                    chapterDestination.section
                                      ? `在学习通官方页面打开小节「${chapterDestination.section.number ? `${chapterDestination.section.number} ` : ''}${chapterDestination.section.title}」`
                                      : chapterDestination.kind === 'chapter'
                                        ? '在学习通官方页面打开该章节'
                                        : chapterDestination.kind === 'course'
                                          ? '当前章节缺少直达地址，将在学习通打开所属课程页'
                                          : '该章节及所属课程均缺少可用的学习通官方入口'
                                  }
                                  onClick={() =>
                                    void handleOpenChapterWorkflow(
                                      activeCourse,
                                      chapter,
                                      chapterDestination
                                    )
                                  }
                                >
                                  去学习 <ExternalLink size={11} />
                                </button>
                              </div>
                            </div>

                            {expanded && hasChildren ? (
                              <div className="chapter-body studio-chapter-body">
                                {chapter.sections.map((section, sIdx) => {
                                  const sectionUrl = !section.locked
                                    ? normalizePortalTargetUrl(section.sourceUrl)
                                    : null
                                  return (
                                    <div
                                      key={`${chapter.id}-sec-${section.number || sIdx}`}
                                      className="studio-section-row"
                                    >
                                      <div className="studio-section-main">
                                        <span
                                          className={
                                            section.completed
                                              ? 'studio-sec-icon done'
                                              : section.locked
                                                ? 'studio-sec-icon locked'
                                                : 'studio-sec-icon'
                                          }
                                        >
                                          {section.completed ? (
                                            <CheckCircle2 size={14} />
                                          ) : section.locked ? (
                                            <Lock size={13} />
                                          ) : (
                                            <Circle size={14} />
                                          )}
                                        </span>
                                        {section.number ? (
                                          <span className="studio-sec-num">{section.number}</span>
                                        ) : null}
                                        <span className="studio-sec-title">{section.title}</span>
                                        {section.pendingCount > 0 ? (
                                          <span className="studio-sec-pending">
                                            待完成 {section.pendingCount}
                                          </span>
                                        ) : null}
                                        {sectionUrl ? (
                                          <button
                                            type="button"
                                            className="studio-section-open"
                                            title="在学习通官方页面打开该小节"
                                            onClick={() =>
                                              handleOpenSectionWorkflow(
                                                activeCourse,
                                                chapter,
                                                section,
                                                sectionUrl
                                              )
                                            }
                                          >
                                            去学习 <ExternalLink size={10} />
                                          </button>
                                        ) : null}
                                      </div>
                                      {section.resources.length > 0 ? (
                                        <div className="studio-sec-resources">
                                          {section.resources.map((res, rIdx) => (
                                            <button
                                              key={`${res.objectId ?? res.name}-${rIdx}`}
                                              type="button"
                                              className="studio-resource-chip"
                                              onClick={() => {
                                                recordStudyActivity(
                                                  activeCourse.id,
                                                  chapter.id,
                                                  section
                                                )
                                                void onOpenResource(res)
                                              }}
                                            >
                                              <Paperclip size={11} />
                                              <span>{res.name}</span>
                                              {res.size ? <small>{res.size}</small> : null}
                                            </button>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  )
                                })}

                                {chPoints.map((point) => (
                                  <button
                                    key={point.id}
                                    type="button"
                                    className={
                                      point.status === 'done'
                                        ? 'study-point studio-point-row done'
                                        : 'study-point studio-point-row'
                                    }
                                    disabled={pendingPointId === point.id}
                                    onClick={() => void handleTogglePoint(point)}
                                  >
                                    <span className="studio-sec-icon">
                                      {point.status === 'done' ? (
                                        <CheckCircle2 size={14} />
                                      ) : (
                                        <Circle size={14} />
                                      )}
                                    </span>
                                    <span className="studio-sec-title">{point.title}</span>
                                    <span className="studio-point-meta">
                                      {STUDY_POINT_LABEL[point.kind]}
                                      {point.durationMinutes
                                        ? ` · ${formatMinutes(point.durationMinutes)}`
                                        : ''}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : activeTab === 'tasks' ? (
                <div className="course-tasks-pane">
                  <div className="course-pane-bar">
                    <div className="course-filter-pills" role="group" aria-label="筛选本课作业">
                      <button
                        type="button"
                        className={taskFilter === 'all' ? 'rail-pill active' : 'rail-pill'}
                        aria-pressed={taskFilter === 'all'}
                        onClick={() => setTaskFilter('all')}
                      >
                        全部 {courseTasks.length}
                      </button>
                      <button
                        type="button"
                        className={taskFilter === 'open' ? 'rail-pill active' : 'rail-pill'}
                        aria-pressed={taskFilter === 'open'}
                        onClick={() => setTaskFilter('open')}
                      >
                        待交 {openCourseTaskCount}
                      </button>
                      <button
                        type="button"
                        className={taskFilter === 'done' ? 'rail-pill active' : 'rail-pill'}
                        aria-pressed={taskFilter === 'done'}
                        onClick={() => setTaskFilter('done')}
                      >
                        已交与批阅 {doneCourseTaskCount}
                      </button>
                    </div>
                    {onCreateTaskForCourse ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onCreateTaskForCourse(activeCourse.id)}
                      >
                        <Plus size={13} /> 新建本课任务
                      </Button>
                    ) : null}
                  </div>
                  {courseTasks.length === 0 ? (
                    <EmptyState
                      compact
                      icon={<FileText size={18} />}
                      title="该课程目前没有作业"
                      description="同步到的学习通作业和本地创建的任务都会按紧迫度排列在这里。"
                      action={
                        onCreateTaskForCourse ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onCreateTaskForCourse(activeCourse.id)}
                          >
                            <Plus size={13} /> 新建本课任务
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : visibleCourseTasks.length === 0 ? (
                    <EmptyState
                      compact
                      icon={<FileText size={18} />}
                      title={taskFilter === 'open' ? '本课暂无待交作业' : '本课暂无已交或批阅记录'}
                      description="切换到「全部」可查看该课程所有作业记录。"
                      action={
                        <Button variant="secondary" size="sm" onClick={() => setTaskFilter('all')}>
                          查看全部作业
                        </Button>
                      }
                    />
                  ) : (
                    <div className="studio-flat-list">
                      {visibleCourseTasks.map((task) => {
                        const statusView = getTaskStatusView(task)
                        const scoreView = getTaskScoreView(task)
                        const portalAction = getTaskPortalAction(task, activeCourse)
                        const showPortalAction =
                          isPlatformTask(task) || portalAction.target !== null
                        const bucket = dueBucket(task)
                        return (
                          <div key={task.id} className="studio-work-row">
                            {statusView.canToggleLocal ? (
                              <button
                                type="button"
                                className={
                                  task.status === 'done' ? 'task-check checked' : 'task-check'
                                }
                                aria-label={task.status === 'done' ? '标记为待完成' : '标记为完成'}
                                onClick={() => onToggleTask(task)}
                              >
                                <CheckCircle2 />
                              </button>
                            ) : (
                              <span
                                className="task-check is-static"
                                title="学习通任务状态由平台同步"
                              >
                                <Circle />
                              </span>
                            )}
                            <button
                              type="button"
                              className="studio-work-main"
                              onClick={() => onOpenTask(task)}
                            >
                              <span className="studio-work-title">{task.title}</span>
                              <span className="studio-work-sub">
                                {TASK_KIND_LABEL[task.kind]}
                                {task.attachments.length > 0
                                  ? ` · ${task.attachments.length} 个附件`
                                  : ''}
                                {task.teacherFeedback ? ` · 批语：${task.teacherFeedback}` : ''}
                              </span>
                            </button>
                            <div className="studio-work-tail">
                              {scoreView.state === 'graded' ? (
                                <span className="studio-score-pill">{scoreView.text}</span>
                              ) : null}
                              {statusView.platformLabel ? (
                                <Badge
                                  tone={platformStatusTone(statusView.platformClass ?? 'unknown')}
                                  className={`platform-tag ${statusView.platformClass ?? 'unknown'}`}
                                >
                                  {statusView.platformLabel}
                                </Badge>
                              ) : null}
                              <span className={`studio-due-pill ${bucket}`}>
                                {formatRemainingCompact(task.dueAt)}
                              </span>
                              {showPortalAction ? (
                                <button
                                  type="button"
                                  className={
                                    portalAction.kind === 'answer'
                                      ? 'studio-action-pill primary'
                                      : portalAction.disabled
                                        ? 'studio-action-pill is-disabled'
                                        : 'studio-action-pill'
                                  }
                                  onClick={() => onOpenTaskInPortal(task)}
                                  disabled={portalAction.disabled}
                                  aria-disabled={portalAction.disabled}
                                  title={portalAction.title}
                                >
                                  {portalAction.label} <ExternalLink size={11} />
                                </button>
                              ) : null}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : activeTab === 'materials' ? (
                <div className="course-materials-pane">
                  <div className="course-pane-bar">
                    <div className="course-pane-tools">
                      <span className="course-progress-caption">
                        {courseMaterials.length === allCourseMaterials.length
                          ? `共 ${allCourseMaterials.length} 项资料`
                          : `显示 ${courseMaterials.length} / ${allCourseMaterials.length} 项`}
                      </span>
                      {materialKindCounts.activeKinds > 1 ? (
                        <div
                          className="course-filter-pills"
                          role="group"
                          aria-label="按资料类型筛选"
                        >
                          <button
                            type="button"
                            className={
                              materialKindFilter === 'all' ? 'rail-pill active' : 'rail-pill'
                            }
                            aria-pressed={materialKindFilter === 'all'}
                            onClick={() => setMaterialKindFilter('all')}
                          >
                            全部
                          </button>
                          {materialKindCounts.file > 0 ? (
                            <button
                              type="button"
                              className={
                                materialKindFilter === 'file' ? 'rail-pill active' : 'rail-pill'
                              }
                              aria-pressed={materialKindFilter === 'file'}
                              onClick={() => setMaterialKindFilter('file')}
                            >
                              文件 {materialKindCounts.file}
                            </button>
                          ) : null}
                          {materialKindCounts.folder > 0 ? (
                            <button
                              type="button"
                              className={
                                materialKindFilter === 'folder' ? 'rail-pill active' : 'rail-pill'
                              }
                              aria-pressed={materialKindFilter === 'folder'}
                              onClick={() => setMaterialKindFilter('folder')}
                            >
                              文件夹 {materialKindCounts.folder}
                            </button>
                          ) : null}
                          {materialKindCounts.link > 0 ? (
                            <button
                              type="button"
                              className={
                                materialKindFilter === 'link' ? 'rail-pill active' : 'rail-pill'
                              }
                              aria-pressed={materialKindFilter === 'link'}
                              onClick={() => setMaterialKindFilter('link')}
                            >
                              链接 {materialKindCounts.link}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {courseDownloadSummary.downloadableMaterialCount > 0 ? (
                        <div
                          className="course-filter-pills"
                          role="group"
                          aria-label="按下载状态筛选"
                        >
                          <button
                            type="button"
                            className={
                              materialDownloadFilter === 'undownloaded'
                                ? 'rail-pill active'
                                : 'rail-pill'
                            }
                            aria-pressed={materialDownloadFilter === 'undownloaded'}
                            onClick={() =>
                              setMaterialDownloadFilter((prev) =>
                                prev === 'undownloaded' ? 'all' : 'undownloaded'
                              )
                            }
                          >
                            未下载 {courseDownloadSummary.undownloadedMaterialCount}
                          </button>
                          <button
                            type="button"
                            className={
                              materialDownloadFilter === 'downloaded'
                                ? 'rail-pill active'
                                : 'rail-pill'
                            }
                            aria-pressed={materialDownloadFilter === 'downloaded'}
                            onClick={() =>
                              setMaterialDownloadFilter((prev) =>
                                prev === 'downloaded' ? 'all' : 'downloaded'
                              )
                            }
                          >
                            已下载 {courseDownloadSummary.downloadedMaterialCount}
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <div className="course-pane-tools">
                      {courseDownloadSummary.downloadableMaterialCount > 0 ? (
                        <button
                          type="button"
                          className={materialSelectMode ? 'rail-pill active' : 'rail-pill'}
                          aria-pressed={materialSelectMode}
                          onClick={() => {
                            setMaterialSelectMode((open) => {
                              if (open) setSelectedMaterialIds(new Set())
                              return !open
                            })
                          }}
                        >
                          {materialSelectMode ? '退出批量' : '批量选择'}
                        </button>
                      ) : null}
                      <label className="mini-search">
                        <Search size={12} />
                        <input
                          value={materialQuery}
                          onChange={(event) => setMaterialQuery(event.target.value)}
                          placeholder="搜索课件文件名…"
                          aria-label="搜索课件"
                        />
                        {materialQuery ? (
                          <button
                            type="button"
                            className="course-rail-clear"
                            aria-label="清除资料搜索"
                            onClick={() => setMaterialQuery('')}
                          >
                            <X size={11} />
                          </button>
                        ) : null}
                      </label>
                    </div>
                  </div>
                  {courseDownloadSummary.total > 0 ||
                  courseDownloadSummary.downloadedMaterialCount > 0 ||
                  activeDownloads > 0 ||
                  failedDownloads > 0 ? (
                    <div className="materials-download-strip" role="status" aria-live="polite">
                      <span className="materials-download-strip-text">
                        {courseDownloadSummary.active > 0
                          ? `本课 ${courseDownloadSummary.active} 项下载中`
                          : courseDownloadSummary.downloadedMaterialCount > 0
                            ? `本课已下载 ${courseDownloadSummary.downloadedMaterialCount} / ${courseDownloadSummary.downloadableMaterialCount} 项资料`
                            : '本课暂无本地已下载资料'}
                        {courseDownloadSummary.failed > 0
                          ? ` · ${courseDownloadSummary.failed} 项失败或中断`
                          : ''}
                      </span>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => setShowDownloads(true)}
                      >
                        打开下载管理
                        {activeDownloads > 0
                          ? `（${activeDownloads} 进行中）`
                          : failedDownloads > 0
                            ? `（${failedDownloads} 失败）`
                            : ''}
                      </button>
                    </div>
                  ) : null}
                  {activeBatchSummary && batchSession ? (
                    <div
                      className={
                        activeBatchSummary.retryableFailedMaterialIds.length > 0
                          ? 'materials-batch-summary has-failure'
                          : 'materials-batch-summary'
                      }
                      role="region"
                      aria-label="批量下载结果"
                    >
                      <div className="materials-batch-summary-main">
                        <strong>
                          {!activeBatchSummary.isSettled
                            ? `本批次传输中：已完成 ${activeBatchSummary.succeeded.length}，进行中 ${activeBatchSummary.transferring.length}`
                            : activeBatchSummary.cleared.length > 0 &&
                                activeBatchSummary.succeeded.length === 0 &&
                                activeBatchSummary.allFailedMaterialIds.length === 0
                              ? `本批次记录已清理（${activeBatchSummary.cleared.length} 项）`
                              : activeBatchSummary.allFailedMaterialIds.length > 0
                                ? `本批次结束：成功 ${activeBatchSummary.succeeded.length} 项`
                                : `本批次已完成：成功下载 ${activeBatchSummary.succeeded.length} 项`}
                        </strong>
                        {activeBatchSummary.dispatchFailed.length > 0 ? (
                          <span className="batch-summary-error">
                            发起失败 {activeBatchSummary.dispatchFailed.length} 项（
                            {activeBatchSummary.dispatchFailed.map((item) => item.name).join('、')}
                            ）
                          </span>
                        ) : null}
                        {activeBatchSummary.transferFailed.length > 0 ? (
                          <span className="batch-summary-error">
                            传输失败 {activeBatchSummary.transferFailed.length} 项（
                            {activeBatchSummary.transferFailed.map((item) => item.name).join('、')}
                            ）
                          </span>
                        ) : null}
                        {activeBatchSummary.cancelled.length > 0 ? (
                          <span>已取消 {activeBatchSummary.cancelled.length} 项</span>
                        ) : null}
                        {activeBatchSummary.cleared.length > 0 ? (
                          <span>记录已清理 {activeBatchSummary.cleared.length} 项</span>
                        ) : null}
                        {activeBatchSummary.allFailedMaterialIds.length > 0 &&
                        activeBatchSummary.retryableFailedMaterialIds.length === 0 ? (
                          <span>原失败项已恢复或正在下载</span>
                        ) : null}
                        {batchSession.skippedCompletedCount > 0 ? (
                          <span>已跳过 {batchSession.skippedCompletedCount} 项已有本地副本</span>
                        ) : null}
                      </div>
                      <div className="materials-batch-summary-actions">
                        {activeBatchSummary.retryableFailedMaterialIds.length > 0 ? (
                          <>
                            <button
                              type="button"
                              className="rail-pill"
                              onClick={() => {
                                setMaterialSelectMode(true)
                                setSelectedMaterialIds(
                                  new Set(activeBatchSummary.retryableFailedMaterialIds)
                                )
                                const firstFailedId =
                                  activeBatchSummary.retryableFailedMaterialIds[0]
                                if (firstFailedId && activeCourse) {
                                  handleLocateDownloadedMaterial(activeCourse.id, firstFailedId)
                                }
                              }}
                            >
                              选中失败项 ({activeBatchSummary.retryableFailedMaterialIds.length})
                            </button>
                            <button
                              type="button"
                              className="rail-pill active"
                              disabled={batchDownloading}
                              onClick={() => void handleRetryBatchFailed()}
                            >
                              <RotateCcw size={11} /> 重试本批失败 (
                              {activeBatchSummary.retryableFailedMaterialIds.length})
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="course-rail-clear"
                          aria-label="关闭批次结果提示"
                          onClick={() => setBatchSession(null)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {materialSelectMode ? (
                    <div className="materials-batch-bar" role="region" aria-label="批量下载工具栏">
                      <div className="materials-batch-info">
                        <strong>已选 {selectedMaterialIds.size} 项</strong>
                        {batchPlan.skippedCompleted.length > 0 ? (
                          <span>
                            其中 {batchPlan.skippedCompleted.length} 项已下载（默认跳过防重复）
                          </span>
                        ) : null}
                        {batchPlan.skippedInProgress.length > 0 ? (
                          <span>{batchPlan.skippedInProgress.length} 项下载中</span>
                        ) : null}
                      </div>
                      <div className="materials-batch-actions">
                        <button
                          type="button"
                          className="rail-pill"
                          disabled={visibleUndownloadedMaterials.length === 0}
                          onClick={() =>
                            setSelectedMaterialIds(
                              new Set(visibleUndownloadedMaterials.map((item) => item.id))
                            )
                          }
                        >
                          全选未下载 ({visibleUndownloadedMaterials.length})
                        </button>
                        <button
                          type="button"
                          className="rail-pill"
                          disabled={visibleDownloadableMaterials.length === 0}
                          onClick={() =>
                            setSelectedMaterialIds(
                              new Set(visibleDownloadableMaterials.map((item) => item.id))
                            )
                          }
                        >
                          全选可下载 ({visibleDownloadableMaterials.length})
                        </button>
                        {selectedMaterialIds.size > 0 ? (
                          <button
                            type="button"
                            className="rail-pill"
                            onClick={() => setSelectedMaterialIds(new Set())}
                          >
                            清空
                          </button>
                        ) : null}
                        {batchPlan.toDownload.length > 0 ? (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={batchDownloading}
                            onClick={() => void handleBatchDownload(false)}
                          >
                            <Download size={12} />
                            {batchDownloading
                              ? '正在发起…'
                              : `批量下载 (${batchPlan.toDownload.length})`}
                          </Button>
                        ) : batchPlan.skippedCompleted.length > 0 ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={batchDownloading}
                            onClick={() => void handleBatchDownload(true)}
                          >
                            <RotateCcw size={12} />
                            {batchDownloading
                              ? '正在发起…'
                              : `重新下载所选 (${batchPlan.skippedCompleted.length})`}
                          </Button>
                        ) : (
                          <Button variant="secondary" size="sm" disabled>
                            <Download size={12} /> 请先选择资料
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : null}
                  {courseMaterials.length === 0 ? (
                    <EmptyState
                      compact
                      icon={<Folder size={18} />}
                      title={
                        allCourseMaterials.length === 0
                          ? '暂无课程资料'
                          : materialDownloadFilter === 'downloaded' && !materialQuery.trim()
                            ? '本课还没有已下载资料'
                            : materialDownloadFilter === 'undownloaded' && !materialQuery.trim()
                              ? '本课可下载资料已全部下载'
                              : '没有匹配的资料'
                      }
                      description={
                        allCourseMaterials.length === 0
                          ? '老师上传在学习通资料栏中的课件、文档与链接会同步到这里。'
                          : materialDownloadFilter === 'downloaded' && !materialQuery.trim()
                            ? '下载后的课件会显示在这里，支持直接本地打开与定位目录。'
                            : materialDownloadFilter === 'undownloaded' && !materialQuery.trim()
                              ? '切换到「全部」或「已下载」可直接打开本地文件。'
                              : '试试调整关键词或清除类型与下载状态筛选。'
                      }
                      action={
                        allCourseMaterials.length > 0 ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setMaterialQuery('')
                              setMaterialKindFilter('all')
                              setMaterialDownloadFilter('all')
                            }}
                          >
                            重置筛选
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <div className="studio-flat-list">
                      {courseMaterials.map((item) => {
                        const target = materialTarget(item)
                        const previewKind = materialPreviewKind(item)
                        const opensInPortal = Boolean(target && normalizePortalTargetUrl(target))
                        const downloadable = canDownloadMaterial(item)
                        const folderUrl = materialFolderOpenUrl(item, officialUrl)
                        const dlState =
                          materialDownloadStateMap.get(item.id) ??
                          resolveMaterialDownloadState(item, downloads, localFiles)
                        const download = dlState.latest
                        const localFile = dlState.localFile
                        const hasLocalCopy = dlState.hasCompleted
                        const isDownloading = dlState.isDownloading
                        const isSelected = selectedMaterialIds.has(item.id)
                        const isFocused = focusedMaterialId === item.id
                        const Icon =
                          item.kind === 'folder' ? Folder : item.kind === 'link' ? Link2 : FileText
                        return (
                          <div
                            key={item.id}
                            data-material-id={item.id}
                            className={[
                              'materials-item',
                              'studio-material-row',
                              isSelected ? 'selected' : '',
                              isFocused ? 'focused' : ''
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            {materialSelectMode ? (
                              <input
                                type="checkbox"
                                className="materials-select-check"
                                checked={isSelected}
                                disabled={!downloadable}
                                aria-label={`选择 ${item.name}`}
                                title={
                                  downloadable
                                    ? `选择 ${item.name}`
                                    : '文件夹或非学习通官方链接不支持批量下载'
                                }
                                onChange={() => toggleMaterialSelected(item.id)}
                              />
                            ) : null}
                            <span className="studio-mat-icon">
                              <Icon size={15} />
                            </span>
                            <div
                              className="studio-work-main materials-main"
                              title={
                                previewKind === 'external'
                                  ? opensInPortal
                                    ? '该文件不支持应用内预览，将在学习通官方页面打开'
                                    : '该链接不在学习通域名，将在系统浏览器打开'
                                  : undefined
                              }
                            >
                              <span className="studio-work-title">{item.name}</span>
                              <span className="studio-work-sub">
                                {materialTypeLabel(item)}
                                {item.size ? ` · ${item.size}` : ''}
                                {item.updatedAt
                                  ? ` · ${formatOptionalDateTime(item.updatedAt)}`
                                  : ''}
                              </span>
                            </div>
                            <div className="studio-work-tail">
                              {download ? (
                                <span
                                  className={`download-inline-state ${download.state}`}
                                  title={
                                    download.state === 'completed' && !hasLocalCopy
                                      ? '历史下载记录已完成，但本地文件已被移动或删除，请重新下载'
                                      : downloadStateLabel(download)
                                  }
                                >
                                  {download.state === 'completed' && !hasLocalCopy
                                    ? '已完成 · 本地已移除'
                                    : downloadInlineText(download)}
                                </span>
                              ) : localFile ? (
                                <span
                                  className="download-inline-state completed"
                                  title={`本地已保存：${localFile.savePath}`}
                                >
                                  已下载 · {formatDownloadBytes(localFile.fileSize)}
                                </span>
                              ) : null}
                              {isDownloading && dlState.active ? (
                                <button
                                  type="button"
                                  className="studio-action-pill"
                                  onClick={() => onCancelDownload(dlState.active!)}
                                >
                                  <X size={11} /> 取消
                                </button>
                              ) : null}
                              {hasLocalCopy ? (
                                <>
                                  <button
                                    type="button"
                                    className={
                                      isDownloading
                                        ? 'studio-action-pill'
                                        : 'studio-action-pill primary'
                                    }
                                    aria-label={`打开已下载文件 ${item.name}`}
                                    onClick={() => {
                                      if (onOpenLocalMaterial) {
                                        onOpenLocalMaterial(item.id)
                                      } else if (dlState.completed) {
                                        onOpenDownload(dlState.completed)
                                      }
                                    }}
                                  >
                                    打开文件
                                  </button>
                                  <button
                                    type="button"
                                    className="studio-action-pill icon-only"
                                    title="打开所在文件夹"
                                    aria-label={`定位 ${item.name} 所在文件夹`}
                                    onClick={() => {
                                      if (onRevealLocalMaterial) {
                                        onRevealLocalMaterial(item.id)
                                      } else if (dlState.completed) {
                                        onRevealDownload(dlState.completed)
                                      }
                                    }}
                                  >
                                    <FolderOpen size={11} />
                                  </button>
                                </>
                              ) : null}
                              {dlState.canRetryLatest && download ? (
                                <button
                                  type="button"
                                  className="studio-action-pill"
                                  onClick={() => onRetryDownload(download)}
                                >
                                  <RotateCcw size={11} /> 重试
                                </button>
                              ) : null}
                              {item.kind === 'folder' ? (
                                <button
                                  type="button"
                                  className={
                                    folderUrl
                                      ? 'studio-action-pill'
                                      : 'studio-action-pill is-disabled'
                                  }
                                  disabled={!folderUrl}
                                  aria-disabled={!folderUrl}
                                  title={
                                    folderUrl
                                      ? '文件夹内容需在学习通官方页面浏览'
                                      : '缺少可用的学习通官方课程入口'
                                  }
                                  onClick={() => {
                                    if (!folderUrl) return
                                    if (onOpenPortalUrl) {
                                      onOpenPortalUrl(
                                        folderUrl,
                                        `已在官方页面打开目录，请查找「${item.name}」`
                                      )
                                    } else {
                                      onOpenOfficial(activeCourse)
                                    }
                                  }}
                                >
                                  <ExternalLink size={11} /> 官方页浏览
                                </button>
                              ) : null}
                              {target && previewKind !== 'none' ? (
                                <button
                                  type="button"
                                  className="studio-action-pill"
                                  aria-label={
                                    previewKind === 'external'
                                      ? opensInPortal
                                        ? `在官方页面打开 ${item.name}`
                                        : `在浏览器打开 ${item.name}`
                                      : `预览 ${item.name}`
                                  }
                                  title={
                                    previewKind === 'external'
                                      ? opensInPortal
                                        ? '该文件不支持应用内预览，将在学习通官方页面打开'
                                        : '该链接不在学习通域名，将在系统浏览器打开'
                                      : `预览 ${item.name}`
                                  }
                                  onClick={() => onPreviewMaterial(item)}
                                >
                                  {previewKind === 'external' ? (
                                    <>
                                      <ExternalLink size={11} />{' '}
                                      {opensInPortal ? '官方页打开' : '外部打开'}
                                    </>
                                  ) : (
                                    <>
                                      <Eye size={11} /> 预览
                                    </>
                                  )}
                                </button>
                              ) : null}
                              {downloadable ? (
                                <button
                                  type="button"
                                  className={
                                    isDownloading
                                      ? 'studio-action-pill is-disabled'
                                      : hasLocalCopy
                                        ? 'studio-action-pill'
                                        : 'studio-action-pill primary'
                                  }
                                  disabled={isDownloading}
                                  aria-disabled={isDownloading}
                                  aria-label={
                                    hasLocalCopy ? `重新下载 ${item.name}` : `下载 ${item.name}`
                                  }
                                  title={
                                    hasLocalCopy
                                      ? '该资料已有可用本地副本，点击将重新下载新副本'
                                      : `下载 ${item.name}`
                                  }
                                  onClick={() => onDownloadMaterial(item)}
                                >
                                  {hasLocalCopy ? (
                                    <>
                                      <RotateCcw size={11} />{' '}
                                      {isDownloading ? '下载中…' : '重新下载'}
                                    </>
                                  ) : (
                                    <>
                                      <Download size={11} /> {isDownloading ? '下载中…' : '下载'}
                                    </>
                                  )}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="course-updates-pane">
                  {courseExams.length === 0 && courseNotices.length === 0 ? (
                    <EmptyState
                      compact
                      icon={<BellRing size={18} />}
                      title={
                        ambiguousCourse
                          ? '存在多个同名教学班，请从跨课程视图查看'
                          : '暂无本课考试或通知'
                      }
                      description={
                        ambiguousCourse
                          ? '学习通的考试与通知记录仅提供课程名称而不含教学班 ID，为避免串班不在此处猜测归属。'
                          : '同步到该课程的考试安排与课程通知会显示在这里。'
                      }
                      action={
                        (exams.length > 0 && onViewAllExams) ||
                        (notices.length > 0 && onViewAllNotices) ? (
                          <div className="course-empty-actions">
                            {exams.length > 0 && onViewAllExams ? (
                              <Button variant="secondary" size="sm" onClick={onViewAllExams}>
                                <CalendarClock size={13} /> 查看全部考试（{exams.length}）
                              </Button>
                            ) : null}
                            {notices.length > 0 && onViewAllNotices ? (
                              <Button variant="secondary" size="sm" onClick={onViewAllNotices}>
                                <BellRing size={13} /> 打开通知收件箱（{notices.length}）
                              </Button>
                            ) : null}
                          </div>
                        ) : undefined
                      }
                    />
                  ) : (
                    <>
                      {courseExams.length > 0 ? (
                        <div className="studio-subblock">
                          <div className="studio-subhead-row">
                            <h3 className="studio-subhead">
                              <CalendarClock size={13} /> 考试安排
                            </h3>
                            {onViewAllExams ? (
                              <button type="button" className="text-link" onClick={onViewAllExams}>
                                跨课程考试总览
                              </button>
                            ) : null}
                          </div>
                          <div className="studio-flat-list">
                            {courseExams.map((exam) => (
                              <div key={exam.id} className="studio-work-row">
                                <div className="studio-work-main">
                                  <span className="studio-work-title">{exam.title}</span>
                                  <span className="studio-work-sub">
                                    {exam.startAt ? formatDateTime(exam.startAt) : '时间待确认'}
                                    {exam.endAt ? ` — ${formatDateTime(exam.endAt)}` : ''}
                                  </span>
                                </div>
                                <div className="studio-work-tail">
                                  {exam.score ? (
                                    <span className="studio-score-pill">{exam.score}</span>
                                  ) : null}
                                  {exam.examStatus ? (
                                    <Badge tone="neutral">{exam.examStatus}</Badge>
                                  ) : null}
                                  {exam.sourceUrl ? (
                                    <button
                                      type="button"
                                      className="studio-action-pill"
                                      onClick={() =>
                                        void window.studynext.app
                                          .openExternal(exam.sourceUrl!)
                                          .catch((error: unknown) =>
                                            notify('error', errorMessage(error))
                                          )
                                      }
                                    >
                                      官方页面 <ExternalLink size={11} />
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {courseNotices.length > 0 ? (
                        <div className="studio-subblock">
                          <div className="studio-subhead-row">
                            <h3 className="studio-subhead">
                              <BellRing size={13} /> 课程通知
                            </h3>
                            {onViewAllNotices ? (
                              <button
                                type="button"
                                className="text-link"
                                onClick={onViewAllNotices}
                              >
                                查看全部通知
                              </button>
                            ) : null}
                          </div>
                          <div className="studio-flat-list">
                            {courseNotices.map((notice) => (
                              <div key={notice.id} className="studio-work-row">
                                <div className="studio-work-main">
                                  <span className="studio-work-title">{notice.title}</span>
                                  {notice.body ? (
                                    <span className="studio-work-sub">{notice.body}</span>
                                  ) : null}
                                </div>
                                <div className="studio-work-tail">
                                  <span className="studio-due-pill">
                                    <Clock3 size={10} /> {relativeTime(notice.publishedAt)}
                                  </span>
                                  {notice.url ? (
                                    <button
                                      type="button"
                                      className="studio-action-pill"
                                      onClick={() =>
                                        void window.studynext.app
                                          .openExternal(notice.url!)
                                          .catch((error: unknown) =>
                                            notify('error', errorMessage(error))
                                          )
                                      }
                                    >
                                      原页 <ExternalLink size={11} />
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
