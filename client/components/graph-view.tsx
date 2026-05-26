"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  API_BASE,
  getToken,
  type GraphEdge,
  type GraphSnapshot,
} from "@/lib/api";

const NODE_W = 160;
const NODE_H = 40;

function layoutWithDagre(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 40,
    ranksep: 90,
    marginx: 30,
    marginy: 30,
  });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
    };
  });
}

type EntityNodeData = { label: string; degree: number; selected: boolean };

function EntityNode({ data }: NodeProps<Node<EntityNodeData>>) {
  return (
    <div
      className={
        "group flex items-center justify-center rounded-md border px-3 py-2 text-xs font-medium shadow-[0_1px_0_rgba(0,0,0,0.04)] transition-colors " +
        (data.selected
          ? "border-foreground bg-foreground text-background"
          : "border-foreground bg-background text-foreground hover:bg-foreground hover:text-background")
      }
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-none !bg-foreground"
      />
      <span className="truncate">{data.label}</span>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-none !bg-foreground"
      />
    </div>
  );
}

const nodeTypes = { entity: EntityNode };

type Props = {
  sessionId: string | null;
};

export function GraphView({ sessionId }: Props) {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "error">(
    "connecting"
  );
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    // Reset snapshot when the session scope changes so we don't show stale
    // edges from the previous session while the new stream is connecting.
    setSnapshot(null);

    const connect = () => {
      const token = getToken();
      if (!token) return;
      setStatus("connecting");
      const params = new URLSearchParams({ token });
      if (sessionId) params.set("sessionId", sessionId);
      es = new EventSource(`${API_BASE}/graph/stream?${params.toString()}`);

      es.addEventListener("graph", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as GraphSnapshot;
          setSnapshot(data);
          setStatus("live");
        } catch {
          // ignore
        }
      });

      es.onerror = () => {
        setStatus("error");
        es?.close();
        if (cancelled) return;
        reconnect = setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnect) clearTimeout(reconnect);
      es?.close();
    };
  }, [sessionId]);

  // If the selected node disappears from a new snapshot, clear selection.
  useEffect(() => {
    if (!selected || !snapshot) return;
    if (!snapshot.nodes.some((n) => n.id === selected)) setSelected(null);
  }, [snapshot, selected]);

  const { nodes, edges, degree } = useMemo(() => {
    if (!snapshot)
      return {
        nodes: [] as Node[],
        edges: [] as Edge[],
        degree: new Map<string, { incoming: number; outgoing: number }>(),
      };

    const deg = new Map<string, { incoming: number; outgoing: number }>();
    for (const n of snapshot.nodes) deg.set(n.id, { incoming: 0, outgoing: 0 });
    for (const e of snapshot.edges) {
      const fromDeg = deg.get(e.from) ?? { incoming: 0, outgoing: 0 };
      const toDeg = deg.get(e.to) ?? { incoming: 0, outgoing: 0 };
      fromDeg.outgoing++;
      toDeg.incoming++;
      deg.set(e.from, fromDeg);
      deg.set(e.to, toDeg);
    }

    const rawNodes: Node[] = snapshot.nodes.map((n) => {
      const d = deg.get(n.id) ?? { incoming: 0, outgoing: 0 };
      return {
        id: n.id,
        type: "entity",
        data: {
          label: n.name,
          degree: d.incoming + d.outgoing,
          selected: n.id === selected,
        },
        position: { x: 0, y: 0 },
      };
    });

    const rfEdges: Edge[] = snapshot.edges.map((e) => {
      const connected =
        selected !== null && (e.from === selected || e.to === selected);
      const dim = selected !== null && !connected;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.type,
        type: "smoothstep",
        animated: false,
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        labelStyle: {
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          fill: "var(--color-foreground)",
          opacity: dim ? 0.4 : 1,
        },
        labelBgStyle: {
          fill: "var(--color-background)",
          fillOpacity: dim ? 0.5 : 0.9,
        },
        style: {
          stroke: "var(--color-foreground)",
          strokeWidth: connected ? 1.5 : 1,
          opacity: dim ? 0.18 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "var(--color-foreground)",
          width: 14,
          height: 14,
        },
      };
    });

    return { nodes: layoutWithDagre(rawNodes, rfEdges), edges: rfEdges, degree: deg };
  }, [snapshot, selected]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelected((curr) => (curr === node.id ? null : node.id));
  }, []);

  const onPaneClick = useCallback(() => setSelected(null), []);

  const selectedEdges = useMemo(() => {
    if (!selected || !snapshot) return { outgoing: [], incoming: [] };
    const out: GraphEdge[] = [];
    const inc: GraphEdge[] = [];
    for (const e of snapshot.edges) {
      if (e.from === selected) out.push(e);
      else if (e.to === selected) inc.push(e);
    }
    // newest first
    out.sort((a, b) => b.tCommit.localeCompare(a.tCommit));
    inc.sort((a, b) => b.tCommit.localeCompare(a.tCommit));
    return { outgoing: out, incoming: inc };
  }, [selected, snapshot]);

  const selectedDeg = selected
    ? (degree.get(selected) ?? { incoming: 0, outgoing: 0 })
    : null;

  return (
    <div className="flex flex-col h-full min-h-0 border border-border rounded-lg bg-card">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex flex-col">
          <span className="text-sm font-medium">Knowledge graph</span>
          <span className="text-xs text-muted-foreground">
            {sessionId
              ? "Scoped to this session — click a node to inspect"
              : "All sessions — click a node to inspect"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span
            className={`size-1.5 rounded-full ${
              status === "live"
                ? "bg-foreground"
                : status === "connecting"
                  ? "bg-muted-foreground animate-pulse"
                  : "bg-destructive"
            }`}
          />
          {status === "live"
            ? `${nodes.length} nodes · ${edges.length} edges`
            : status === "connecting"
              ? "Connecting…"
              : "Disconnected"}
        </div>
      </div>

      <div className="flex-1 overflow-hidden relative">
        {snapshot && nodes.length === 0 ? (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            Graph is empty. Ingest a message to start building it.
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            nodesDraggable
            nodesConnectable={false}
            edgesFocusable={false}
            colorMode="light"
          >
            <Background gap={20} size={1} color="var(--color-border)" />
            <Controls
              showInteractive={false}
              className="!border-border !shadow-none"
            />
          </ReactFlow>
        )}

        {/* Inline slide-in details panel */}
        <aside
          className={
            "absolute top-0 right-0 h-full w-80 max-w-[90%] border-l border-border bg-card shadow-[ -8px_0_16px_-12px_rgba(0,0,0,0.15)] transition-transform duration-200 ease-out flex flex-col " +
            (selected ? "translate-x-0" : "translate-x-full")
          }
        >
          {selected && (
            <>
              <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-border">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Entity
                  </div>
                  <div className="text-sm font-semibold truncate" title={selected}>
                    {selected}
                  </div>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setSelected(null)}
                  aria-label="Close"
                >
                  <X />
                </Button>
              </div>

              <div className="px-4 py-2 border-b border-border flex items-center gap-3 text-[11px] font-mono text-muted-foreground">
                <span>↗ out {selectedDeg?.outgoing ?? 0}</span>
                <span>↘ in {selectedDeg?.incoming ?? 0}</span>
                <span>· total {(selectedDeg?.outgoing ?? 0) + (selectedDeg?.incoming ?? 0)}</span>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs">
                <RelationList
                  title="Outgoing"
                  empty="No outgoing relations."
                  edges={selectedEdges.outgoing}
                  arrow="→"
                  side="to"
                  onPick={(id) => setSelected(id)}
                />
                <RelationList
                  title="Incoming"
                  empty="No incoming relations."
                  edges={selectedEdges.incoming}
                  arrow="←"
                  side="from"
                  onPick={(id) => setSelected(id)}
                />
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function RelationList({
  title,
  empty,
  edges,
  arrow,
  side,
  onPick,
}: {
  title: string;
  empty: string;
  edges: GraphEdge[];
  arrow: string;
  side: "to" | "from";
  onPick: (id: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {title}
        <span className="ml-1 font-mono normal-case">({edges.length})</span>
      </div>
      {edges.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {edges.map((e) => {
            const other = side === "to" ? e.to : e.from;
            return (
              <li
                key={e.id}
                className="rounded-md border border-border bg-background px-2 py-1.5 hover:border-foreground transition-colors"
              >
                <div className="flex items-center gap-1 font-mono text-[11px]">
                  <span className="text-muted-foreground">{arrow}</span>
                  <span className="font-semibold text-foreground">{e.type}</span>
                  <span className="text-muted-foreground">{arrow}</span>
                  <button
                    type="button"
                    className="text-foreground underline-offset-2 hover:underline truncate text-left"
                    onClick={() => onPick(other)}
                    title={other}
                  >
                    {other}
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-muted-foreground">
                  {e.sentiment && <span>sentiment={e.sentiment}</span>}
                  {e.tValid && <span>t_valid={e.tValid}</span>}
                  <span>t_commit={e.tCommit}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
