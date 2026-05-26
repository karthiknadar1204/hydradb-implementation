"use client";

import { useCallback, useEffect, useState } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { IngestPanel } from "@/components/ingest-panel";
import { RetrievePanel } from "@/components/retrieve-panel";
import { GraphView } from "@/components/graph-view";
import { CreateSessionDialog } from "@/components/create-session-dialog";
import { apiFetch, type Session } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function HomePage() {
  const { ready, authed } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await apiFetch<{ sessions: Session[] }>(`/sessions`);
      setSessions(res.sessions);
      setActiveId((current) => {
        if (current && res.sessions.some((s) => s.id === current))
          return current;
        return res.sessions[0]?.id ?? null;
      });
    } catch {
      // ignore — auth context handles unauth
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    refreshSessions();
  }, [authed, refreshSessions]);

  const createSession = async (title: string) => {
    const res = await apiFetch<{ session: Session }>(`/sessions`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    setSessions((prev) => [res.session, ...prev]);
    setActiveId(res.session.id);
  };

  if (!ready || !authed) return null;

  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider>
        <AppSidebar
          sessions={sessions}
          activeSessionId={activeId}
          onSelect={setActiveId}
          onCreate={() => setCreateOpen(true)}
          creating={false}
        />
        <CreateSessionDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreate={createSession}
        />
        <main className="flex flex-1 flex-col min-w-0 h-svh">
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <SidebarTrigger />
            <span className="text-sm font-medium">
              {sessions.find((s) => s.id === activeId)?.title ??
                "No session selected"}
            </span>
            {activeId && (
              <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                {activeId}
              </span>
            )}
          </header>

          <div className="flex-1 grid grid-rows-[1fr_auto] gap-3 p-3 min-h-0">
            <div className="grid grid-cols-2 gap-3 min-h-0">
              <IngestPanel sessionId={activeId} />
              <RetrievePanel sessionId={activeId} />
            </div>
            <div className="h-[400px]">
              <GraphView sessionId={activeId} />
            </div>
          </div>
        </main>
      </SidebarProvider>
    </TooltipProvider>
  );
}
