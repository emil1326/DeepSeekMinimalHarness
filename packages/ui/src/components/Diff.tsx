function lineClass(line: string): string {
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('+++') ||
    line.startsWith('---')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

export function DiffView({ diff }: { diff: string }) {
  if (diff.trim() === '') return <pre className="diff">(no changes)</pre>;
  const lines = diff.split('\n');
  return (
    <pre className="diff">
      {lines.map((line, index) => (
        <span key={index} className={lineClass(line)}>
          {line === '' ? ' ' : line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
