import React, { useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import GraphView from './components/GraphView';
import ChatPanel from './components/ChatPanel';
import NodeInspector from './components/NodeInspector';
import AdminPanel from './components/AdminPanel';
import { fetchNodeDetails, useGraph } from './hooks/useGraph';
import { useChat } from './hooks/useChat';
import type { GraphNode, GraphNodeDetails } from './types/index';
import './index.css';

function MainView() {
  const { graphData, loading, error } = useGraph();
  const { messages, isLoading, sendMessage, highlightedNodes } = useChat();
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [nodeDetails, setNodeDetails] = useState<GraphNodeDetails | null>(null);
  
  // Chat Resizing Logic
  const [chatWidth, setChatWidth] = useState(420);
  const isResizing = React.useRef(false);

  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= 250 && newWidth <= 800) {
        setChatWidth(newWidth);
      }
    };
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleCloseInspector = useCallback(() => {
    setSelectedNode(null);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selectedNode) {
        setNodeDetails(null);
        return;
      }
      const details = await fetchNodeDetails(selectedNode.id);
      if (cancelled) return;
      setNodeDetails(details);
    }
    load().catch(() => {
      if (!cancelled) setNodeDetails(null);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loader"></div>
        <p>Loading graph data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-error">
        <h2>Connection Error</h2>
        <p>{error}</p>
        <p>Make sure the backend is running on port 3001</p>
      </div>
    );
  }

  return (
    <div className="main-layout">
      <div className="graph-container">
        {graphData && (
          <GraphView
            nodes={graphData.nodes}
            edges={graphData.edges}
            highlightedNodes={highlightedNodes}
            onNodeClick={handleNodeClick}
          />
        )}
        {selectedNode && (
          <NodeInspector
            node={nodeDetails?.node ?? selectedNode}
            connections={nodeDetails?.connections ?? []}
            onClose={handleCloseInspector}
          />
        )}
      </div>
      <div 
        className="chat-resizer" 
        onMouseDown={startResizing}
        title="Drag to resize"
      />
      <div style={{ width: `${chatWidth}px`, flexShrink: 0, height: '100%' }}>
        <ChatPanel
          messages={messages}
          isLoading={isLoading}
          onSend={sendMessage}
        />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <header className="app-header">
          <div className="header-left">
            <Link to="/" className="header-logo">⬡</Link>
            <nav className="header-nav">
              <Link to="/">Mapping</Link>
              <span className="header-sep">/</span>
              <span className="header-title">Order to Cash</span>
            </nav>
          </div>
          <div className="header-right">
            <Link to="/admin" className="admin-link">Dashboard</Link>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<MainView />} />
          <Route path="/admin" element={<AdminPanel />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
