"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { apiFetch, type QueryResponse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Turn = {
  id: string;
  question: string;
  response?: QueryResponse;
  error?: string;
  loading: boolean;
};

const TIER_LABELS = ["Hot", "Warm", "Cold", "Stale"];

type Props = {
  sessionId: string | null;
};

export function RetrievePanel({ sessionId }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  const send = async () => {
    const q = text.trim();
    if (!q || sending) return;
    setSending(true);
    setText("");

    const id = `t-${Date.now()}`;
    setTurns((prev) => [...prev, { id, question: q, loading: true }]);

    try {
      const res = await apiFetch<QueryResponse>(`/query`, {
        method: "POST",
        body: JSON.stringify({
          query: q,
          ...(sessionId ? { sessionId } : {}),
        }),
      });
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, response: res, loading: false } : t
        )
      );
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, error: (err as Error).message, loading: false }
            : t
        )
      );
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 border border-border rounded-lg bg-card">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex flex-col">
          <span className="text-sm font-medium">Retrieve</span>
          <span className="text-xs text-muted-foreground">
            {sessionId
              ? "Asks Hydra what it remembers from this session"
              : "Pick a session to ask within it"}
          </span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {turns.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {sessionId
              ? "Memories are scoped to this session. The knowledge graph stays user-wide."
              : "No session selected — queries will hit all your sessions."}
          </p>
        )}
        {turns.map((t) => (
          <div key={t.id} className="space-y-2">
            <div className="ml-auto max-w-[85%] rounded-lg border border-border bg-foreground text-background px-3 py-2 text-sm">
              {t.question}
            </div>

            {t.loading && (
              <div className="text-xs text-muted-foreground font-mono">
                Searching memories…
              </div>
            )}

            {t.error && (
              <div className="text-xs text-destructive font-mono">
                {t.error}
              </div>
            )}

            {t.response && (
              <div className="space-y-2 max-w-[95%]">
                <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm whitespace-pre-wrap">
                  {t.response.answer}
                </div>
                <ResponseDetails response={t.response} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex gap-2 items-end">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything you've told Hydra…"
            disabled={sending}
            className="resize-none min-h-[3rem]"
          />
          <Button
            onClick={send}
            disabled={sending || !text.trim()}
            size="icon-lg"
            aria-label="Send"
          >
            <Send />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ResponseDetails({ response }: { response: QueryResponse }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        className="w-full px-3 py-1.5 text-left text-[11px] font-mono text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"} {response.candidates.length} memories ·{" "}
        {response.graphPaths.length} graph facts · {response.expansions.length}{" "}
        expansions
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 text-xs">
          {response.reasoning && (
            <Section title="Reasoning">
              <p className="whitespace-pre-wrap text-muted-foreground">
                {response.reasoning}
              </p>
            </Section>
          )}

          {response.expansions.length > 0 && (
            <Section title="Query expansions">
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                {response.expansions.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Section>
          )}

          {response.queryEntities.length > 0 && (
            <Section title="Query entities">
              <div className="flex flex-wrap gap-1">
                {response.queryEntities.map((e) => (
                  <span
                    key={e}
                    className="rounded border border-border px-1.5 py-0.5 text-[10px]"
                  >
                    {e}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {response.candidates.length > 0 && (
            <Section title="Memories used">
              <ol className="space-y-1.5">
                {response.candidates.map((c, i) => (
                  <li key={c.chunkId} className="space-y-0.5">
                    <div className="font-mono text-[10px] text-muted-foreground">
                      #{i + 1} · S={c.score.toFixed(3)} ·{" "}
                      {TIER_LABELS[c.tier] ?? "Hot"} ·{" "}
                      R={c.retentionScore.toFixed(2)}
                    </div>
                    <div className="text-foreground">{c.rawText}</div>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {response.graphPaths.length > 0 && (
            <Section title="Graph facts">
              <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {response.graphPaths.map((p, i) => (
                  <li key={i}>{p.contextString}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}
