import type { Task } from '@meetpilot/shared';

/** Tasks joined with the display names of assignee and assigner; due_date rendered as plain YYYY-MM-DD. */
export const TASK_SELECT = `select t.*, to_char(t.due_date, 'YYYY-MM-DD') as due, ua.username as assignee_name, ub.username as assigner_name
  from tasks t left join users ua on ua.id = t.assigned_to left join users ub on ub.id = t.assigned_by`;

export const toTask = (r: any): Task => ({
  id: r.id, meetingId: r.meeting_id, title: r.title, description: r.description,
  assignedTo: r.assigned_to ? { id: r.assigned_to, username: r.assignee_name } : null,
  assignedBy: r.assigned_by ? { id: r.assigned_by, username: r.assigner_name } : null,
  dueDate: r.due, status: r.status, finalized: r.finalized, createdAt: r.created_at,
});
