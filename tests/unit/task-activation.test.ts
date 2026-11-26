import { describe, expect, it } from 'vitest'
import {
  buildReminderToastXml,
  buildTaskActivationUri,
  parseTaskActivationArgument,
  TASK_ACTIVATION_PROTOCOL
} from '../../src/shared/task-activation'

describe('task activation protocol', () => {
  it('parses the legacy flag and protocol URLs', () => {
    expect(parseTaskActivationArgument(['--focus-task', 'task-1'])).toBe('task-1')
    expect(parseTaskActivationArgument(['--focus-task=task-2'])).toBe('task-2')
    expect(parseTaskActivationArgument([`${TASK_ACTIVATION_PROTOCOL}://task/task-3`])).toBe(
      'task-3'
    )
    expect(parseTaskActivationArgument([`${TASK_ACTIVATION_PROTOCOL}://task?id=task-4`])).toBe(
      'task-4'
    )
    expect(
      parseTaskActivationArgument([
        `${TASK_ACTIVATION_PROTOCOL}://task/${encodeURIComponent('任务/5')}`
      ])
    ).toBe('任务/5')
    const reorderedTaskId = '5ec01b06-2738-4745-9133-ef3faf45f194'
    expect(
      parseTaskActivationArgument([
        '--focus-task',
        '--allow-file-access-from-files',
        '--source-app-id',
        '.',
        reorderedTaskId
      ])
    ).toBe(reorderedTaskId)
    expect(
      parseTaskActivationArgument(['--focus-task', '--allow-file-access-from-files', '.'])
    ).toBeNull()
  })

  it('rejects malformed or unrelated arguments', () => {
    expect(parseTaskActivationArgument([])).toBeNull()
    expect(parseTaskActivationArgument(['--focus-task'])).toBeNull()
    expect(parseTaskActivationArgument(['--focus-task', 'x'.repeat(201)])).toBeNull()
    expect(parseTaskActivationArgument(['https://task/task-1'])).toBeNull()
    expect(parseTaskActivationArgument([`${TASK_ACTIVATION_PROTOCOL}://other/task-1`])).toBeNull()
    expect(parseTaskActivationArgument([`${TASK_ACTIVATION_PROTOCOL}://task/`])).toBeNull()
  })

  it('builds a toast whose only payload is a local task ID', () => {
    const xml = buildReminderToastXml({
      title: '学习<提醒>',
      body: '作业 & 截止',
      taskId: 'task-1',
      iconPath: 'file:///C:/StudyNext/icon.png'
    })
    expect(xml).toContain('activationType="protocol"')
    expect(xml).toContain('launch="studynext://task/task-1"')
    expect(xml).toContain('学习&lt;提醒&gt;')
    expect(xml).toContain('作业 &amp; 截止')
    expect(xml).not.toMatch(/cookie|token|https?:\/\//i)
    expect(buildTaskActivationUri('task-1')).toBe('studynext://task/task-1')
  })
})
