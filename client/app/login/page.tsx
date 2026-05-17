"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AuthResponse = {
  token: string;
  user: { id: string; email: string };
};

export default function LoginPage() {
  const { login, ready, authed } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!ready || authed) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const path = mode === "login" ? "/auth/login" : "/auth/signup";
      const res = await apiFetch<AuthResponse>(path, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      login(res.token, res.user.email);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 border border-border rounded-xl p-8 bg-card">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Hydra DB</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "login" ? "Sign in to continue" : "Create an account"}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={loading}
          >
            {loading
              ? "Please wait…"
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </Button>
        </form>

        <button
          type="button"
          className="w-full text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(null);
          }}
        >
          {mode === "login"
            ? "Don't have an account? Sign up"
            : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
