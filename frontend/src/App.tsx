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

/* ── Native Theme SAP Loading Card (graph area only) ── */
function GraphLoadingScreen({ stage, pingAttempt }: { stage: LoadingStage; pingAttempt: number }) {
  const estimatedProgress = stage === 'waking' 
    ? Math.min(pingAttempt * 5, 40)
    : stage === 'connecting' ? 75 
    : 95;

  return (
    <div className="graph-loading-screen">
      <div className="native-glass-loader">
         <div className="ngl-header">
           <span className="ngl-logo">⬡</span>
           <span className="ngl-title">Graph Intelligence System</span>
         </div>
         <div className="ngl-body">
           <div className="ngl-spinner"></div>
           <div className="ngl-text">
             <div className="ngl-status">
                {stage === 'waking' ? 'Waking Environment...' : stage === 'connecting' ? 'Fetching SAP Schema...' : 'Compiling Visualization...'}
             </div>
             <div className="ngl-detail">
                {stage === 'waking' && `Ping attempt ${pingAttempt} — Establishing connection to free tier cluster`}
                {stage === 'connecting' && `Connection established. Loading O2C nodes & relationships`}
                {stage === 'rendering' && `Schema retrieved. Constructing force-directed layout`}
             </div>
           </div>
         </div>
         <div className="ngl-footer">
            <div className="ngl-progress">
               <div className="ngl-progress-bar" style={{ width: `${estimatedProgress}%` }}></div>
            </div>
         </div>
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
