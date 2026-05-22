import { useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  useNodesState,
  useEdgesState,
  Background,
  Controls,
  MiniMap,
  addEdge,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
} from 'reactflow';
import 'reactflow/dist/style.css';

const NODE_TYPES = {};

// Custom edge that renders the label as HTML (default React Flow edges render
// the label inside SVG <text>, so a span with `title` for hover-tooltip never
// renders). EdgeLabelRenderer portals the label into a positioned HTML overlay.
function BidirectionalEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, style, markerEnd,
}) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });
  const { scoreAB, scoreBA, nameAB, nameBA, score } = data || {};
  const hasBoth   = scoreAB != null && scoreBA != null;
  const labelText = hasBoth ? `${scoreAB} ⇄ ${scoreBA}` : String(score);
  const tooltip   = hasBoth
    ? `${nameAB} → ${nameBA}: ${scoreAB}\n${nameBA} → ${nameAB}: ${scoreBA}`
    : `Score: ${score}`;

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          title={tooltip}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '2px 7px',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--text-primary)',
            pointerEvents: 'all',
            cursor: 'help',
            whiteSpace: 'nowrap',
          }}
        >
          {labelText}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES = { bidirectional: BidirectionalEdge };

const TEAM_COLOR = {
  team_alpha: '#6366f1',
  team_beta:  '#f59e0b',
};

// Simple circular layout so nodes don't stack at (0,0)
function circularLayout(nodes) {
  const r = Math.max(200, nodes.length * 60);
  return nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    return { ...n, position: { x: r + r * Math.cos(angle), y: r + r * Math.sin(angle) } };
  });
}

export default function GraphView({ graphData, filterTeam }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (!graphData) return;

    let filteredNodes = graphData.nodes;
    let filteredEdges = graphData.edges;

    if (filterTeam) {
      const inTeam = n =>
        (n.data.teamIds && n.data.teamIds.includes(filterTeam)) || n.data.team === filterTeam;
      const teamIds = new Set(filteredNodes.filter(inTeam).map(n => n.id));
      // Strict: both endpoints must be in the team — no cross-team peers leak in.
      filteredEdges = filteredEdges.filter(e => teamIds.has(e.source) && teamIds.has(e.target));
      filteredNodes = filteredNodes.filter(n => teamIds.has(n.id));
    }

    const styledNodes = circularLayout(
      filteredNodes.map(n => ({
        ...n,
        style: {
          background:   TEAM_COLOR[n.data.team] || '#6b7280',
          color:        '#fff',
          borderRadius: 8,
          border:       'none',
          padding:      '8px 14px',
          fontWeight:   600,
          fontSize:     13,
        },
      }))
    );

    const styledEdges = filteredEdges.map(e => ({
      ...e,
      type:     'bidirectional',
      animated: e.data.score >= 8,
      style:    { ...e.style, stroke: e.data.score >= 7 ? '#6366f1' : '#9ca3af' },
    }));

    setNodes(styledNodes);
    setEdges(styledEdges);
  }, [graphData, filterTeam]);

  const onConnect = useCallback(params => setEdges(eds => addEdge(params, eds)), [setEdges]);

  if (!graphData) return <p style={{ color: '#6b7280', padding: 20 }}>Loading graph…</p>;

  return (
    <div style={{ height: 480, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        zoomOnScroll={false}
        preventScrolling={false}
        attributionPosition="bottom-right"
      >
        <Background gap={20} color="#f3f4f6" />
        <Controls />
        <MiniMap nodeColor={n => TEAM_COLOR[n.data?.team] || '#9ca3af'} />
      </ReactFlow>
    </div>
  );
}
