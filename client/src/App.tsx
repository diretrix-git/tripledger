import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './stores/authStore.js';
import { AppShell } from './components/layout/AppShell.js';
import { AuthPage } from './pages/AuthPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { CreateTripPage } from './pages/CreateTripPage.js';
import { TripListPage } from './pages/TripListPage.js';
import { TripDetailPage } from './pages/TripDetailPage.js';
import { MyBalancesPage } from './pages/MyBalancesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { PublicSharedReportPage } from './pages/PublicSharedReportPage.js';
import { VerifyEmailPage } from './pages/VerifyEmailPage.js';

function ProtectedRoute({ children }: { children: React.ReactElement }): React.ReactElement {
  const accessToken = useAuthStore((s) => s.accessToken);
  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

export function App(): React.ReactElement {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/shared/:shareToken" element={<PublicSharedReportPage />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route
          path="friends"
          element={
            <TripListPage
              filterMode="FRIENDS"
              title="Friends Mode Trips"
              subtitle="Individual expense management for road trips, college outings, and group activities."
            />
          }
        />
        <Route
          path="family"
          element={
            <TripListPage
              filterMode="FAMILY"
              title="Family Mode Trips"
              subtitle="Family groups, representatives, fixed packages, and dual-level settlements."
            />
          }
        />
        <Route path="trips/new" element={<CreateTripPage />} />
        <Route path="trips/:tripId" element={<TripDetailPage />} />
        <Route path="balances" element={<MyBalancesPage />} />
        <Route
          path="history"
          element={
            <TripListPage
              title="Trip History & Archive"
              subtitle="Complete ledger of all active and finalized trips."
            />
          }
        />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
