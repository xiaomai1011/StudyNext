import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react'
import {
  BrainCircuit,
  FileQuestion,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2
} from 'lucide-react'
import type {
  AiAnswer,
  AiConfig,
  Course,
  QuestionCard,
  QuestionInput,
  QuestionSource
} from '@shared/types'
import { QUESTION_SOURCE_LABEL } from '@shared/constants'
import { Modal } from '../components/Modal'
import type { ToastKind } from '../components/ToastStack'
import { errorMessage } from '../lib/format'

interface QuestionsProps {
  questions: QuestionCard[]
  courses: Course[]
  onCreate: (input: QuestionInput, source: QuestionSource) => Promise<QuestionCard>
  onUpdate: (id: string, input: QuestionInput) => Promise<QuestionCard>
  onRemove: (id: string) => Promise<void>
  onOpenSettings: () => void
  notify: (kind: ToastKind, message: string) => void
}

interface EditorState {
  card: QuestionCard | null
  source: QuestionSource
  question: string
  answer: string
  explanation: string
  courseId: string
  tags: string
}

const emptyEditor = (courseId = ''): EditorState => ({
  card: null,
  source: 'manual',
  question: '',
  answer: '',
  explanation: '',
  courseId,
  tags: ''
})

export function Questions({
  questions,
  courses,
  onCreate,
  onUpdate,
  onRemove,
  onOpenSettings,
  notify
}: QuestionsProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [courseId, setCourseId] = useState('all')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleting, setDeleting] = useState<QuestionCard | null>(null)
  const [saving, setSaving] = useState(false)
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null)
  const [aiQuestion, setAiQuestion] = useState('')
  const [aiCourseId, setAiCourseId] = useState('')
  const [aiAnswer, setAiAnswer] = useState<AiAnswer | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.studynext.ai
      .getConfig()
      .then((config) => {
        if (alive) setAiConfig(config)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return questions.filter((card) => {
      if (courseId !== 'all' && card.courseId !== courseId) return false
      if (!normalized) return true
      return (
        card.question.toLowerCase().includes(normalized) ||
        card.answer.toLowerCase().includes(normalized) ||
        card.tags.some((tag) => tag.toLowerCase().includes(normalized))
      )
    })
  }, [questions, query, courseId])

  const courseName = (id: string | null): string =>
    courses.find((course) => course.id === id)?.name ?? '未关联课程'

  const openCreate = (source: QuestionSource = 'manual'): void => {
    setEditor({ ...emptyEditor(aiCourseId || courses[0]?.id || ''), source })
  }

  const openEdit = (card: QuestionCard): void => {
    setEditor({
      card,
      source: card.source,
      question: card.question,
      answer: card.answer,
      explanation: card.explanation,
      courseId: card.courseId ?? '',
      tags: card.tags.join(', ')
    })
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!editor || saving) return
    if (!editor.question.trim()) {
      notify('error', '题目不能为空')
      return
    }
    const input: QuestionInput = {
      question: editor.question,
      answer: editor.answer,
      explanation: editor.explanation,
      courseId: editor.courseId || null,
      tags: editor.tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    }
    setSaving(true)
    try {
      if (editor.card) {
        await onUpdate(editor.card.id, input)
        notify('success', '题目卡已更新')
      } else {
        await onCreate(input, editor.source)
        notify('success', '题目卡已保存到本地')
      }
      setEditor(null)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    try {
      await onRemove(deleting.id)
      setDeleting(null)
      notify('success', '题目卡已删除')
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const askAi = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!aiQuestion.trim() || aiLoading) return
    setAiLoading(true)
    setAiError(null)
    setAiAnswer(null)
    try {
      const answer = await window.studynext.ai.ask({
        question: aiQuestion,
        courseId: aiCourseId || null
      })
      setAiAnswer(answer)
    } catch (error) {
      setAiError(errorMessage(error))
    } finally {
      setAiLoading(false)
    }
  }

  const saveAiAnswer = (): void => {
    if (!aiAnswer) return
    setEditor({
      ...emptyEditor(aiCourseId || courses[0]?.id || ''),
      source: 'ai',
      question: aiQuestion,
      answer: aiAnswer.answer
    })
  }

  return (
    <div className="page questions-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">QUESTION DESK</div>
          <h1 className="page-title">题目助手</h1>
          <p className="page-subtitle">
            整理题目、答案与解析；可选用你配置的 AI 服务生成解题思路。
          </p>
        </div>
        <div className="header-actions">
          <div className="search-box">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索题目、答案或标签"
              aria-label="搜索题目"
            />
          </div>
          <button type="button" className="btn primary" onClick={() => openCreate()}>
            <Plus size={16} /> 新建题目
          </button>
        </div>
      </header>

      <div className="question-layout">
        <section className="question-main">
          <div className="toolbar question-toolbar">
            <div className="segmented">
              <button
                type="button"
                className={courseId === 'all' ? 'active' : ''}
                onClick={() => setCourseId('all')}
              >
                全部题目
              </button>
              <span className="question-count">{questions.length} 张卡片</span>
            </div>
            <select
              className="select"
              value={courseId}
              onChange={(event) => setCourseId(event.target.value)}
              aria-label="按课程筛选题目"
            >
              <option value="all">全部课程</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </select>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state card">
              <div className="empty-icon">
                <FileQuestion />
              </div>
              <div className="empty-title">
                {questions.length ? '没有匹配的题目' : '题目本还是空的'}
              </div>
              <div className="empty-text">
                记录错题、课堂例题或 AI 生成的解题思路，之后可以按课程和标签复习。
              </div>
              <button type="button" className="btn primary" onClick={() => openCreate()}>
                <Plus size={16} /> 保存第一道题
              </button>
            </div>
          ) : (
            <div className="question-list">
              {filtered.map((card) => (
                <article className="card question-card" key={card.id}>
                  <div className="question-card-head">
                    <div className="question-card-meta">
                      <span className="course-tag">{courseName(card.courseId)}</span>
                      <span className={`source-badge ${card.source}`}>
                        {QUESTION_SOURCE_LABEL[card.source]}
                      </span>
                    </div>
                    <div className="question-card-actions">
                      <button
                        type="button"
                        className="btn icon-only ghost"
                        title="编辑题目"
                        aria-label="编辑题目"
                        onClick={() => openEdit(card)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        className="btn icon-only ghost danger-text"
                        title="删除题目"
                        aria-label="删除题目"
                        onClick={() => setDeleting(card)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                  <h3 className="question-title">{card.question}</h3>
                  {card.answer ? (
                    <div className="question-answer">
                      <span>答案</span>
                      <p>{card.answer}</p>
                    </div>
                  ) : (
                    <div className="question-answer empty">还没有填写答案</div>
                  )}
                  {card.explanation ? (
                    <div className="question-explanation">
                      <span>解析</span>
                      <p>{card.explanation}</p>
                    </div>
                  ) : null}
                  {card.tags.length ? (
                    <div className="question-tags">
                      {card.tags.map((tag) => (
                        <span className="tag" key={tag}>
                          #{tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="card ai-panel">
          <div className="ai-panel-head">
            <span className="ai-icon">
              <BrainCircuit size={18} />
            </span>
            <div>
              <div className="card-title">AI 解题助手</div>
              <div className="card-subtitle">使用你自己的 OpenAI 兼容服务</div>
            </div>
          </div>
          <div
            className={
              aiConfig?.enabled && aiConfig.hasApiKey
                ? 'sync-banner success'
                : 'sync-banner warning'
            }
          >
            {aiConfig?.enabled && aiConfig.hasApiKey
              ? `已启用 · ${aiConfig.model}`
              : aiConfig?.enabled
                ? '已启用，但还没有保存 API Key'
                : 'AI 助手未启用，前往设置配置'}
          </div>
          <form className="ai-form" onSubmit={(event) => void askAi(event)}>
            <label className="field">
              <span className="label">题目</span>
              <textarea
                className="textarea ai-textarea"
                value={aiQuestion}
                onChange={(event) => setAiQuestion(event.target.value)}
                placeholder="粘贴一道题，AI 会给出解题思路与结论…"
                maxLength={6000}
              />
            </label>
            <select
              className="select"
              value={aiCourseId}
              onChange={(event) => setAiCourseId(event.target.value)}
              aria-label="AI 题目所属课程"
            >
              <option value="">不关联课程</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </select>
            <div className="ai-form-actions">
              <button
                type="submit"
                className="btn primary"
                disabled={
                  aiLoading || !aiQuestion.trim() || !aiConfig?.enabled || !aiConfig.hasApiKey
                }
              >
                <Sparkles size={15} /> {aiLoading ? '思考中…' : '生成思路'}
              </button>
              <button type="button" className="btn ghost small" onClick={onOpenSettings}>
                配置 AI
              </button>
            </div>
          </form>
          {aiError ? <div className="inline-error">{aiError}</div> : null}
          {aiAnswer ? (
            <div className="ai-answer">
              <div className="ai-answer-head">
                <span>解答</span>
                <small>{aiAnswer.model}</small>
              </div>
              <p>{aiAnswer.answer}</p>
              <button type="button" className="btn ghost small" onClick={saveAiAnswer}>
                <MessageSquareText size={14} /> 存为题目卡
              </button>
            </div>
          ) : null}
          <p className="ai-disclaimer">
            AI 结果仅供参考，可能有误。应用不会自动提交作业或参加考试，也不会把 API Key 写入日志。
          </p>
        </aside>
      </div>

      {editor ? (
        <Modal
          title={editor.card ? '编辑题目卡' : '新建题目卡'}
          subtitle="答案与解析可以稍后补充；所有内容保存在本地 SQLite。"
          wide
          onClose={() => setEditor(null)}
          footer={
            <>
              <button type="button" className="btn ghost" onClick={() => setEditor(null)}>
                取消
              </button>
              <button type="submit" className="btn primary" form="question-form" disabled={saving}>
                {saving ? '保存中…' : '保存题目'}
              </button>
            </>
          }
        >
          <form id="question-form" className="question-form" onSubmit={(event) => void save(event)}>
            <div className="form-grid">
              <label className="field full">
                <span className="label">题目</span>
                <textarea
                  className="textarea"
                  value={editor.question}
                  onChange={(event) => setEditor({ ...editor, question: event.target.value })}
                  placeholder="输入题干…"
                  autoFocus
                />
              </label>
              <label className="field">
                <span className="label">关联课程</span>
                <select
                  className="select"
                  value={editor.courseId}
                  onChange={(event) => setEditor({ ...editor, courseId: event.target.value })}
                >
                  <option value="">不关联课程</option>
                  {courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="label">标签</span>
                <input
                  className="input"
                  value={editor.tags}
                  onChange={(event) => setEditor({ ...editor, tags: event.target.value })}
                  placeholder="高数, 极限, 错题（逗号分隔）"
                />
              </label>
              <label className="field full">
                <span className="label">答案</span>
                <textarea
                  className="textarea"
                  value={editor.answer}
                  onChange={(event) => setEditor({ ...editor, answer: event.target.value })}
                  placeholder="最终答案或结论…"
                />
              </label>
              <label className="field full">
                <span className="label">解析</span>
                <textarea
                  className="textarea"
                  value={editor.explanation}
                  onChange={(event) => setEditor({ ...editor, explanation: event.target.value })}
                  placeholder="解题步骤、关键知识点、易错点…"
                />
              </label>
            </div>
          </form>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title="删除题目卡"
          subtitle="此操作只删除本地记录，无法撤销。"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn ghost" onClick={() => setDeleting(null)}>
                取消
              </button>
              <button type="button" className="btn danger" onClick={() => void confirmDelete()}>
                删除
              </button>
            </>
          }
        >
          <p className="confirm-copy">确定删除「{deleting.question.slice(0, 60)}」吗？</p>
        </Modal>
      ) : null}
    </div>
  )
}
