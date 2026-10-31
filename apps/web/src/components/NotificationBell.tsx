import * as Menu from '@radix-ui/react-dropdown-menu';
import { Bell, Bot, CalendarPlus, Inbox } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AppNotification } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';
import { Avatar, toast } from '../ui';

export function NotificationBell() {
  const { user } = useSession();
  const nav = useNavigate();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => api<AppNotification[]>('/notifications').then(setItems).catch(() => {}), []);

  useEffect(() => {
    if (!user) return;
    void load();
    const s = getSocket(user.username);
    const onNew = (n: AppNotification) => {
      setItems((l) => [n, ...l.filter((x) => x.id !== n.id)]);
      toast(n.type === 'invite' ? `${n.payload.invitedBy} invited you to ${n.payload.meetingTitle}` : `${n.payload.taskTitle} is ready for review`);
    };
    s.on('notification:new', onNew);
    return () => { s.off('notification:new', onNew); };
  }, [user, load]);

  const unread = items.filter((n) => !n.readAt).length;
  const markRead = async (n: AppNotification) => {
    await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    setItems((l) => l.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
  };
  const respond = async (n: AppNotification, accept: boolean) => {
    try {
      await api(`/meetings/${n.payload.meetingId}/respond`, { method: 'POST', json: { accept } });
      await markRead(n);
      if (accept) { setOpen(false); nav(`/meetings/${n.payload.meetingId}`); } else toast('Invitation declined');
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>
        <button className="ghost icon bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Bell size={19} />{unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu notif-panel" align="end" sideOffset={8} aria-label="Notifications">
          <div className="menu-label">Notifications</div>
          {items.length === 0 && <div className="empty" style={{ padding: '26px 12px' }}><div className="empty-icon" style={{ width: 44, height: 44 }}><Inbox size={20} /></div><p style={{ margin: 0 }}>You’re all caught up.</p></div>}
          {items.map((n) => (
            <div key={n.id} className={`notif${n.readAt ? '' : ' unread'}`}>
              {n.type === 'invite' ? (
                <>
                  <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <Avatar name={n.payload.invitedBy ?? '?'} size="sm" />
                    <div><div><strong>{n.payload.invitedBy}</strong> invited you to <strong>{n.payload.meetingTitle}</strong></div>
                      <div className="faint" style={{ fontSize: 12.5 }}><CalendarPlus size={12} style={{ verticalAlign: -2 }} /> {n.payload.projectName}{n.payload.scheduledAt ? ` · ${new Date(n.payload.scheduledAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ' · instant call'}</div></div>
                  </div>
                  {!n.readAt && <div className="row" style={{ gap: 8, marginTop: 6 }}><button className="primary mini" onClick={() => respond(n, true)}>Accept</button><button className="mini" onClick={() => respond(n, false)}>Decline</button></div>}
                </>
              ) : n.type === 'review_ready' ? (
                <Link to={`/reviews/${n.payload.executionId}`} onClick={() => { void markRead(n); setOpen(false); }} style={{ color: 'inherit' }}>
                  <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <span className="avatar sm" style={{ background: 'var(--ai)' }}><Bot size={13} /></span>
                    <div><div>The <strong>{n.payload.agent}</strong> agent finished <strong>{n.payload.taskTitle}</strong></div>
                      <div className="faint" style={{ fontSize: 12.5 }}>Ready for your review{n.payload.revision ? ` (revision ${n.payload.revision})` : ''}</div></div>
                  </div>
                </Link>
              ) : <div>{n.type}</div>}
            </div>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
