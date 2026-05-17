"use client";

import { Plus, LogOut } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import type { Session } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

type Props = {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
};

export function AppSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  creating,
}: Props) {
  const { email, logout } = useAuth();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center justify-between gap-2 px-1 py-2">
          <span className="font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Hydra DB
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onCreate}
            disabled={creating}
            aria-label="New session"
          >
            <Plus />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {sessions.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  No sessions yet. Click + to start.
                </div>
              )}
              {sessions.map((s) => {
                const title = s.title || `Session ${s.id.slice(0, 8)}`;
                return (
                  <SidebarMenuItem key={s.id}>
                    <SidebarMenuButton
                      isActive={s.id === activeSessionId}
                      onClick={() => onSelect(s.id)}
                      tooltip={title}
                    >
                      <span className="truncate">{title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center justify-between gap-2 px-1 py-1">
          <span
            className="text-xs text-muted-foreground truncate group-data-[collapsible=icon]:hidden"
            title={email ?? ""}
          >
            {email}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={logout}
            aria-label="Log out"
          >
            <LogOut />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
