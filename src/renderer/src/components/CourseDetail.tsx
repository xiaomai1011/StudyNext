import { BookOpen, ExternalLink, GraduationCap, MapPin, Star, UserRound } from 'lucide-react'
import type { Course } from '@shared/types'
import { Modal } from './Modal'
import { courseInitial } from '../lib/format'

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

interface CourseDetailProps {
  course: Course
  onClose: () => void
  onToggleFavorite: () => void
  onOpenOfficial: () => void
}

export function CourseDetail({
  course,
  onClose,
  onToggleFavorite,
  onOpenOfficial
}: CourseDetailProps) {
  return (
    <Modal
      title="课程详情"
      subtitle={`${course.semester} · ${course.category}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn small" onClick={onToggleFavorite}>
            <Star size={14} fill={course.favorite ? 'currentColor' : 'none'} />
            {course.favorite ? '取消收藏' : '收藏课程'}
          </button>
          <span className="spacer" />
          <button type="button" className="btn small" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="btn primary small" onClick={onOpenOfficial}>
            <ExternalLink size={14} /> 官方页面
          </button>
        </>
      }
    >
      <div className="detail-hero">
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <div className="course-avatar" style={{ ['--course-color' as string]: course.color }}>
            {courseInitial(course.name)}
          </div>
          <div>
            <div className="detail-title">{course.name}</div>
            <div className="detail-meta">
              <span className="course-code">{course.code}</span>
              <span className="dot-separator" />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <UserRound size={12} /> {course.teacher}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-item">
          <div className="detail-item-label">学期</div>
          <div
            className="detail-item-value"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <GraduationCap size={13} /> {course.semester}
          </div>
        </div>
        <div className="detail-item">
          <div className="detail-item-label">课程分类</div>
          <div
            className="detail-item-value"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <BookOpen size={13} /> {course.category}
          </div>
        </div>
      </div>

      <div className="agenda-section-title" style={{ marginTop: 20 }}>
        上课安排
      </div>
      {course.schedule.length === 0 ? (
        <div className="mini-empty">暂无课表信息，可在导入课程后补充。</div>
      ) : (
        course.schedule.map((session) => (
          <div
            key={session.id}
            className="course-schedule-row"
            style={{
              padding: '9px 11px',
              background: 'var(--surface-muted)',
              borderRadius: 9,
              marginBottom: 6
            }}
          >
            <MapPin size={12} />
            <strong>{WEEKDAY_LABELS[session.weekday]}</strong>
            <span>
              {session.startTime} – {session.endTime}
            </span>
            <span className="dot-separator" />
            <span>{session.location}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 10 }}>
              {session.weeks}
            </span>
          </div>
        ))
      )}

      <div className="security-card" style={{ marginTop: 18 }}>
        <div className="security-title">
          <ExternalLink size={14} /> 官方页面入口
        </div>
        <p
          style={{
            margin: '7px 0 0',
            color: 'var(--text-faint)',
            fontSize: 10.5,
            lineHeight: 1.65
          }}
        >
          在隔离的内置浏览器视图中打开学习通官方课程页面。登录由你在官方页面手动完成，本应用不读取或保存密码。
        </p>
      </div>
    </Modal>
  )
}
