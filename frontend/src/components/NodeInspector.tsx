import React, { useState, useEffect, useRef } from 'react';
import type { GraphNode, GraphNodeConnection } from '../types/index';
import { NODE_COLORS } from '../types/index';

interface NodeInspectorProps {
  node: GraphNode;
  connections: GraphNodeConnection[];
  onClose: () => void;
}

export default function NodeInspector({ node, connections, onClose }: NodeInspectorProps) {
  const isCancellation = node.type === 'BillingCancellation';
  const color = NODE_COLORS[node.type] ?? '#CCCCCC';

  const [pos, setPos] = useState({ x: window.innerWidth > 800 ? window.innerWidth / 2 - 190 : 20, y: 20 });
  const isDragging = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleGlobalPointerDown = (e: PointerEvent) => {
      if (isDragging.current) return;
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay listener attach so the click that OPENED the inspector doesn't instantly close it
    const timerId = setTimeout(() => {
      window.addEventListener('pointerdown', handleGlobalPointerDown, true);
    }, 200);
    return () => {
      clearTimeout(timerId);
      window.removeEventListener('pointerdown', handleGlobalPointerDown, true);
    };
  }, [onClose]);

  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    startPos.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      setPos({ x: e.clientX - startPos.current.x, y: e.clientY - startPos.current.y });
    };
    const handleMouseUp = () => { isDragging.current = false; };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Filter out internal properties
  const displayProps = Object.entries(node.properties).filter(
    ([key]) => key !== 'labels' && key !== 'id'
  );

  return (
    <div 
      ref={modalRef}
      className="node-inspector" 
      id="node-inspector"
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
    >
      <div 
        className="inspector-header" 
        onMouseDown={handleMouseDown}
        style={{ cursor: 'grab' }}
      >
        <div className="inspector-type" style={{ color }}>
          <span className="type-dot" style={{ backgroundColor: color }}></span>
          {node.type}
          {isCancellation && <span className="cancelled-badge">CANCELLED</span>}
        </div>
        <button className="inspector-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>

      <div className="inspector-scroll-area">
        <div className="inspector-id">
          <span className="inspector-label">Entity ID:</span> <span className="entity-id-value">{node.id}</span>
        </div>

        <div className="inspector-section-title">Properties</div>
        <div className="inspector-props">
          {displayProps.map(([key, value]) => {
            const strVal = value === null || value === undefined
              ? ''
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value);

            if (!strVal) return null;

            return (
              <div key={key} className="prop-row">
                <span className="prop-key">{formatKey(key)}</span>
                <span className="prop-value" title={strVal}>
                  {strVal.length > 50 ? strVal.substring(0, 50) + '...' : strVal}
                </span>
              </div>
            );
          })}
        </div>

        <div className="inspector-section-title">
          Connections <span className="connection-count">{connections.length}</span>
        </div>

        {connections.length > 0 && (
          <div className="inspector-connections">
            {connections.slice(0, 30).map((c, idx) => (
              <div key={`${c.relType}-${c.neighbor.id}-${idx}`} className="connection-row">
                <span className="connection-rel">{c.relType}</span>
                <span className="connection-neighbor">
                  <span className="neighbor-type" style={{ color: NODE_COLORS[c.neighbor.type] || '#ccc' }}>{c.neighbor.type}</span>
                  <span className="neighbor-id">{c.neighbor.id}</span>
                </span>
              </div>
            ))}
            {connections.length > 30 && (
              <div className="connection-row connection-truncated">Showing first 30 connections...</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
