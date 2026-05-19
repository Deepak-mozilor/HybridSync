import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import GraphView from './GraphView';

vi.mock('reactflow', () => ({
  default:        ({ children }) => <div data-testid="reactflow-canvas">{children}</div>,
  useNodesState:  () => [[], vi.fn(), vi.fn()],
  useEdgesState:  () => [[], vi.fn(), vi.fn()],
  Background:     () => null,
  Controls:       () => null,
  MiniMap:        () => null,
  addEdge:        vi.fn(),
}));

vi.mock('reactflow/dist/style.css', () => ({}));

const mockGraphData = {
  nodes: [
    { id: 'U001', data: { label: 'Deepak', team: 'team_alpha', role: 'employee' }, position: { x: 0, y: 0 } },
    { id: 'U002', data: { label: 'Jithu',  team: 'team_alpha', role: 'employee' }, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: 'U001-U002', source: 'U001', target: 'U002', label: '9', data: { score: 9 }, style: { strokeWidth: 3.6 } },
  ],
};

describe('GraphView', () => {
  it('shows loading message when graphData is null', () => {
    render(<GraphView graphData={null} filterTeam={null} />);
    expect(screen.getByText('Loading graph…')).toBeInTheDocument();
  });

  it('renders the React Flow canvas when data is provided', () => {
    render(<GraphView graphData={mockGraphData} filterTeam={null} />);
    expect(screen.getByTestId('reactflow-canvas')).toBeInTheDocument();
  });

  it('renders without crashing when filterTeam is set', () => {
    render(<GraphView graphData={mockGraphData} filterTeam="team_alpha" />);
    expect(screen.getByTestId('reactflow-canvas')).toBeInTheDocument();
  });

  it('renders without crashing for an empty graph', () => {
    const empty = { nodes: [], edges: [] };
    render(<GraphView graphData={empty} filterTeam={null} />);
    expect(screen.getByTestId('reactflow-canvas')).toBeInTheDocument();
  });
});
