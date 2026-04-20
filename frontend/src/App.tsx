import React, { useState, useCallback, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import GraphView from './components/GraphView';
import ChatPanel from './components/ChatPanel';
import NodeInspector from './components/NodeInspector';
import AdminPanel from './components/AdminPanel';
import { fetchNodeDetails, useGraph } from './hooks/useGraph';
import { useChat } from './hooks/useChat';
import type { GraphNode, GraphNodeDetails } from './types/index';
import type { LoadingStage } from './hooks/useGraph';
import { useKeepAlive } from './hooks/useKeepAlive';
import './index.css';

/* ── Animated Loading Screen (graph area only) ── */
function GraphLoadingScreen({ stage, pingAttempt }: { stage: LoadingStage; pingAttempt: number }) {
  const stages: { key: LoadingStage; label: string; icon: string }[] = [
    { key: 'waking', label: 'Waking up server', icon: '⚡' },
    { key: 'connecting', label: 'Loading graph data', icon: '◆' },
    { key: 'rendering', label: 'Building visualization', icon: '✦' },
  ];

  const currentIndex = stages.findIndex(s => s.key === stage);
  // Estimate: each ping attempt ≈ 3s, max ~60s total
  const estimatedProgress = stage === 'waking' 
    ? Math.min(pingAttempt * 5, 60)
    : stage === 'connecting' ? 70 
    : 90;

  return (
    <div className="graph-loading-screen">
      {/* Animated background orbs */}
      <div className="loading-orb loading-orb-1" />
      <div className="loading-orb loading-orb-2" />
      <div className="loading-orb loading-orb-3" />

      <div className="loading-content">
        {/* Animated hexagon logo */}
        <div className="loading-logo">
          <div className="hex-ring">
            <div className="hex-ring-inner" />
          </div>
        </div>

        {/* Stage indicators */}
        <div className="loading-stages">
          {stages.map((s, i) => {
            const isActive = i === currentIndex;
            const isDone = i < currentIndex;
            return (
              <div key={s.key} className={`loading-stage ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
                <div className="stage-icon">
                  {isDone ? '✓' : isActive ? s.icon : '○'}
                </div>
                <span className="stage-label">{s.label}</span>
                {isActive && <div className="stage-pulse" />}
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        <div className="loading-progress-track">
          <div className="loading-progress-fill" style={{ width: `${estimatedProgress}%` }} />
        </div>

        {/* Context message */}
        <p className="loading-hint">
          {stage === 'waking' && pingAttempt === 0 && 'Connecting to backend...'}
          {stage === 'waking' && pingAttempt > 0 && pingAttempt <= 3 && 'Free server is warming up — hang tight...'}
          {stage === 'waking' && pingAttempt > 3 && pingAttempt <= 8 && 'Cold start in progress — this is normal for free tier...'}
          {stage === 'waking' && pingAttempt > 8 && 'Almost there — initializing database connections...'}
          {stage === 'connecting' && 'Server is ready — fetching graph nodes & relationships...'}
          {stage === 'rendering' && 'Rendering force-directed graph...'}
        </p>
      </div>
    </div>
  );
}

function MainView() {
  const { graphData, loading, error, stage, pingAttempt } = useGraph();
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

  return (
    <div className="main-layout">
      <div className="graph-container">
        {/* Show loading screen OR graph — never both */}
        {loading ? (
          error ? (
            <div className="app-error">
              <h2>Connection Error</h2>
              <p>{error}</p>
              <p>Make sure the backend is running on port 3001</p>
              <button className="retry-btn" onClick={() => window.location.reload()}>
                Retry
              </button>
            </div>
          ) : (
            <GraphLoadingScreen stage={stage} pingAttempt={pingAttempt} />
          )
        ) : (
          <>
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
          </>
        )}
      </div>
      {/* Chat loads immediately — no waiting for graph */}
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
  // Ping backend every 4 min to prevent Render free-tier spin-down
  useKeepAlive();

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
