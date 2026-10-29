import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AppNotification } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';

export function NotificationBell() {
  const { user } = useSession();
  const nav = useNavigate();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api<AppNotification[]>('/notifications').then(setItems).catch(() => {}), []);

  useEffect(() => {
    if (!user) return;
    load();
    const s = getSocket(user.username);
    const onNew = (n: AppNotification) => setItems((l) => [n, ...l.filter((x) => x.id !== n.id)]);
    s.on('notification:new', onNew);
    return () => { s.off('notification:new', onNew); };
  }, [user, load]);

  const unread = items.filter((n) => !n.readAt).length;

  const markRead = async (n: AppNotification) => {
    await api(`/notifications/${n.id}/read`, { method: 'POST' });
    setItems((l) => l.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
  };

  const respond = async (n: AppNotification, accept: boolean) => {
    setError('');
    try {
      await api(`/meetings/${n.payload.meetingId}/respond`, { method: 'POST', json: { accept } });
      await markRead(n);
      if (accept) { setOpen(false); nav(`/meetings/${n.payload.meetingId}`); }
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(!open)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open}>
        🔔{unread > 0 && <span style={{ marginLeft: 6, background: 'var(--danger)', color: '#fff', borderRadius: 10, padding: '0 6px', fontSize: 12 }}>{unread}</span>}
      </button>
      {open && (
        <div className="card" role="region" aria-label="Notifications"
          style={{ position: 'absolute', right: 0, top: 48, width: 340, maxHeight: 420, overflow: 'auto', zIndex: 10 }}>
          {items.length === 0 && <p className="muted">No notifications.</p>}
          {items.map((n) => (
            <div key={n.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', opacity: n.readAt ? 0.6 : 1 }}>
              {n.type === 'invite' ? (
                <>
                  <div><strong>{n.payload.invitedBy}</strong> invited you to <strong>{n.payload.meetingTitle}</strong></div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {n.payload.projectName}{n.payload.scheduledAt ? ` · ${new Date(n.payload.scheduledAt).toLocaleString()}` : ' · instant call'}
                  </div>
                  {!n.readAt && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <button className="primary" onClick={() => respond(n, true)}>Accept</button>
                      <button onClick={() => respond(n, false)}>Decline</button>
                    </div>
                  )}
                </>
              ) : <div>{n.type}</div>}
            </div>
          ))}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
