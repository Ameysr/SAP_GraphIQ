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

    // Bullet list item: - item or * item
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
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
      // Empty line → spacer
      elements.push(<div key={`sp-${globalKey++}`} className="formatted-spacer" />);
    } else {
      // Regular paragraph
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
 * Converts **bold**, *italic*, and `code` within a line to React elements.
 */
function formatInline(text: string): React.ReactNode {
  // Split into tokens: **bold**, `code`, *italic*, plain text
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Push text before the match
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    if (match[2]) {
      // **bold**
      parts.push(<strong key={`b-${globalKey++}`}>{match[2]}</strong>);
    } else if (match[3]) {
      // `code`
      parts.push(<code key={`c-${globalKey++}`} className="inline-code">{match[3]}</code>);
    } else if (match[4]) {
      // *italic*
      parts.push(<em key={`i-${globalKey++}`}>{match[4]}</em>);
    }

    lastIndex = regex.lastIndex;
  }

  // Push remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length === 1 ? parts[0] : parts;
}
