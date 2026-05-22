import { useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  useNodesState,
  useEdgesState,
  Background,
  Controls,
  MiniMap,
  addEdge,
} from 'reactflow';
import 'reactflow/dist/style.css';

const NODE_TYPES = {};
const EDGE_TYPES = {};

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
      animated:    e.data.score >= 8,
      labelStyle:  { fontSize: 11, fontWeight: 700 },
      labelBgStyle:{ fill: '#fff', fillOpacity: 0.9 },
      style:       { ...e.style, stroke: e.data.score >= 7 ? '#6366f1' : '#9ca3af' },
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
