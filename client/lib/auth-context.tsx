"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { clearSession, getEmail, getToken, setSession } from "@/lib/api";

type AuthState = {
  email: string | null;
  ready: boolean;
  authed: boolean;
  login: (token: string, email: string) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const token = getToken();
    const storedEmail = getEmail();
    if (token && storedEmail) setEmail(storedEmail);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const onLogin = pathname === "/login";
    if (!email && !onLogin) {
      router.replace("/login");
    } else if (email && onLogin) {
      router.replace("/");
    }
  }, [ready, email, pathname, router]);

  const login = (token: string, newEmail: string) => {
    setSession(token, newEmail);
    setEmail(newEmail);
  };

  const logout = () => {
    clearSession();
    setEmail(null);
    router.replace("/login");
  };

  return (
    <AuthContext.Provider
      value={{ email, ready, authed: !!email, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
