"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { apiFetch, type Message } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  sessionId: string | null;
};

type Entry =
  | { kind: "message"; id: string; content: string; createdAt: string }
  | { kind: "status"; id: string; text: string; ok: boolean };

export function IngestPanel({ sessionId }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Hydrate existing messages whenever session changes.
  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ messages: Message[] }>(
          `/sessions/${sessionId}/messages`
        );
        if (cancelled) return;
        setEntries(
          res.messages.map((m) => ({
            kind: "message" as const,
            id: m.id,
            content: m.content,
            createdAt: m.createdAt,
          }))
        );
      } catch {
        if (!cancelled) setEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [entries]);

  const send = async () => {
    const message = text.trim();
    if (!message || !sessionId || sending) return;
    setSending(true);
    setText("");

    const optimistic: Entry = {
      kind: "message",
      id: `tmp-${Date.now()}`,
      content: message,
      createdAt: new Date().toISOString(),
    };
    setEntries((prev) => [...prev, optimistic]);

    try {
      const res = await apiFetch<{ chunkId: string }>(
        `/sessions/${sessionId}/ingest`,
        {
          method: "POST",
          body: JSON.stringify({ message }),
        }
      );
      setEntries((prev) => [
        ...prev,
        {
          kind: "status",
          id: `s-${res.chunkId}`,
          text: `Queued for enrichment · chunk ${res.chunkId.slice(0, 8)}`,
          ok: true,
        },
      ]);
    } catch (err) {
      setEntries((prev) => [
        ...prev,
        {
          kind: "status",
          id: `e-${Date.now()}`,
          text: (err as Error).message,
          ok: false,
        },
      ]);
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
          <span className="text-sm font-medium">Ingest</span>
          <span className="text-xs text-muted-foreground">
            Send a message to be remembered
          </span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {!sessionId && (
          <p className="text-xs text-muted-foreground">
            Select or create a session to begin.
          </p>
        )}
        {entries.map((entry) =>
          entry.kind === "message" ? (
            <div
              key={entry.id}
              className="ml-auto max-w-[85%] rounded-lg border border-border bg-foreground text-background px-3 py-2 text-sm"
            >
              {entry.content}
            </div>
          ) : (
            <div
              key={entry.id}
              className={`text-[11px] font-mono ${entry.ok ? "text-muted-foreground" : "text-destructive"}`}
            >
              {entry.text}
            </div>
          )
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex gap-2 items-end">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              sessionId
                ? "Tell Hydra something to remember…"
                : "Pick a session first"
            }
            disabled={!sessionId || sending}
            className="resize-none min-h-[3rem]"
          />
          <Button
            onClick={send}
            disabled={!sessionId || sending || !text.trim()}
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
