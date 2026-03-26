import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage, ChatResponse } from '../types/index';

const API_URL = import.meta.env.VITE_API_URL ?? '';

function getSessionId(): string {
  let id = localStorage.getItem('o2c_session_id');
  if (!id) {
    id = uuidv4();
    localStorage.setItem('o2c_session_id', id);
  }
  return id;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightedNodes, setHighlightedNodes] = useState<string[]>([]);
  const sessionId = getSessionId();

  const sendMessage = useCallback(async (text: string) => {
    const userMsg: ChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev.slice(-9), userMsg]);
    setIsLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as ChatResponse;

      const aiMsg: ChatMessage = {
        role: 'assistant',
        content: data.answer,
        metadata: data.metadata,
        confidence: data.confidence,
        nodesReferenced: data.nodesReferenced,
      };

      setMessages((prev) => [...prev.slice(-9), aiMsg]);
      setHighlightedNodes(data.nodesReferenced ?? []);
    } catch (err: unknown) {
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again.',
        confidence: 'low',
      };
      setMessages((prev) => [...prev.slice(-9), errorMsg]);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  return { messages, isLoading, sendMessage, highlightedNodes };
}
