import { useCallback, useRef, useMemo, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphNode } from '../types/index';
import { NODE_COLORS } from '../types/index';

interface GraphViewProps {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string; type: string }>;
  highlightedNodes: string[];
  onNodeClick: (node: GraphNode) => void;
}

interface ForceNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
  x?: number;
  y?: number;
}

interface ForceLink {
  source: string | ForceNode;
  target: string | ForceNode;
  type: string;
}

export default function GraphView({ nodes, edges, highlightedNodes, onNodeClick }: GraphViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const containerRef = useRef<HTMLDivElement>(null);
  // Using 'any' for fgRef since react-force-graph types don't fully expose d3Force methods cleanly
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  useEffect(() => {
    function handleResize() {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    }
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const highlightSet = useMemo(() => new Set(highlightedNodes), [highlightedNodes]);
  const searchLower = searchTerm.toLowerCase();

  const graphData = useMemo(() => {
    const forceNodes: ForceNode[] = nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      properties: n.properties,
    }));
    const forceLinks: ForceLink[] = edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
    }));
    return { nodes: forceNodes, links: forceLinks };
  }, [nodes, edges]);

  // Adjust physics to prevent overlap but keep things together
  useEffect(() => {
    if (fgRef.current && graphData.nodes.length > 0) {
      fgRef.current.d3Force('link').distance(40);
      // Reduce repulsion distance so disconnected clusters don't repel each other indefinitely
      fgRef.current.d3Force('charge').strength(-50).distanceMax(200);
    }
  }, [graphData]);

  const nodeColor = useCallback((node: ForceNode) => {
    if (highlightSet.has(node.id)) return '#FF8C00';
    if (searchLower && (node.id.toLowerCase().includes(searchLower) || node.type.toLowerCase().includes(searchLower))) {
      return '#FFD700';
    }
    return NODE_COLORS[node.type] ?? '#CCCCCC';
  }, [highlightSet, searchLower]);

  const nodeSize = useCallback((node: ForceNode) => {
    if (highlightSet.has(node.id)) return 8;
    if (searchLower && node.id.toLowerCase().includes(searchLower)) return 7;
    return 4;
  }, [highlightSet, searchLower]);

  const handleNodeClick = useCallback((node: ForceNode) => {
    onNodeClick({
      id: node.id,
      label: node.label,
      type: node.type,
      properties: node.properties,
    });
  }, [onNodeClick]);

  const nodeLabel = useCallback((node: ForceNode) => {
    return `${node.type}: ${node.id}`;
  }, []);

  return (
    <div className="graph-view" ref={containerRef}>
      <div className="graph-search">
        <input
          type="text"
          placeholder="Search nodes by ID or type..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="graph-search-input"
          id="graph-search"
        />
        <div className="graph-legend">
          {['Customer', 'SalesOrder', 'DeliveryHeader', 'BillingHeader', 'Product', 'Plant', 'Payment'].map((type) => (
            <span key={type} className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: NODE_COLORS[type] }}></span>
              <span className="legend-label">{type}</span>
            </span>
          ))}
        </div>
      </div>
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height - 60}
        nodeColor={nodeColor as (node: object) => string}
        nodeVal={nodeSize as (node: object) => number}
        nodeLabel={nodeLabel as (node: object) => string}
        linkColor={() => 'rgba(255,255,255,0.15)'}
        linkWidth={0.5}
        onNodeClick={handleNodeClick as (node: object) => void}
        enableNodeDrag={true}
        cooldownTime={3000}
        backgroundColor="rgba(0,0,0,0)"
        nodeCanvasObjectMode={() => 'after'}
        nodeCanvasObject={(node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const n = node as ForceNode;
          if (globalScale > 2 || highlightSet.has(n.id)) {
            const fontSize = Math.max(10 / globalScale, 2);
            ctx.font = `${fontSize}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillStyle = highlightSet.has(n.id) ? '#FF8C00' : 'rgba(255,255,255,0.7)';
            ctx.fillText(n.id, n.x ?? 0, (n.y ?? 0) + 8 / globalScale);
          }
        }}
      />
    </div>
  );
}
