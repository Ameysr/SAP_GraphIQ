import { useState, useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage, ChatResponse } from '../types/index';

const API_URL = import.meta.env.VITE_API_URL ?? '';
const STORAGE_KEY = 'o2c_chat_history';
const MAX_MESSAGES = 100; // Keep up to 100 messages (50 Q&A pairs)

function getSessionId(): string {
  let id = localStorage.getItem('o2c_session_id');
  if (!id) {
    id = uuidv4();
    localStorage.setItem('o2c_session_id', id);
  }
  return id;
}

function loadMessages(): ChatMessage[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as ChatMessage[];
    }
  } catch {
    // Corrupted data — ignore
  }
  return [];
}

function saveMessages(messages: ChatMessage[]): void {
  try {
    // Keep only the last MAX_MESSAGES to avoid localStorage bloat
    const toSave = messages.slice(-MAX_MESSAGES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    // localStorage full — ignore
  }
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightedNodes, setHighlightedNodes] = useState<string[]>([]);
  const sessionId = getSessionId();

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  const sendMessage = useCallback(async (text: string) => {
    const userMsg: ChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
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

      setMessages((prev) => [...prev, aiMsg]);
      setHighlightedNodes(data.nodesReferenced ?? []);
    } catch (err: unknown) {
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again.',
        confidence: 'low',
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return { messages, isLoading, sendMessage, highlightedNodes, clearHistory };
}
