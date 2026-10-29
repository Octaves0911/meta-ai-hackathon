import type { ReactNode } from 'react';

// Small, safe Markdown renderer (headings, lists, quotes, code, bold, inline code, http(s) links). Never uses innerHTML.
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else { const [, label, url] = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!; out.push(<a key={k++} href={url} target="_blank" rel="noreferrer noopener">{label}</a>); }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownViewer({ source }: { source: string }) {
  const lines = source.split('\n');
  const nodes: ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) buf.push(lines[i]);
      i++;
      nodes.push(<pre key={key++}><code>{buf.join('\n')}</code></pre>);
    } else if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const Tag = (`h${level + 1}`) as 'h2' | 'h3' | 'h4';
      nodes.push(<Tag key={key++}>{inline(line.replace(/^#+\s/, ''))}</Tag>); i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) { items.push(<li key={i}>{inline(lines[i].replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>); i++; }
      nodes.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
    } else if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      nodes.push(<blockquote key={key++}>{inline(buf.join(' '))}</blockquote>);
    } else if (!line.trim()) { i++; }
    else {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
      nodes.push(<p key={key++}>{inline(buf.join(' '))}</p>);
    }
  }
  return <div className="md">{nodes}</div>;
}
