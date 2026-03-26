import React from 'react';

interface FormattedMessageProps {
  content: string;
}

export default function FormattedMessage({ content }: FormattedMessageProps) {
  return <div className="formatted-message">{formatContent(content)}</div>;
}

let globalKey = 0;

function formatContent(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  let listType: 'ul' | 'ol' | null = null;

  function flushList() {
    if (listItems.length > 0 && listType) {
      const Tag = listType;
      elements.push(
        <Tag key={`list-${globalKey++}`}>
          {listItems}
        </Tag>
      );
      listItems = [];
      listType = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Bullet list item: - item or * item (but not ** which is bold)
    const bulletMatch = trimmed.match(/^[-]\s+(.+)/);
    if (bulletMatch) {
      if (listType !== 'ul') {
        flushList();
        listType = 'ul';
      }
      listItems.push(
        <li key={`li-${globalKey++}`}>{formatInline(bulletMatch[1])}</li>
      );
      continue;
    }

    // Numbered list item: 1. item
    const numMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numMatch) {
      if (listType !== 'ol') {
        flushList();
        listType = 'ol';
      }
      listItems.push(
        <li key={`li-${globalKey++}`}>{formatInline(numMatch[1])}</li>
      );
      continue;
    }

    // Not a list item — flush any open list
    flushList();

    if (trimmed === '') {
      elements.push(<div key={`sp-${globalKey++}`} className="formatted-spacer" />);
    } else {
      elements.push(
        <p key={`p-${globalKey++}`} className="formatted-paragraph">
          {formatInline(trimmed)}
        </p>
      );
    }
  }

  flushList();
  return elements;
}

/**
 * Parse inline formatting: **bold**, `code`, *italic*
 * Uses iterative string scanning instead of a single complex regex
 */
function formatInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let plainStart = 0;

  while (i < text.length) {
    // Check for **bold**
    if (text[i] === '*' && text[i + 1] === '*') {
      const closeIdx = text.indexOf('**', i + 2);
      if (closeIdx !== -1) {
        // Push any plain text before this
        if (i > plainStart) {
          parts.push(text.substring(plainStart, i));
        }
        const boldText = text.substring(i + 2, closeIdx);
        parts.push(<strong key={`b-${globalKey++}`}>{boldText}</strong>);
        i = closeIdx + 2;
        plainStart = i;
        continue;
      }
    }

    // Check for `code`
    if (text[i] === '`') {
      const closeIdx = text.indexOf('`', i + 1);
      if (closeIdx !== -1) {
        if (i > plainStart) {
          parts.push(text.substring(plainStart, i));
        }
        const codeText = text.substring(i + 1, closeIdx);
        parts.push(<code key={`c-${globalKey++}`} className="inline-code">{codeText}</code>);
        i = closeIdx + 1;
        plainStart = i;
        continue;
      }
    }

    // Check for *italic* (single *, not **)
    if (text[i] === '*' && text[i + 1] !== '*') {
      const closeIdx = text.indexOf('*', i + 1);
      if (closeIdx !== -1 && text[closeIdx + 1] !== '*') {
        if (i > plainStart) {
          parts.push(text.substring(plainStart, i));
        }
        const italicText = text.substring(i + 1, closeIdx);
        parts.push(<em key={`i-${globalKey++}`}>{italicText}</em>);
        i = closeIdx + 1;
        plainStart = i;
        continue;
      }
    }

    i++;
  }

  // Push remaining plain text
  if (plainStart < text.length) {
    parts.push(text.substring(plainStart));
  }

  if (parts.length === 0) return text;
  if (parts.length === 1) return parts[0];
  return parts;
}
