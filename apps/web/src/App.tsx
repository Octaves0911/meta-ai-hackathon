import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { User } from '@meetpilot/shared';
import { api, SessionContext, storedUser, storeUser } from './lib/api';
import { Landing } from './routes/Landing';
import { GetStarted } from './routes/GetStarted';
import { Dashboard } from './routes/Dashboard';
import { MeetingDetail } from './routes/MeetingDetail';
import { Room } from './routes/Room';
import { Reviews } from './routes/Reviews';
import { Review } from './routes/Review';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // Restore the persisted username, dropping it if the account no longer exists.
  useEffect(() => {
    const name = storedUser();
    if (!name) return setReady(true);
    api<User[]>('/users')
      .then((list) => {
        const u = list.find((x) => x.username === name) ?? null;
        if (!u) storeUser(null);
        setUser(u);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const session = useMemo(() => ({ user, setUser }), [user]);
  if (!ready) return null;
  return (
    <SessionContext.Provider value={session}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/start" element={<GetStarted />} />
          <Route path="/dashboard/:panel?" element={<Dashboard />} />
          <Route path="/meetings/:id" element={<MeetingDetail />} />
          <Route path="/room/:id" element={<Room />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/reviews/:id" element={<Review />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionContext.Provider>
  );
}
