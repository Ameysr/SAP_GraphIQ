import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import type { ChatMessage } from '../types/index';
import FormattedMessage from './FormattedMessage';

interface ChatPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onSend: (message: string) => void;
}

export default function ChatPanel({ messages, isLoading, onSend }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  function handleSubmit(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'; // Reset height
    }
    onSend(text);
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    const maxH = 120;
    if (e.target.scrollHeight > maxH) {
      e.target.style.height = `${maxH}px`;
      e.target.style.overflowY = 'auto';
    } else {
      e.target.style.height = `${e.target.scrollHeight}px`;
      e.target.style.overflowY = 'hidden';
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-icon">⬡</div>
        <div>
          <h2>Chat with Graph</h2>
          <span className="chat-subtitle">Order to Cash</span>
        </div>
      </div>

      <div className="chat-messages" id="chat-messages">
        <div className="chat-welcome">
          <div className="welcome-avatar">⬡</div>
          <div className="welcome-name">Dodge AI</div>
          <div className="welcome-role">Graph Agent</div>
          <p>Hi! I can help you analyze the <strong>Order to Cash</strong> process.</p>
        </div>

        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            {msg.role === 'assistant' && (
              <div className="message-avatar">⬡</div>
            )}
            <div className={`message-bubble ${msg.role} ${msg.confidence === 'low' ? 'low-confidence' : ''}`}>
              <div className="message-content">
                <FormattedMessage content={msg.content} />
              </div>
              {msg.role === 'assistant' && msg.metadata && (
                <div className="message-meta">
                  {msg.metadata.cacheHit ? '⚡ Cached' : `${msg.metadata.recordCount ?? 0} records`}
                  {' · '}Tier {msg.metadata.tier}
                  {msg.metadata.usedFallback && ' (Gemini fallback)'}
                  {' · '}{msg.metadata.latencyMs}ms
                  {msg.metadata.activePlanId && (
                    <>
                      {' · '}Plan {msg.metadata.activePlanId}
                    </>
                  )}
                  {msg.metadata.contractVerified !== undefined && msg.metadata.contractVerified !== null && (
                    <>
                      {' · '}Contract {msg.metadata.contractVerified ? 'OK' : 'FAIL'}
                    </>
                  )}
                </div>
              )}
              {msg.confidence === 'low' && (
                <div className="confidence-badge">⚠ Low confidence</div>
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="chat-message assistant">
            <div className="message-avatar">⬡</div>
            <div className="message-bubble assistant">
              <div className="typing-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input-form" onSubmit={handleSubmit}>
        <div className="chat-input-wrapper">
          <textarea
            id="chat-input"
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything about Order to Cash..."
            disabled={isLoading}
            autoComplete="off"
            rows={1}
          />
          <button type="submit" disabled={isLoading || !input.trim()} className="send-btn" aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
